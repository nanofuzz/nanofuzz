import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { FileCoverageData } from "istanbul-lib-coverage";
import { OxcamlCompiler } from "../../compilers/oxcaml/OxcamlCompiler";
import { OxcamlCompilerError } from "../../compilers/Types";
import { OxcamlProgram } from "../../analysis/oxcaml/OxcamlProgram";
import { FuzzEnv } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import * as ProgramFactory from "../../analysis/ProgramFactory";

const HARNESS_TEMPLATE_VER = "OxcamlHarness-0.4.0";

/**
 * Builds and returns the compiled OCaml harness executable for testing a target function.
 *
 * @param targetFile Source file containing the target function
 * @param fnName Name of the function to test
 * @param env FuzzEnv containing function definitions and validators
 * @param tmpDir Base temporary directory for compilation outputs
 * @returns Path to the compiled harness executable, directory, and Istanbul static coverage
 */
export function buildOxcamlHarness(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  tmpDir?: string
): {
  binaryPath: string;
  harnessDir: string;
  staticCov: FileCoverageData;
  staticCovMap: Record<string, FileCoverageData>;
} {
  const normTarget = fs.existsSync(targetFile)
    ? fs.realpathSync(path.resolve(targetFile))
    : path.resolve(targetFile);
  if (!fs.existsSync(normTarget)) {
    throw new Error(`Target file does not exist: ${normTarget}`);
  }

  const baseTmp =
    tmpDir ?? path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "oxcaml");
  fs.mkdirSync(baseTmp, { recursive: true });

  const targetSrc = fs.readFileSync(normTarget, "utf8");
  const targetCov = instrumentOxcamlSource(targetSrc, normTarget, 0);

  const staticCovMap: Record<string, FileCoverageData> = {
    [normTarget.replace(/\\/g, "/")]: targetCov.staticCov,
  };
  const manifestEntries: CoverageManifestEntry[] = [
    {
      fileId: 0,
      filePath: normTarget,
      branchArms: targetCov.branchArms,
    },
  ];

  const validators = env?.validators.map((v) => v.name) ?? [];
  const cacheKey = crypto
    .createHash("sha256")
    .update(
      `${normTarget}:${fnName}:${validators.sort().join(",")}:${HARNESS_TEMPLATE_VER}:${targetSrc}`
    )
    .digest("hex");

  const harnessDir = path.join(baseTmp, `harness-${cacheKey.slice(0, 16)}`);
  const binaryPath = path.join(harnessDir, "_build", "default", "harness.exe");

  const maxMtime = fs.statSync(normTarget).mtimeMs;

  // Return cached binary if up-to-date
  if (
    fs.existsSync(binaryPath) &&
    fs.statSync(binaryPath).mtimeMs >= maxMtime
  ) {
    return {
      binaryPath,
      harnessDir,
      staticCov: targetCov.staticCov,
      staticCovMap,
    };
  }

  fs.mkdirSync(harnessDir, { recursive: true });

  // Copy runtime package into harness workspace
  const runtimeSrcDir = findRuntimePackage();
  if (!runtimeSrcDir) {
    throw new Error(
      "Could not find nanofuzz_runtime package directory for OCaml"
    );
  }
  const destRuntimeDir = path.join(harnessDir, "nanofuzz_runtime");
  fs.mkdirSync(destRuntimeDir, { recursive: true });
  fs.cpSync(runtimeSrcDir, destRuntimeDir, {
    recursive: true,
    filter: (srcPath) => !srcPath.includes(`${path.sep}_build`),
  });

  // Write dune-project
  const duneProjectContent = `(lang dune 2.9)
(name nanofuzz_harness_project)
`;
  fs.writeFileSync(
    path.join(harnessDir, "dune-project"),
    duneProjectContent,
    "utf8"
  );

  // Extract user libraries from ancestor dune if available
  const userDune = findInAncestor(path.dirname(normTarget), "dune");
  const userLibs = userDune ? extractDuneLibraries(userDune) : [];
  const allLibs = Array.from(
    new Set(["yojson", "nanofuzz_runtime", ...userLibs])
  );

  // Write dune
  const duneContent = `(executable
 (name harness)
 (flags (:standard -w -33-26-27-32-34-37-39))
 (libraries ${allLibs.join(" ")}))
`;
  fs.writeFileSync(path.join(harnessDir, "dune"), duneContent, "utf8");

  // Write target_module.ml (with shim if needed)
  const isExported = env?.function?.isExported() ?? true;
  let finalTargetSrc = targetCov.instrumentedSrc;
  if (!isExported) {
    finalTargetSrc += `\n\nlet __nanofuzz_get__ = ${fnName}\n`;
  }
  fs.writeFileSync(
    path.join(harnessDir, "target_module.ml"),
    finalTargetSrc,
    "utf8"
  );

  // Generate and write harness.ml
  const harnessSrc = generateHarnessSource(
    normTarget,
    fnName,
    env,
    staticCovMap,
    manifestEntries
  );
  fs.writeFileSync(path.join(harnessDir, "harness.ml"), harnessSrc, "utf8");

  // Compile harness executable using Dune
  const duneBin = OxcamlCompiler.resolveDune();
  if (!duneBin) {
    throw new OxcamlCompilerError(
      "Dune executable not found. Please ensure dune is installed in your opam switch or on PATH.",
      {
        inputFile: normTarget,
        commandCli: "dune build ./harness.exe",
        output: ["Dune executable not found."],
      }
    );
  }

  const duneDir = path.dirname(duneBin);
  const pathKey =
    Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";

  const buildRes = ChildProcess.spawnSync(duneBin, ["build", "./harness.exe"], {
    cwd: harnessDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      [pathKey]: `${duneDir}${path.delimiter}${process.env[pathKey] || ""}`,
    },
  });

  if (buildRes.status !== 0 || !fs.existsSync(binaryPath)) {
    throw new OxcamlCompilerError(
      "Failed to build OCaml fuzzing harness executable",
      {
        inputFile: normTarget,
        commandCli: `${duneBin} build ./harness.exe`,
        output: [
          buildRes.stderr ||
            buildRes.stdout ||
            "Dune build failed for test harness",
        ],
      }
    );
  }

  return {
    binaryPath,
    harnessDir,
    staticCov: targetCov.staticCov,
    staticCovMap,
  };
} // fn: buildOxcamlHarness

/**
 * Instruments an OCaml source string with coverage tracking probes.
 *
 * @param src OCaml source code
 * @param targetFile Path to target source file
 * @param fileId Numeric identifier for the file in coverage manifest
 * @returns Object containing instrumented source, static coverage, and branch arms
 */
export function instrumentOxcamlSource(
  src: string,
  targetFile: string = "",
  fileId: number = 0
): {
  instrumentedSrc: string;
  staticCov: FileCoverageData;
  branchArms: Array<[number, number]>;
} {
  const tree = Parser.parse("oxcaml", src);
  if (!tree) {
    throw new Error("Parser failed to parse OCaml source for instrumentation");
  }

  const statementMap: FileCoverageData["statementMap"] = {};
  const fnMap: FileCoverageData["fnMap"] = {};
  const branchMap: FileCoverageData["branchMap"] = {};
  const s: FileCoverageData["s"] = {};
  const f: FileCoverageData["f"] = {};
  const b: FileCoverageData["b"] = {};
  const branchArms: Array<[number, number]> = [];
  const insertions: Array<{ pos: number; text: string }> = [];

  let sIdx = 0;
  let fIdx = 0;
  let bIdx = 0;

  // Query functions (top-level let bindings)
  const fnQuery = Parser.query(
    "oxcaml",
    `
(value_definition
  (let_binding
    pattern: (value_name) @fn.name
    body: (_) @fn.body) @fn.binding)
`
  );
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const m of fnMatches) {
    const nameNode = m.captures.find((c) => c.name === "fn.name")?.node;
    const bodyNode = m.captures.find((c) => c.name === "fn.body")?.node;
    const bindingNode = m.captures.find((c) => c.name === "fn.binding")?.node;
    if (!nameNode || !bodyNode || !bindingNode) continue;

    const currentFIdx = String(fIdx++);
    fnMap[currentFIdx] = {
      name: nameNode.text,
      decl: {
        start: {
          line: bindingNode.startPosition.row + 1,
          column: bindingNode.startPosition.column,
        },
        end: {
          line: nameNode.endPosition.row + 1,
          column: nameNode.endPosition.column,
        },
      },
      loc: {
        start: {
          line: bodyNode.startPosition.row + 1,
          column: bodyNode.startPosition.column,
        },
        end: {
          line: bodyNode.endPosition.row + 1,
          column: bodyNode.endPosition.column,
        },
      },
      line: bindingNode.startPosition.row + 1,
    };
    f[currentFIdx] = 0;

    const currentSIdx = String(sIdx++);
    statementMap[currentSIdx] = {
      start: {
        line: bindingNode.startPosition.row + 1,
        column: bindingNode.startPosition.column,
      },
      end: {
        line: bodyNode.endPosition.row + 1,
        column: bodyNode.endPosition.column,
      },
    };
    s[currentSIdx] = 0;

    insertions.push({
      pos: bodyNode.startIndex,
      text: `(Nanofuzz_runtime.Coverage.hit_fn ${fileId} ${currentFIdx}; Nanofuzz_runtime.Coverage.hit_stmt ${fileId} ${currentSIdx}; `,
    });
    insertions.push({
      pos: bodyNode.endIndex,
      text: `)`,
    });
  }

  // Query if-expressions for branch coverage
  const ifQuery = Parser.query(
    "oxcaml",
    `
(if_expression) @if.expr
`
  );
  const ifMatches = ifQuery.matches(tree.rootNode);

  for (const m of ifMatches) {
    const exprNode = m.captures.find((c) => c.name === "if.expr")?.node;
    if (!exprNode) continue;

    const thenClause = exprNode.children.find((c) => c.type === "then_clause");
    const elseClause = exprNode.children.find((c) => c.type === "else_clause");
    const thenNode = thenClause?.namedChildren[0];
    const elseNode = elseClause?.namedChildren[0];
    if (!thenNode) continue;

    const currentBIdx = String(bIdx++);
    branchArms.push([Number(currentBIdx), 2]);

    branchMap[currentBIdx] = {
      loc: {
        start: {
          line: exprNode.startPosition.row + 1,
          column: exprNode.startPosition.column,
        },
        end: {
          line: exprNode.endPosition.row + 1,
          column: exprNode.endPosition.column,
        },
      },
      type: "if",
      locations: [
        {
          start: {
            line: thenNode.startPosition.row + 1,
            column: thenNode.startPosition.column,
          },
          end: {
            line: thenNode.endPosition.row + 1,
            column: thenNode.endPosition.column,
          },
        },
        elseNode
          ? {
              start: {
                line: elseNode.startPosition.row + 1,
                column: elseNode.startPosition.column,
              },
              end: {
                line: elseNode.endPosition.row + 1,
                column: elseNode.endPosition.column,
              },
            }
          : {
              start: {
                line: thenNode.endPosition.row + 1,
                column: thenNode.endPosition.column,
              },
              end: {
                line: thenNode.endPosition.row + 1,
                column: thenNode.endPosition.column,
              },
            },
      ],
      line: exprNode.startPosition.row + 1,
    };
    b[currentBIdx] = [0, 0];

    insertions.push({
      pos: thenNode.startIndex,
      text: `(Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} 0; `,
    });
    insertions.push({
      pos: thenNode.endIndex,
      text: `)`,
    });

    if (elseNode) {
      insertions.push({
        pos: elseNode.startIndex,
        text: `(Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} 1; `,
      });
      insertions.push({
        pos: elseNode.endIndex,
        text: `)`,
      });
    } else {
      insertions.push({
        pos: exprNode.endIndex,
        text: ` else (Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} 1; ())`,
      });
    }
  }

  // Sort insertions from end to start to preserve character offsets
  insertions.sort((a, bPos) => bPos.pos - a.pos);

  let instrumentedSrc = src;
  for (const ins of insertions) {
    instrumentedSrc =
      instrumentedSrc.slice(0, ins.pos) +
      ins.text +
      instrumentedSrc.slice(ins.pos);
  }

  const staticCov: FileCoverageData = {
    path: targetFile,
    statementMap,
    fnMap,
    branchMap,
    s,
    f,
    b,
  };

  return {
    instrumentedSrc,
    staticCov,
    branchArms,
  };
} // fn: instrumentOxcamlSource

/**
 * Generates the full OCaml source code for the runner host harness.
 */
function generateHarnessSource(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  staticCovMap?: Record<string, FileCoverageData>,
  manifestEntries?: CoverageManifestEntry[]
): string {
  const prog = ProgramFactory.fromFile(targetFile, "oxcaml");
  const targetFnDef =
    env?.function?.getName() === fnName
      ? env.function
      : (prog.functions[fnName] ?? env?.function);
  const argDefs = targetFnDef ? targetFnDef.getArgDefs() : [];
  const isVoid = targetFnDef ? targetFnDef.isVoid() : false;
  const isExported = targetFnDef ? targetFnDef.isExported() : true;
  const targetFnAccessor = isExported
    ? `Target_module.${fnName}`
    : `Target_module.__nanofuzz_get__`;

  // Argument conversions
  const argConversions: string[] = [];
  const callArgs: string[] = [];
  const callArgsPat: string[] = [];

  for (let i = 0; i < argDefs.length; i++) {
    const arg = argDefs[i];
    const typeAnnot = OxcamlProgram.getTypeAnnotation(arg);
    const deserExpr = buildDeserializer(typeAnnot, i);

    argConversions.push(`let arg_${i} = ${deserExpr} in`);
    callArgs.push(`arg_${i}`);
    callArgsPat.push(`arg_${i}`);
  }

  const callArgsStr = callArgs.length > 0 ? callArgs.join(", ") : "()";
  const callArgsPatStr = callArgsPat.length > 0 ? callArgsPat.join(", ") : "()";

  // Target function call and output serialization
  let fnCallCode: string;
  if (isVoid || argDefs.length === 0) {
    const callInvocation =
      argDefs.length === 0
        ? `${targetFnAccessor} ()`
        : `${targetFnAccessor} ${callArgs.join(" ")}`;
    if (isVoid) {
      fnCallCode = `let () = ${callInvocation} in let out_json = \`Null in Ok (out_json)`;
    } else {
      const retArg = targetFnDef?.getReturnArg();
      const retType = retArg ? OxcamlProgram.getTypeAnnotation(retArg) : "int";
      const serExpr = buildSerializer(retType, "out_val");
      fnCallCode = `let out_val = ${callInvocation} in let out_json = ${serExpr} in Ok (out_json)`;
    }
  } else {
    const retArg = targetFnDef?.getReturnArg();
    const retType = retArg ? OxcamlProgram.getTypeAnnotation(retArg) : "int";
    const serExpr = buildSerializer(retType, "out_val");
    fnCallCode = `let out_val = ${targetFnAccessor} ${callArgs.join(" ")} in let out_json = ${serExpr} in Ok (out_json)`;
  }

  // Validators execution
  const validators = env?.validators ?? [];
  const validatorLines: string[] = [];
  for (const v of validators) {
    validatorLines.push(
      `if List.mem "${v.name}" validators then begin
        let ftr = Nanofuzz_runtime.make_fuzz_test_result ~inputs:args ~out:out_json ~exception_:false ~timeout:false in
        let vr =
          try
            let res = Target_module.${v.name} ftr in
            let res_str = Nanofuzz_runtime.validator_result_to_string res in
            \`Assoc [("tag", \`String "value"); ("value", \`String res_str)]
          with
          | Unsatisfied_assumption msg ->
            \`Assoc [("tag", \`String "skip"); ("message", \`String msg)]
          | exn ->
            \`Assoc [("tag", \`String "error"); ("message", \`String (Printexc.to_string exn))]
        in
        val_results := ("${v.name}", vr) :: !val_results
      end;`
    );
  }

  // Coverage manifest entries
  const manifestLines = (manifestEntries ?? []).map((e) => {
    const armStrs = e.branchArms.map(([bid, c]) => `(${bid}, ${c})`);
    return `  (${e.fileId}, "${e.filePath.replace(/\\/g, "/")}", [${armStrs.join("; ")}]);`;
  });

  const staticCovJson = JSON.stringify(staticCovMap ?? {});

  const template = getTemplate();

  return template
    .replace("/* __NANOFUZZ_COVERAGE_MANIFEST__ */", manifestLines.join("\n"))
    .replace("/* __NANOFUZZ_STATIC_COV_JSON__ */", staticCovJson)
    .replace(
      "/* __NANOFUZZ_ARG_CONVERSIONS__ */",
      argConversions.join("\n            ")
    )
    .replace("/* __NANOFUZZ_CALL_ARGS__ */", callArgsStr)
    .replace("/* __NANOFUZZ_CALL_ARGS_PAT__ */", callArgsPatStr)
    .replace("/* __NANOFUZZ_FN_CALL__ */", fnCallCode)
    .replace(
      "/* __NANOFUZZ_VALIDATORS__ */",
      validatorLines.join("\n              ")
    );
} // fn: generateHarnessSource

/**
 * Builds an OCaml expression that deserializes argument at index `idx` according to type `typeAnnot`.
 */
function buildDeserializer(typeAnnot: string, idx: number): string {
  const cleanType = typeAnnot.trim();

  if (cleanType === "int" || cleanType === "#int") {
    return `(match List.nth_opt args ${idx} with Some (\`Int n) -> n | Some (\`Intlit s) -> int_of_string s | _ -> failwith "arg ${idx}: expected int")`;
  }
  if (cleanType === "int32") {
    return `(match List.nth_opt args ${idx} with Some (\`Int n) -> Int32.of_int n | Some (\`Intlit s) -> Int32.of_string s | _ -> failwith "arg ${idx}: expected int32")`;
  }
  if (cleanType === "int64") {
    return `(match List.nth_opt args ${idx} with Some (\`Intlit s) -> Int64.of_string s | Some (\`Int n) -> Int64.of_int n | _ -> failwith "arg ${idx}: expected int64")`;
  }
  if (cleanType === "nativeint") {
    return `(match List.nth_opt args ${idx} with Some (\`Int n) -> Nativeint.of_int n | Some (\`Intlit s) -> Nativeint.of_string s | _ -> failwith "arg ${idx}: expected nativeint")`;
  }
  if (cleanType === "float" || cleanType === "#float") {
    return `(match List.nth_opt args ${idx} with Some (\`Float f) -> f | Some (\`Int n) -> float_of_int n | _ -> failwith "arg ${idx}: expected float")`;
  }
  if (cleanType === "bool") {
    return `(match List.nth_opt args ${idx} with Some (\`Bool b) -> b | _ -> failwith "arg ${idx}: expected bool")`;
  }
  if (cleanType === "string") {
    return `(match List.nth_opt args ${idx} with Some (\`String s) -> s | _ -> failwith "arg ${idx}: expected string")`;
  }
  if (cleanType === "char") {
    return `(match List.nth_opt args ${idx} with Some (\`String s) when String.length s > 0 -> s.[0] | _ -> failwith "arg ${idx}: expected char")`;
  }
  if (cleanType === "bytes") {
    return `(match List.nth_opt args ${idx} with Some (\`String s) -> Bytes.of_string s | _ -> failwith "arg ${idx}: expected bytes")`;
  }
  if (cleanType.endsWith(" option")) {
    const elemType = cleanType.slice(0, -7).trim();
    return `(match List.nth_opt args ${idx} with None | Some \`Null -> None | Some v -> Some ${buildSingleValDeserializer(elemType, "v")})`;
  }
  if (cleanType.endsWith(" list")) {
    const elemType = cleanType.slice(0, -5).trim();
    return `(match List.nth_opt args ${idx} with Some (\`List l) -> List.map (fun v -> ${buildSingleValDeserializer(elemType, "v")}) l | _ -> failwith "arg ${idx}: expected list")`;
  }
  if (cleanType.endsWith(" array")) {
    const elemType = cleanType.slice(0, -6).trim();
    return `(match List.nth_opt args ${idx} with Some (\`List l) -> Array.of_list (List.map (fun v -> ${buildSingleValDeserializer(elemType, "v")}) l) | _ -> failwith "arg ${idx}: expected array")`;
  }

  // Fallback for int
  return `(match List.nth_opt args ${idx} with Some (\`Int n) -> n | _ -> 0)`;
} // fn: buildDeserializer

/**
 * Builds an OCaml expression deserializing a single Yojson value.
 */
function buildSingleValDeserializer(typeAnnot: string, valVar: string): string {
  const cleanType = typeAnnot.trim();
  if (cleanType === "int")
    return `(match ${valVar} with \`Int n -> n | _ -> 0)`;
  if (cleanType === "float")
    return `(match ${valVar} with \`Float f -> f | \`Int n -> float_of_int n | _ -> 0.0)`;
  if (cleanType === "string")
    return `(match ${valVar} with \`String s -> s | _ -> "")`;
  if (cleanType === "bool")
    return `(match ${valVar} with \`Bool b -> b | _ -> false)`;
  return `(match ${valVar} with \`Int n -> n | _ -> 0)`;
} // fn: buildSingleValDeserializer

/**
 * Builds an OCaml expression converting a return value `valVar` into a Yojson.Safe.t.
 */
function buildSerializer(typeAnnot: string, valVar: string): string {
  const cleanType = typeAnnot.trim();
  if (cleanType === "unit") return `\`Null`;
  if (
    cleanType === "int" ||
    cleanType === "#int" ||
    cleanType === "int32" ||
    cleanType === "nativeint"
  ) {
    return `\`Int ${valVar}`;
  }
  if (cleanType === "int64") {
    return `\`Intlit (Int64.to_string ${valVar})`;
  }
  if (cleanType === "float" || cleanType === "#float") {
    return `\`Float ${valVar}`;
  }
  if (cleanType === "bool") {
    return `\`Bool ${valVar}`;
  }
  if (cleanType === "string") {
    return `\`String ${valVar}`;
  }
  if (cleanType === "char") {
    return `\`String (String.make 1 ${valVar})`;
  }
  if (cleanType === "bytes") {
    return `\`String (Bytes.to_string ${valVar})`;
  }
  if (cleanType.endsWith(" list")) {
    const elemType = cleanType.slice(0, -5).trim();
    return `\`List (List.map (fun v -> ${buildSerializer(elemType, "v")}) ${valVar})`;
  }
  if (cleanType.endsWith(" array")) {
    const elemType = cleanType.slice(0, -6).trim();
    return `\`List (Array.to_list (Array.map (fun v -> ${buildSerializer(elemType, "v")}) ${valVar}))`;
  }
  if (cleanType.endsWith(" option")) {
    const elemType = cleanType.slice(0, -7).trim();
    return `(match ${valVar} with None -> \`Null | Some v -> ${buildSerializer(elemType, "v")})`;
  }
  return `\`Null`;
} // fn: buildSerializer

/**
 * Loads the runner host template from file or returns the embedded fallback.
 */
function getTemplate(): string {
  const templatePath = path.resolve(
    path.join(__dirname, "OxcamlRunnerHost.template.ml")
  );
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf8");
  }
  const buildExtPath = path.resolve(
    "./build/extension/OxcamlRunnerHost.template.ml"
  );
  if (fs.existsSync(buildExtPath)) {
    return fs.readFileSync(buildExtPath, "utf8");
  }
  throw new Error("Could not find OxcamlRunnerHost.template.ml template file");
} // fn: getTemplate

/**
 * Extracts declared library names from an ancestor `dune` file.
 */
function extractDuneLibraries(dunePath: string): string[] {
  const libs: string[] = [];
  try {
    const content = fs.readFileSync(dunePath, "utf8");
    const libMatch = /\(libraries\s+([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = libMatch.exec(content)) !== null) {
      const items = match[1].split(/\s+/).filter((s) => s.length > 0);
      for (const item of items) {
        if (!item.startsWith(":") && !libs.includes(item)) {
          libs.push(item);
        }
      }
    }
  } catch {
    // ignore
  }
  return libs;
} // fn: extractDuneLibraries

/**
 * Searches for the local nanofuzz_runtime package directory.
 */
function findRuntimePackage(): string | undefined {
  const candidates = [
    path.resolve("./packages/runtime/oxcaml"),
    path.resolve("./build/extension/nanofuzz_runtime_oxcaml"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "dune-project"))) {
      return c;
    }
  }
  return undefined;
} // fn: findRuntimePackage

export type CoverageManifestEntry = {
  fileId: number;
  filePath: string;
  branchArms: Array<[number, number]>;
};
