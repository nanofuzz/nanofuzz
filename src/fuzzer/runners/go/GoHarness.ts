import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { FileCoverageData } from "istanbul-lib-coverage";
import { GoCompiler } from "../../compilers/go/GoCompiler";
import { GoCompilerError } from "../../compilers/Types";
import { GoProgram } from "../../analysis/go/GoProgram";
import { FuzzEnv } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { ArgTag } from "../../analysis/Types";
import { FunctionDef } from "../../analysis/FunctionDef";

/**
 * Builds and returns the compiled Go harness binary for testing a target function.
 *
 * @param targetFile Source file containing the target function
 * @param fnName Name of the function to test
 * @param env FuzzEnv containing function definitions and validators
 * @param tmpDir Base temporary directory for compilation outputs
 * @returns Path to the compiled harness executable, directory, and Istanbul static coverage
 */
export function buildGoHarness(
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
    tmpDir ?? path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "go");
  fs.mkdirSync(baseTmp, { recursive: true });

  const hash = crypto
    .createHash("sha256")
    .update(`${normTarget}:${fnName}`)
    .digest("hex")
    .slice(0, 16);
  const harnessDir = path.join(baseTmp, `harness-${hash}`);
  fs.mkdirSync(harnessDir, { recursive: true });

  const binaryName = process.platform === "win32" ? "harness.exe" : "harness";
  const binaryPath = path.join(harnessDir, binaryName);

  const targetSrc = fs.readFileSync(normTarget, "utf8");
  const targetExtraction = extractGoStaticCoverage(targetSrc, normTarget, 0);

  const staticCovMap: Record<string, FileCoverageData> = {
    [normTarget]: targetExtraction.staticCov,
  };

  const manifestEntries: CoverageManifestEntry[] = [
    {
      fileId: 0,
      filePath: normTarget,
      branchArms: targetExtraction.branchSpecs,
    },
  ];

  // Discover and instrument sibling local .go files in same directory
  const siblingFiles = GoProgram.findLocalSourceFiles(normTarget);
  let nextFileId = 1;
  const instrumentedSiblings: Array<{ destPath: string; src: string }> = [];

  for (const sib of siblingFiles) {
    try {
      const sibSrc = fs.readFileSync(sib, "utf8");
      const fid = nextFileId++;
      const sibExtraction = extractGoStaticCoverage(sibSrc, sib, fid);
      staticCovMap[sib] = sibExtraction.staticCov;
      manifestEntries.push({
        fileId: fid,
        filePath: sib,
        branchArms: sibExtraction.branchSpecs,
      });
      instrumentedSiblings.push({
        destPath: path.join(harnessDir, path.basename(sib)),
        src: rewritePackageToMain(sibExtraction.instrumentedSrc),
      });
    } catch {
      // ignore
    }
  }

  // Write instrumented target file
  const instTargetFile = path.join(harnessDir, "target_inst.go");
  fs.writeFileSync(
    instTargetFile,
    rewritePackageToMain(targetExtraction.instrumentedSrc),
    "utf8"
  );

  // Write instrumented sibling files
  for (const sib of instrumentedSiblings) {
    fs.writeFileSync(sib.destPath, sib.src, "utf8");
  }

  // Generate harness source code
  const pgm = ProgramFactory.fromSource(
    () => targetSrc,
    "go",
    normTarget
  );
  const fnDef = pgm.functions[fnName];

  const harnessSource = generateGoHarnessSource(
    fnName,
    fnDef,
    env,
    manifestEntries,
    staticCovMap
  );
  const harnessFilePath = path.join(harnessDir, "harness.go");
  fs.writeFileSync(harnessFilePath, harnessSource, "utf8");

  // Setup go.mod in harness directory
  setupHarnessGoMod(harnessDir, normTarget);

  // Compile the harness
  const goPath = GoCompiler.resolveGo();
  if (!goPath) {
    throw new Error(
      "No Go compiler found. Please ensure 'go' is installed and available on PATH."
    );
  }

  const buildArgs = ["build", "-o", binaryName, "."];
  const buildRes = ChildProcess.spawnSync(goPath, buildArgs, {
    cwd: harnessDir,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (buildRes.status !== 0) {
    const stderr = buildRes.stderr || buildRes.stdout || "go build failed";
    throw new GoCompilerError(
      `Go harness build failed:\n${stderr}`,
      {
        inputFile: harnessFilePath,
        output: stderr.split("\n"),
        commandCli: `${goPath} ${buildArgs.join(" ")}`,
      }
    );
  }

  return {
    binaryPath,
    harnessDir,
    staticCov: targetExtraction.staticCov,
    staticCovMap,
  };
} // fn: buildGoHarness

function rewritePackageToMain(src: string): string {
  // Replace package declaration with package main
  let res = src.replace(/\bpackage\s+[a-zA-Z0-9_]+/g, "package main");
  // If source contains func main(), rename it to avoid conflicting with harness main()
  res = res.replace(/\bfunc\s+main\s*\(/g, "func __nanofuzz_orig_main(");
  return res;
} // fn: rewritePackageToMain

function setupHarnessGoMod(harnessDir: string, targetFile: string): void {
  const runtimeDir = resolveGoRuntimeDir();
  const userGoMod = GoProgram.findGoMod(targetFile);

  let userModDeps = "";
  if (userGoMod && fs.existsSync(userGoMod)) {
    try {
      const userContent = fs.readFileSync(userGoMod, "utf8");
      // Extract require and replace blocks
      const requireMatches = userContent.match(/require\s*\([^)]*\)|require\s+[^\n]+/g);
      const replaceMatches = userContent.match(/replace\s*\([^)]*\)|replace\s+[^\n]+/g);
      if (requireMatches) userModDeps += "\n" + requireMatches.join("\n");
      if (replaceMatches) userModDeps += "\n" + replaceMatches.join("\n");
    } catch {
      // ignore
    }
  }

  const modContent = `module nanofuzz_harness

go 1.22

require github.com/nanofuzz/runtime v0.0.0
replace github.com/nanofuzz/runtime => ${runtimeDir.replace(/\\/g, "/")}
${userModDeps}
`;

  fs.writeFileSync(path.join(harnessDir, "go.mod"), modContent, "utf8");
} // fn: setupHarnessGoMod

function resolveGoRuntimeDir(): string {
  const built = path.resolve("./build/extension/nanofuzz-runtime-go");
  if (fs.existsSync(built) && fs.existsSync(path.join(built, "go.mod"))) {
    return built;
  }
  const source = path.resolve("./packages/runtime/go");
  if (fs.existsSync(source) && fs.existsSync(path.join(source, "go.mod"))) {
    return source;
  }
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const root = findInAncestor(currModuleDir, "package.json");
  if (root) {
    const candidate = path.join(path.dirname(root), "packages", "runtime", "go");
    if (fs.existsSync(candidate)) return candidate;
    const builtCand = path.join(path.dirname(root), "build", "extension", "nanofuzz-runtime-go");
    if (fs.existsSync(builtCand)) return builtCand;
  }
  return path.resolve("./packages/runtime/go");
} // fn: resolveGoRuntimeDir

function getHarnessTemplate(): string {
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const candidates: string[] = [
    path.join(__dirname, "GoRunnerHost.template.go"),
    path.resolve(currModuleDir, "GoRunnerHost.template.go"),
  ];

  const projectRoot = findInAncestor(currModuleDir, "package.json");
  if (projectRoot) {
    const rootDir = path.dirname(projectRoot);
    candidates.push(
      path.join(
        rootDir,
        "src",
        "fuzzer",
        "runners",
        "go",
        "GoRunnerHost.template.go"
      ),
      path.join(rootDir, "build", "extension", "GoRunnerHost.template.go")
    );
  }

  candidates.push(
    path.resolve("./src/fuzzer/runners/go/GoRunnerHost.template.go"),
    path.resolve("./build/extension/GoRunnerHost.template.go")
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }

  throw new Error("Could not find GoRunnerHost.template.go template file");
} // fn: getHarnessTemplate

function generateGoHarnessSource(
  fnName: string,
  fnDef: FunctionDef | undefined,
  env: FuzzEnv | undefined,
  manifestEntries: CoverageManifestEntry[],
  staticCovMap: Record<string, FileCoverageData>
): string {
  const template = getHarnessTemplate();
  const argDefs = fnDef ? fnDef.getArgDefs() : [];
  const argConversions: string[] = [];
  const callArgs: string[] = [];

  for (let i = 0; i < argDefs.length; i++) {
    const arg = argDefs[i];
    const typeAnnot = GoProgram.getTypeAnnotation(arg);
    argConversions.push(
      `\t\tvar arg_${i} ${typeAnnot}\n\t\tif len(input.Args) > ${i} && input.Args[${i}] != nil {\n\t\t\trawBytes, _ := json.Marshal(input.Args[${i}])\n\t\t\t_ = json.Unmarshal(rawBytes, &arg_${i})\n\t\t}`
    );
    callArgs.push(`arg_${i}`);
  }

  const isVoid = fnDef?.isVoid() ?? false;
  const returnArg = fnDef?.getReturnArg();
  const isTuple = returnArg?.getType() === ArgTag.TUPLE;

  let fnCallCode = "";
  if (isVoid) {
    fnCallCode = `\t\t\t${fnName}(${callArgs.join(", ")})\n\t\t\toutVal = nil`;
  } else if (isTuple) {
    const childrenCount = returnArg?.getChildren().length ?? 2;
    const retVars = Array.from({ length: childrenCount }, (_, idx) => `r${idx}`);
    fnCallCode = `\t\t\t${retVars.join(", ")} := ${fnName}(${callArgs.join(", ")})\n\t\t\toutVal = []any{${retVars.join(", ")}}`;
  } else {
    fnCallCode = `\t\t\toutVal = ${fnName}(${callArgs.join(", ")})`;
  }

  // Validators
  const validators = env?.validators ?? [];
  const validatorBlocks: string[] = [];

  for (const v of validators) {
    validatorBlocks.push(`
\t\tif containsValidator(input.Validators, "${v.name}") {
\t\t\tftr := runtime.FuzzTestResult{
\t\t\t\tIn: input.Args,
\t\t\t\tOut: outVal,
\t\t\t\tException: false,
\t\t\t\tTimeout: false,
\t\t\t}
\t\t\tfunc() {
\t\t\t\tdefer func() {
\t\t\t\t\tif r := recover(); r != nil {
\t\t\t\t\t\tif u, ok := r.(runtime.UnsatisfiedAssumptionError); ok {
\t\t\t\t\t\t\tif validatorsRes == nil { validatorsRes = make(map[string]ValidatorResult) }
\t\t\t\t\t\t\tvalidatorsRes["${v.name}"] = ValidatorResult{Tag: "skip", Message: u.Message}
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tif validatorsRes == nil { validatorsRes = make(map[string]ValidatorResult) }
\t\t\t\t\t\t\tvalidatorsRes["${v.name}"] = ValidatorResult{Tag: "error", Message: fmt.Sprint(r)}
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}()
\t\t\t\tvRes := ${v.name}(ftr)
\t\t\t\tif validatorsRes == nil { validatorsRes = make(map[string]ValidatorResult) }
\t\t\t\tvalidatorsRes["${v.name}"] = ValidatorResult{Tag: "value", Value: vRes}
\t\t\t}()
\t\t}`);
  }

  const manifestGo = manifestEntries
    .map(
      (m) =>
        `\t{\n\t\tFileID: ${m.fileId},\n\t\tFilePath: "${m.filePath.replace(/\\/g, "/")}",\n\t\tBranchArms: []coverage.BranchArmSpec{\n${m.branchArms.map((b) => `\t\t\t{BranchID: ${b.branchId}, ArmCount: ${b.armCount}},`).join("\n")}\n\t\t},\n\t},`
    )
    .join("\n");

  let rendered = template
    .replaceAll("/* __NANOFUZZ_IMPORTS__ */", "")
    .replaceAll("/* __NANOFUZZ_ARG_CONVERSIONS__ */", argConversions.join("\n"))
    .replaceAll("/* __NANOFUZZ_FN_CALL__ */", fnCallCode)
    .replaceAll("/* __NANOFUZZ_VALIDATORS__ */", validatorBlocks.join("\n"))
    .replaceAll(
      "/* __NANOFUZZ_STATIC_COV_JSON__ */",
      JSON.stringify(staticCovMap)
    )
    .replaceAll("/* __NANOFUZZ_COVERAGE_MANIFEST__ */", manifestGo);

  rendered += `\n\nfunc containsValidator(list []string, name string) bool {\n\tfor _, v := range list {\n\t\tif v == name { return true }\n\t}\n\treturn false\n}\n`;

  return rendered;
} // fn: generateGoHarnessSource

export type CoverageManifestEntry = {
  fileId: number;
  filePath: string;
  branchArms: Array<{ branchId: number; armCount: number }>;
};

/**
 * Parses Go source with Tree-sitter and extracts static statement, function, and branch coverage,
 * injecting coverage tracking probes into an instrumented copy of the source code.
 */
export function extractGoStaticCoverage(
  src: string,
  targetFile: string = "",
  fileId: number = 0
): {
  staticCov: FileCoverageData;
  branchSpecs: Array<{ branchId: number; armCount: number }>;
  instrumentedSrc: string;
} {
  const tree = Parser.parse("go", src);
  if (!tree) {
    throw new Error("Parser failed to parse Go source for static coverage");
  }

  const statementMap: FileCoverageData["statementMap"] = {};
  const fnMap: FileCoverageData["fnMap"] = {};
  const branchMap: FileCoverageData["branchMap"] = {};
  const s: FileCoverageData["s"] = {};
  const f: FileCoverageData["f"] = {};
  const b: FileCoverageData["b"] = {};
  const branchSpecs: Array<{ branchId: number; armCount: number }> = [];

  let sIdx = 0;
  let fIdx = 0;
  let bIdx = 0;

  const fnQuery = Parser.query(
    "go",
    `
[
  (function_declaration
    name: (identifier) @fn.name
    body: (block) @fn.body) @fn.decl
  (method_declaration
    name: (field_identifier) @fn.name
    body: (block) @fn.body) @fn.decl
]
`
  );

  const fnMatches = fnQuery.matches(tree.rootNode);
  const fnProbes: Array<{ pos: number; code: string }> = [];

  for (const match of fnMatches) {
    const declNode = match.captures.find((c) => c.name === "fn.decl")?.node;
    const nameNode = match.captures.find((c) => c.name === "fn.name")?.node;
    const bodyNode = match.captures.find((c) => c.name === "fn.body")?.node;
    if (!declNode || !nameNode || !bodyNode) continue;

    const currentFIdx = fIdx++;
    fnMap[currentFIdx] = {
      name: nameNode.text,
      decl: {
        start: { line: declNode.startPosition.row + 1, column: declNode.startPosition.column },
        end: { line: declNode.endPosition.row + 1, column: declNode.endPosition.column },
      },
      loc: {
        start: { line: bodyNode.startPosition.row + 1, column: bodyNode.startPosition.column },
        end: { line: bodyNode.endPosition.row + 1, column: bodyNode.endPosition.column },
      },
      line: declNode.startPosition.row + 1,
    };
    f[currentFIdx] = 0;

    fnProbes.push({
      pos: bodyNode.startIndex + 1,
      code: `\n\tcoverage.HitFn(${fileId}, ${currentFIdx})\n`,
    });
  }

  // Statements
  const stmtQuery = Parser.query(
    "go",
    `
[
  (expression_statement) @stmt
  (assignment_statement) @stmt
  (short_var_declaration) @stmt
  (return_statement) @stmt
  (inc_statement) @stmt
  (dec_statement) @stmt
]
`
  );

  const stmtMatches = stmtQuery.matches(tree.rootNode);
  const stmtProbes: Array<{ pos: number; code: string }> = [];

  for (const match of stmtMatches) {
    const node = match.captures.find((c) => c.name === "stmt")?.node;
    if (!node) continue;
    if (node.parent?.type === "for_clause" || node.parent?.type === "range_clause") {
      continue;
    }

    const currentSIdx = sIdx++;
    statementMap[currentSIdx] = {
      start: { line: node.startPosition.row + 1, column: node.startPosition.column },
      end: { line: node.endPosition.row + 1, column: node.endPosition.column },
    };
    s[currentSIdx] = 0;

    stmtProbes.push({
      pos: node.startIndex,
      code: `coverage.HitStmt(${fileId}, ${currentSIdx}); `,
    });
  }

  // Branches: if statements
  const ifQuery = Parser.query(
    "go",
    `(if_statement
      consequence: (block) @if.then
      alternative: (_)? @if.else) @if.stmt`
  );

  const ifMatches = ifQuery.matches(tree.rootNode);
  const branchProbes: Array<{ pos: number; code: string }> = [];

  for (const match of ifMatches) {
    const stmtNode = match.captures.find((c) => c.name === "if.stmt")?.node;
    const thenBlock = match.captures.find((c) => c.name === "if.then")?.node;
    const elseNode = match.captures.find((c) => c.name === "if.else")?.node;
    if (!stmtNode || !thenBlock) continue;

    const currentBIdx = bIdx++;
    const armCount = 2;
    branchSpecs.push({ branchId: currentBIdx, armCount });
    branchMap[currentBIdx] = {
      loc: {
        start: { line: stmtNode.startPosition.row + 1, column: stmtNode.startPosition.column },
        end: { line: stmtNode.endPosition.row + 1, column: stmtNode.endPosition.column },
      },
      type: "if",
      locations: [
        {
          start: { line: thenBlock.startPosition.row + 1, column: thenBlock.startPosition.column },
          end: { line: thenBlock.endPosition.row + 1, column: thenBlock.endPosition.column },
        },
        elseNode
          ? {
              start: { line: elseNode.startPosition.row + 1, column: elseNode.startPosition.column },
              end: { line: elseNode.endPosition.row + 1, column: elseNode.endPosition.column },
            }
          : {
              start: { line: stmtNode.startPosition.row + 1, column: stmtNode.startPosition.column },
              end: { line: stmtNode.endPosition.row + 1, column: stmtNode.endPosition.column },
            },
      ],
      line: stmtNode.startPosition.row + 1,
    };
    b[currentBIdx] = [0, 0];

    branchProbes.push({
      pos: thenBlock.startIndex + 1,
      code: `\n\tcoverage.HitBranch(${fileId}, ${currentBIdx}, 0)\n`,
    });

    if (elseNode) {
      if (elseNode.type === "block") {
        branchProbes.push({
          pos: elseNode.startIndex + 1,
          code: `\n\tcoverage.HitBranch(${fileId}, ${currentBIdx}, 1)\n`,
        });
      }
    } else {
      branchProbes.push({
        pos: thenBlock.endIndex,
        code: ` else { coverage.HitBranch(${fileId}, ${currentBIdx}, 1) }`,
      });
    }
  }

  // Combine probes and instrument source
  const allProbes = [...fnProbes, ...stmtProbes, ...branchProbes];
  allProbes.sort((a, b) => b.pos - a.pos);

  let instrumentedSrc = src;
  for (const p of allProbes) {
    instrumentedSrc =
      instrumentedSrc.slice(0, p.pos) + p.code + instrumentedSrc.slice(p.pos);
  }

  // Ensure coverage package is imported in instrumented source if probes were injected
  if (allProbes.length > 0 && !instrumentedSrc.includes('"github.com/nanofuzz/runtime/coverage"')) {
    instrumentedSrc = instrumentedSrc.replace(
      /\bpackage\s+[a-zA-Z0-9_]+\s*\n/,
      `$&\nimport "github.com/nanofuzz/runtime/coverage"\n`
    );
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
    staticCov,
    branchSpecs,
    instrumentedSrc,
  };
} // fn: extractGoStaticCoverage
