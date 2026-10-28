import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { FileCoverageData } from "istanbul-lib-coverage";
import { OxcamlCompiler } from "../../compilers/oxcaml/OxcamlCompiler";
import { OxcamlCompilerError } from "../../compilers/Types";
import { OxcamlProgram } from "../../analysis/oxcaml/OxcamlProgram";
import { CompanionManager } from "../../analysis/CompanionManager";
import { FuzzEnv } from "../../Types";
import { TypeRef, ArgTag } from "../../analysis/Types";
import { ArgDef } from "../../analysis/ArgDef";
import { findInAncestor } from "../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Config from "../../../Config";
import { parseCoverageScope } from "../../measures/Util";
import { CoverageScopeConfig } from "../../measures/Types";

const HARNESS_TEMPLATE_VER = "OxcamlHarness-0.4.0";

const _instrumentCache = new Map<
  string,
  {
    instrumentedSrc: string;
    staticCov: FileCoverageData;
    branchArms: Array<[number, number]>;
  }
>();

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

  const coverageScopeRaw = Config.get<unknown>(
    "nanofuzz.fuzzer.coverageScope",
    "project static"
  );
  let scopeConfig: CoverageScopeConfig = {
    target: "project",
    collectStaticCoverage: true,
  };
  try {
    scopeConfig = parseCoverageScope(coverageScopeRaw);
  } catch {
    // fallback
  }

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

  // Discover local module dependencies for multi-file coverage
  const localModules = OxcamlProgram.findLocalModules(normTarget);

  // Discover direct external libraries
  const isDirectImports = scopeConfig.target.includes("directimports");
  const directLibNames = OxcamlProgram.findDirectLibraries(normTarget);
  const targetDir = path.dirname(normTarget);
  const userDune = findInAncestor(targetDir, "dune");
  const userLibs = userDune ? extractDuneLibraries(userDune) : [];

  const candidateLibNames = Array.from(
    new Set([...directLibNames, ...userLibs])
  ).filter((l) => l !== "nanofuzz_runtime" && l !== "yojson");

  const externalLibsToVendor: Array<{
    name: string;
    dir: string;
    instrument: boolean;
  }> = [];
  const externalLibFiles: Array<{
    mlFile: string;
    origPath: string;
    relVendorPath: string;
    libName: string;
  }> = [];

  for (const libName of candidateLibNames) {
    const resolvedDir = resolveLibrarySourceDir(libName, targetDir);
    if (resolvedDir && !externalLibsToVendor.some((l) => l.name === libName)) {
      externalLibsToVendor.push({
        name: libName,
        dir: resolvedDir,
        instrument: isDirectImports,
      });
    }
  }

  for (const lib of externalLibsToVendor) {
    const mlFiles = findMlFilesRecursive(lib.dir);
    for (const mlFile of mlFiles) {
      const origPath = fs.existsSync(mlFile)
        ? fs.realpathSync(mlFile)
        : path.resolve(mlFile);
      const rel = path.relative(lib.dir, mlFile);
      const relVendorPath = path.join("vendor", lib.name, rel);
      externalLibFiles.push({
        mlFile,
        origPath,
        relVendorPath,
        libName: lib.name,
      });
    }
  }

  const allTrackedFiles = [
    normTarget,
    ...localModules,
    ...externalLibFiles.map((e) => e.origPath),
  ];

  let maxMtime = 0;
  for (const pf of allTrackedFiles) {
    if (fs.existsSync(pf)) {
      const m = fs.statSync(pf).mtimeMs;
      if (m > maxMtime) maxMtime = m;
    }
  }

  const validators = env?.validators.map((v) => v.name) ?? [];
  const cacheKey = crypto
    .createHash("sha256")
    .update(
      `${normTarget}:${fnName}:${validators.sort().join(",")}:${allTrackedFiles.sort().join(",")}:${scopeConfig.target}:${HARNESS_TEMPLATE_VER}:${targetSrc}`
    )
    .digest("hex");

  const harnessDir = path.join(baseTmp, `harness-${cacheKey.slice(0, 16)}`);
  const binaryPath = path.join(harnessDir, "_build", "default", "harness.exe");

  const instrumentedModules: Array<{
    instPath: string;
    instrumentedSrc: string;
  }> = [];

  for (let i = 0; i < localModules.length; i++) {
    const localFile = localModules[i];
    const fileId = i + 1;
    const localSrc = fs.readFileSync(localFile, "utf8");
    const localCov = instrumentOxcamlSource(localSrc, localFile, fileId);
    staticCovMap[localFile.replace(/\\/g, "/")] = localCov.staticCov;
    manifestEntries.push({
      fileId,
      filePath: localFile,
      branchArms: localCov.branchArms,
    });
    const instPath = path.join(harnessDir, path.basename(localFile));
    instrumentedModules.push({
      instPath,
      instrumentedSrc: `# 1 "${localFile.replace(/\\/g, "/")}"\n${localCov.instrumentedSrc}`,
    });
  }

  // Process external library files
  let nextFileId = 1 + localModules.length;
  const vendoredFilesToWrite: Array<{
    destFile: string;
    instrumentedSrc: string;
  }> = [];

  for (const item of externalLibFiles) {
    const libMeta = externalLibsToVendor.find((l) => l.name === item.libName);
    const shouldInstrument = libMeta?.instrument ?? false;

    if (shouldInstrument) {
      const fileId = nextFileId++;
      const extSrc = fs.readFileSync(item.origPath, "utf8");
      const extCov = instrumentOxcamlSource(extSrc, item.origPath, fileId);
      staticCovMap[item.origPath.replace(/\\/g, "/")] = extCov.staticCov;
      manifestEntries.push({
        fileId,
        filePath: item.origPath,
        branchArms: extCov.branchArms,
      });
      vendoredFilesToWrite.push({
        destFile: path.join(harnessDir, item.relVendorPath),
        instrumentedSrc: `# 1 "${item.origPath.replace(/\\/g, "/")}"\n${extCov.instrumentedSrc}`,
      });
    } else {
      const extSrc = fs.readFileSync(item.origPath, "utf8");
      vendoredFilesToWrite.push({
        destFile: path.join(harnessDir, item.relVendorPath),
        instrumentedSrc: `# 1 "${item.origPath.replace(/\\/g, "/")}"\n${extSrc}`,
      });
    }
  }

  // Return cached binary if up-to-date (after populating staticCovMap for all tracked files)
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

  // Vendor external libraries
  for (const lib of externalLibsToVendor) {
    const vendorLibDir = path.join(harnessDir, "vendor", lib.name);
    fs.mkdirSync(vendorLibDir, { recursive: true });

    // Copy any interface files
    const mliFiles = findMliFilesRecursive(lib.dir);
    for (const mli of mliFiles) {
      const rel = path.relative(lib.dir, mli);
      const destMli = path.join(vendorLibDir, rel);
      fs.mkdirSync(path.dirname(destMli), { recursive: true });
      fs.copyFileSync(mli, destMli);
    }

    const origDune = findInAncestor(lib.dir, "dune");
    const origSubLibs = origDune ? extractDuneLibraries(origDune) : [];
    const baseSubLibs = lib.instrument ? ["nanofuzz_runtime"] : [];
    const subLibs = Array.from(
      new Set([...baseSubLibs, ...origSubLibs])
    ).filter((l) => l !== lib.name);

    fs.writeFileSync(
      path.join(vendorLibDir, "dune"),
      `(library
 (name ${lib.name})
 (flags (:standard -g -w -33-26-27-32-34-37-39))
 (ocamlopt_flags (:standard -g))
 (libraries ${subLibs.join(" ")}))
`,
      "utf8"
    );
  }

  for (const vf of vendoredFilesToWrite) {
    fs.mkdirSync(path.dirname(vf.destFile), { recursive: true });
    fs.writeFileSync(vf.destFile, vf.instrumentedSrc, "utf8");
  }

  // Write dune-project
  const duneProjectContent = `(lang dune 2.9)
(name nanofuzz_harness_project)
`;
  fs.writeFileSync(
    path.join(harnessDir, "dune-project"),
    duneProjectContent,
    "utf8"
  );

  // Assemble libraries for harness
  const vendoredLibNames = externalLibsToVendor.map((l) => l.name);
  const allLibs = Array.from(
    new Set([
      "msgpck",
      "yojson",
      "nanofuzz_runtime",
      ...userLibs,
      ...vendoredLibNames,
    ])
  );

  // Write dune
  const duneContent = `(executable
 (name harness)
 (flags (:standard -g -w -33-26-27-32-34-37-39))
 (ocamlopt_flags (:standard -g))
 (libraries ${allLibs.join(" ")}))
`;
  fs.writeFileSync(path.join(harnessDir, "dune"), duneContent, "utf8");

  // Write target_module.ml (with line directive to map backtraces to original source)
  const isExported = env?.function?.isExported() ?? true;
  const relTarget = path.isAbsolute(normTarget)
    ? path.relative(process.cwd(), normTarget)
    : normTarget;
  const displayTarget = relTarget.startsWith("..")
    ? path.basename(normTarget)
    : relTarget.replace(/\\/g, "/");
  let finalTargetSrc = `# 1 "${displayTarget}"\n${targetCov.instrumentedSrc}`;
  if (!isExported) {
    finalTargetSrc += `\n\nlet __nanofuzz_get__ = ${fnName}\n`;
  }
  fs.writeFileSync(
    path.join(harnessDir, "target_module.ml"),
    finalTargetSrc,
    "utf8"
  );

  // Write local module dependency files
  for (const mod of instrumentedModules) {
    fs.writeFileSync(mod.instPath, mod.instrumentedSrc, "utf8");
  }

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

  const buildRes = ChildProcess.spawnSync(
    duneBin,
    ["build", "./harness.exe", "--cache=disabled"],
    {
      cwd: harnessDir,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        DUNE_CACHE: "disabled",
        [pathKey]: `${duneDir}${path.delimiter}${process.env[pathKey] || ""}`,
      },
    }
  );

  if (buildRes.status !== 0 || !fs.existsSync(binaryPath)) {
    const errorOutput =
      [buildRes.stderr, buildRes.stdout]
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .join("\n") || "Dune build failed for test harness";
    throw new OxcamlCompilerError(
      "Failed to build OCaml fuzzing harness executable",
      {
        inputFile: normTarget,
        commandCli: `${duneBin} build ./harness.exe`,
        output: errorOutput.split("\n"),
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
  const cacheKey = `${targetFile}:${fileId}:${crypto.createHash("md5").update(src).digest("hex")}`;
  const cached = _instrumentCache.get(cacheKey);
  if (cached) {
    return {
      instrumentedSrc: cached.instrumentedSrc,
      staticCov: structuredClone(cached.staticCov),
      branchArms: [...cached.branchArms],
    };
  }

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
  const insertions: Array<{
    pos: number;
    text: string;
    isClose: boolean;
    spanLen: number;
  }> = [];

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

    // Only instrument direct children of value_definition (skip local let-in bindings)
    if (bindingNode.parent?.type !== "value_definition") continue;

    // Only treat bindings with parameters or fun/function bodies as functions
    const hasParams = bindingNode.children.some((c) => c.type === "parameter");
    const isFunBody =
      bodyNode.type === "fun_expression" ||
      bodyNode.type === "function_expression";
    if (!hasParams && !isFunBody) continue;

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

    const spanLen = bodyNode.endIndex - bodyNode.startIndex;
    insertions.push({
      pos: bodyNode.startIndex,
      text: `(Nanofuzz_runtime.Coverage.hit_fn ${fileId} ${currentFIdx}; Nanofuzz_runtime.Coverage.hit_stmt ${fileId} ${currentSIdx}; `,
      isClose: false,
      spanLen,
    });
    insertions.push({
      pos: bodyNode.endIndex,
      text: `)`,
      isClose: true,
      spanLen,
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
    const thenNode = thenClause
      ? Parser.getNamedChildrenNoComments(thenClause)[0]
      : undefined;
    const elseNode = elseClause
      ? Parser.getNamedChildrenNoComments(elseClause)[0]
      : undefined;
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

    const thenSpan = thenNode.endIndex - thenNode.startIndex;
    insertions.push({
      pos: thenNode.startIndex,
      text: `(Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} 0; `,
      isClose: false,
      spanLen: thenSpan,
    });
    insertions.push({
      pos: thenNode.endIndex,
      text: `)`,
      isClose: true,
      spanLen: thenSpan,
    });

    if (elseNode) {
      const elseSpan = elseNode.endIndex - elseNode.startIndex;
      insertions.push({
        pos: elseNode.startIndex,
        text: `(Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} 1; `,
        isClose: false,
        spanLen: elseSpan,
      });
      insertions.push({
        pos: elseNode.endIndex,
        text: `)`,
        isClose: true,
        spanLen: elseSpan,
      });
    } else {
      const exprSpan = exprNode.endIndex - exprNode.startIndex;
      insertions.push({
        pos: exprNode.endIndex,
        text: ` else (Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} 1; ())`,
        isClose: true,
        spanLen: exprSpan,
      });
    }
  }

  // Query match-expressions and function-expressions for match branches
  const matchQuery = Parser.query(
    "oxcaml",
    `
[
  (match_expression)
  (function_expression)
] @match.expr
`
  );
  const matchMatches = matchQuery.matches(tree.rootNode);

  for (const m of matchMatches) {
    const exprNode = m.captures.find((c) => c.name === "match.expr")?.node;
    if (!exprNode) continue;

    const cases = exprNode.children.filter((c) => c.type === "match_case");
    if (cases.length === 0) continue;

    const currentBIdx = String(bIdx++);
    branchArms.push([Number(currentBIdx), cases.length]);
    const locations = [];
    b[currentBIdx] = new Array(cases.length).fill(0);

    for (let i = 0; i < cases.length; i++) {
      const caseNode = cases[i];
      const noComments = Parser.getNamedChildrenNoComments(caseNode);
      const bodyNode =
        caseNode.childForFieldName("body") ?? noComments[noComments.length - 1];
      if (!bodyNode) continue;

      locations.push({
        start: {
          line: caseNode.startPosition.row + 1,
          column: caseNode.startPosition.column,
        },
        end: {
          line: bodyNode.endPosition.row + 1,
          column: bodyNode.endPosition.column,
        },
      });

      const bodySpan = bodyNode.endIndex - bodyNode.startIndex;
      insertions.push({
        pos: bodyNode.startIndex,
        text: `(Nanofuzz_runtime.Coverage.hit_branch ${fileId} ${currentBIdx} ${i}; `,
        isClose: false,
        spanLen: bodySpan,
      });
      insertions.push({
        pos: bodyNode.endIndex,
        text: `)`,
        isClose: true,
        spanLen: bodySpan,
      });
    }

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
      type: "match",
      locations,
      line: exprNode.startPosition.row + 1,
    };
  }

  // Sort insertions from end to start to preserve character offsets.
  // At identical positions:
  // 1. Closing insertions (`isClose: true`) come before opening insertions (`isClose: false`)
  //    so `endExpr) (startExpr` is ordered correctly.
  // 2. For two closing insertions at the same pos, larger `spanLen` is applied first (ends up outermost).
  // 3. For two opening insertions at the same pos, smaller `spanLen` is applied first (ends up innermost).
  insertions.sort((a, bPos) => {
    if (bPos.pos !== a.pos) return bPos.pos - a.pos;
    if (a.isClose !== bPos.isClose) return a.isClose ? 1 : -1;
    if (a.isClose) return bPos.spanLen - a.spanLen;
    return a.spanLen - bPos.spanLen;
  });

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

  const res = {
    instrumentedSrc,
    staticCov,
    branchArms,
  };
  _instrumentCache.set(cacheKey, res);
  return {
    instrumentedSrc,
    staticCov: structuredClone(staticCov),
    branchArms: [...branchArms],
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

  const isTransformer = CompanionManager.isTransformer(fnName, "oxcaml");
  const isGenerator = CompanionManager.isUserGenerator(fnName, "oxcaml");

  if (isGenerator) {
    argConversions.push(
      `let seed_opt_0 =
          match List.nth_opt args 0 with
          | Some v ->
            let m = get_map v in
            (match List.find_opt (fun (k, _) -> k = Msgpck.String "seed") m with
             | Some (_, s_val) ->
               let s = get_string s_val in
               if String.length s > 0 then begin
                 let h = ref 0x811c9dc5 in
                 String.iter (fun c -> h := (!h * 0x1000193) lxor (Char.code c)) s;
                 Some (ref !h)
               end else None
             | None -> None)
          | None -> None
        in
        let arg_0 () : float =
          match seed_opt_0 with
          | Some seed_ref ->
            seed_ref := (!seed_ref * 1103515245 + 12345) land 0x7FFFFFFF;
            float_of_int (!seed_ref) /. 2147483648.0
          | None ->
            Random.float 1.0
        in`
    );
    callArgs.push("arg_0");
    callArgsPat.push("arg_0");
  } else {
    for (let i = 0; i < argDefs.length; i++) {
      const arg = argDefs[i];
      const typeAnnot = OxcamlProgram.getTypeAnnotation(arg);
      const deserExpr = buildDeserializer(typeAnnot, i, arg, prog.types);

      argConversions.push(`let arg_${i} = ${deserExpr} in`);
      callArgs.push(`arg_${i}`);
      callArgsPat.push(`arg_${i}`);
    }
  }

  const callArgsStr = callArgs.length > 0 ? callArgs.join(", ") : "()";
  const callArgsPatStr = callArgsPat.length > 0 ? callArgsPat.join(", ") : "()";

  // Target function call and output serialization
  let serExpr: string;
  if (isGenerator) {
    const targetFn = CompanionManager.getUserGeneratorTarget(fnName, "oxcaml");
    const genTargetDef =
      env?.function?.getName() === targetFn
        ? env?.function
        : targetFn
          ? prog.functions[targetFn]
          : undefined;
    const targetArgs = genTargetDef ? genTargetDef.getArgDefs() : [];
    if (targetArgs.length > 1) {
      const binders = targetArgs.map((_, i) => `t_${i}`).join(", ");
      const elems = targetArgs
        .map((a, i) =>
          buildSerializer(
            OxcamlProgram.getTypeAnnotation(a),
            `t_${i}`,
            a,
            prog.types
          )
        )
        .join("; ");
      serExpr = `(match out_val with None -> Msgpck.Nil | Some (${binders}) -> Msgpck.List [${elems}])`;
    } else if (targetArgs.length === 1) {
      serExpr = `(match out_val with None -> Msgpck.Nil | Some v -> Msgpck.List [${buildSerializer(OxcamlProgram.getTypeAnnotation(targetArgs[0]), "v", targetArgs[0], prog.types)}])`;
    } else {
      serExpr = `(match out_val with None -> Msgpck.Nil | Some v -> Msgpck.List [Msgpck.Int (Obj.magic v)])`;
    }
  } else {
    const retArg = targetFnDef?.getReturnArg();
    const retType = retArg ? OxcamlProgram.getTypeAnnotation(retArg) : "int";
    serExpr = buildSerializer(
      retType,
      "out_val",
      retArg,
      prog.types,
      isTransformer,
      false
    );
  }

  let fnCallCode: string;
  if (isVoid || callArgs.length === 0) {
    const callInvocation =
      callArgs.length === 0
        ? `${targetFnAccessor} ()`
        : `${targetFnAccessor} ${callArgs.join(" ")}`;
    if (isVoid) {
      fnCallCode = `let () = ${callInvocation} in let out_msgpck = Msgpck.Nil in Ok (out_msgpck)`;
    } else {
      fnCallCode = `let out_val = ${callInvocation} in let out_msgpck = ${serExpr} in Ok (out_msgpck)`;
    }
  } else {
    fnCallCode = `let out_val = ${targetFnAccessor} ${callArgs.join(" ")} in let out_msgpck = ${serExpr} in Ok (out_msgpck)`;
  }

  // Validators execution
  const validators = env?.validators ?? [];
  const validatorLines: string[] = [];
  for (const v of validators) {
    const valDef = prog.functions[v.name];
    const valRetArg = valDef?.getReturnArg();
    const valRetType = valRetArg
      ? OxcamlProgram.getTypeAnnotation(valRetArg).trim()
      : "";

    let convertRes = `Nanofuzz_runtime.validator_result_to_string res`;
    if (valRetType === "string") {
      convertRes = `res`;
    } else if (valRetType === "bool") {
      convertRes = `if res then "pass" else "fail"`;
    }

    validatorLines.push(
      `if List.mem "${v.name}" validators then begin
        let ftr = Nanofuzz_runtime.make_fuzz_test_result
          ~inputs:(List.map Nanofuzz_runtime.msgpck_to_yojson args)
          ~out:(Nanofuzz_runtime.msgpck_to_yojson out_msgpck)
          ~exception_:false
          ~timeout:false
        in
        let vr =
          try
            let res = Target_module.${v.name} ftr in
            let res_str = ${convertRes} in
            Msgpck.Map [(Msgpck.String "tag", Msgpck.String "value"); (Msgpck.String "value", Msgpck.String res_str)]
          with
          | Unsatisfied_assumption msg ->
            Msgpck.Map [(Msgpck.String "tag", Msgpck.String "skip"); (Msgpck.String "message", Msgpck.String msg)]
          | exn ->
            Msgpck.Map [(Msgpck.String "tag", Msgpck.String "error"); (Msgpck.String "message", Msgpck.String (Printexc.to_string exn))]
        in
        val_results := (Msgpck.String "${v.name}", vr) :: !val_results
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
function buildDeserializer(
  typeAnnot: string,
  idx: number,
  argDef?: ArgDef,
  progTypes: Record<string, TypeRef> = {}
): string {
  const cleanType = typeAnnot.trim();

  // Result types: ('a, 'e) result
  if (
    cleanType.endsWith(" result") ||
    cleanType.endsWith(") result") ||
    cleanType.endsWith(" Result.t")
  ) {
    const tupleInner = cleanType
      .slice(0, cleanType.lastIndexOf(" result"))
      .trim();
    const resultParts = splitTupleType(tupleInner);
    const okType = resultParts[0] ?? "int";
    const errType = resultParts[1] ?? "string";
    const okChild = argDef?.getChildren()[0];
    const errChild = argDef?.getChildren()[1];
    return `(match List.nth_opt args ${idx} with
      | Some v ->
        let m = get_map v in
        (match List.find_opt (fun (k, _) -> k = Msgpck.String "ok") m with
         | Some (_, ok_v) -> Ok (${buildSingleValDeserializer(okType, "ok_v", okChild, progTypes)})
         | None ->
           (match List.find_opt (fun (k, _) -> k = Msgpck.String "error") m with
            | Some (_, err_v) -> Error (${buildSingleValDeserializer(errType, "err_v", errChild, progTypes)})
            | None -> Ok (${buildSingleValDeserializer(okType, "Msgpck.Nil", okChild, progTypes)})))
      | None -> Ok (${buildSingleValDeserializer(okType, "Msgpck.Nil", okChild, progTypes)}))`;
  }

  // Tuples
  const tupleParts = splitTupleType(cleanType);
  if (tupleParts.length > 1) {
    const tupleChildren = argDef?.getChildren() ?? [];
    return `(match List.nth_opt args ${idx} with Some v -> let l = get_list v in (${tupleParts.map((t, i) => buildSingleValDeserializer(t, `(List.nth l ${i})`, tupleChildren[i], progTypes)).join(", ")}) | None -> failwith "arg ${idx}: expected tuple")`;
  }

  // Option
  if (cleanType.endsWith(" option")) {
    const elemType = cleanType.slice(0, -7).trim();
    const elemChild = getElementArgDef(argDef);
    return `(match List.nth_opt args ${idx} with None | Some Msgpck.Nil -> None | Some v -> Some (${buildSingleValDeserializer(elemType, "v", elemChild, progTypes)}))`;
  }

  // List
  if (cleanType.endsWith(" list")) {
    const elemType = cleanType.slice(0, -5).trim();
    const elemChild = getElementArgDef(argDef);
    return `(match List.nth_opt args ${idx} with
      | Some v ->
        let raw_list = match v with
          | Msgpck.Map m ->
            (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____SET____") m with
             | Some (_, Msgpck.List l) -> l
             | _ -> [])
          | Msgpck.List l -> l
          | _ -> []
        in
        List.map (fun item -> ${buildSingleValDeserializer(elemType, "item", elemChild, progTypes)}) raw_list
      | None -> [])`;
  }

  // Array
  if (cleanType.endsWith(" array")) {
    const elemType = cleanType.slice(0, -6).trim();
    const elemChild = getElementArgDef(argDef);
    return `(match List.nth_opt args ${idx} with Some v -> Array.of_list (List.map (fun item -> ${buildSingleValDeserializer(elemType, "item", elemChild, progTypes)}) (get_list v)) | None -> [||])`;
  }

  // Buffer.t
  if (cleanType === "Buffer.t" || cleanType === "Buffer") {
    return `(let buf = Buffer.create 16 in (match List.nth_opt args ${idx} with Some v -> Buffer.add_string buf (get_string v) | None -> ()); buf)`;
  }

  // bigstring / Bigarray.Array1.t
  if (
    cleanType === "bigstring" ||
    cleanType.includes("Bigstring") ||
    cleanType.includes("Array1.t")
  ) {
    return `(let s = match List.nth_opt args ${idx} with Some v -> (match v with Msgpck.Bytes b -> b | Msgpck.String str -> str | _ -> Bytes.to_string (get_bytes v)) | None -> "" in let ba = Bigarray.Array1.create Bigarray.char Bigarray.c_layout (String.length s) in String.iteri (fun i c -> ba.{i} <- c) s; ba)`;
  }

  // Record types
  const normCleanType = cleanType.startsWith("Target_module.")
    ? cleanType.slice("Target_module.".length)
    : cleanType;
  const isRecord =
    !cleanType.includes("Map") &&
    !cleanType.includes("Set") &&
    !cleanType.includes("Hashtbl") &&
    !cleanType.includes("result") &&
    ((argDef &&
      argDef.getType() === ArgTag.OBJECT &&
      argDef.getChildren().length > 0 &&
      argDef.getChildren().every((c) => c.getName() !== "unknown")) ||
      ((cleanType in progTypes || normCleanType in progTypes) &&
        (progTypes[cleanType]?.type?.type === ArgTag.OBJECT ||
          progTypes[normCleanType]?.type?.type === ArgTag.OBJECT) &&
        ((progTypes[cleanType]?.type?.children?.length ?? 0) > 0 ||
          (progTypes[normCleanType]?.type?.children?.length ?? 0) > 0)));
  if (isRecord) {
    const fields =
      argDef && argDef.getChildren().length > 0
        ? argDef.getChildren()
        : (progTypes[cleanType]?.type?.children ??
          progTypes[normCleanType]?.type?.children ??
          []);
    const fieldDesers = fields.map((f) => {
      if (f instanceof ArgDef) {
        const fieldName = f.getName();
        const fieldType = OxcamlProgram.getTypeAnnotation(f);
        return `${fieldName} = (match List.find_opt (fun (k, _) -> k = Msgpck.String "${fieldName}") m with Some (_, v) -> ${buildSingleValDeserializer(fieldType, "v", f, progTypes)} | None -> failwith "missing field ${fieldName}")`;
      } else {
        const fieldName = f.name ?? "";
        const fieldType = f.typeRefName ?? "int";
        return `${fieldName} = (match List.find_opt (fun (k, _) -> k = Msgpck.String "${fieldName}") m with Some (_, v) -> ${buildSingleValDeserializer(fieldType, "v", undefined, progTypes)} | None -> failwith "missing field ${fieldName}")`;
      }
    });
    return `(match List.nth_opt args ${idx} with Some v -> let m = get_map v in { Target_module. ${fieldDesers.join("; ")} } | None -> failwith "arg ${idx}: expected record ${cleanType}")`;
  }

  // Set modules
  const isSet =
    (argDef && argDef.getType() === ArgTag.SET) ||
    cleanType.endsWith("Set.t") ||
    cleanType.includes(".Set.t") ||
    cleanType === "Set.t";
  if (isSet) {
    const elemChild = argDef?.getChildren()[0];
    const elemType = elemChild
      ? OxcamlProgram.getTypeAnnotation(elemChild)
      : cleanType.includes("Int")
        ? "int"
        : cleanType.includes("String")
          ? "string"
          : "int";
    const bare = cleanType.replace(/\.t$/, "");
    const setMod = cleanType.includes(".")
      ? (bare.split(/\s+/).pop() ?? "Set")
      : "Set";
    return `(match List.nth_opt args ${idx} with
      | Some v ->
        let raw_items = match v with
          | Msgpck.Map m ->
            (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____SET____") m with
             | Some (_, Msgpck.List l) -> l
             | _ -> [])
          | Msgpck.List l -> l
          | _ -> []
        in
        Target_module.${setMod}.of_list (List.map (fun item -> ${buildSingleValDeserializer(elemType, "item", elemChild, progTypes)}) raw_items)
      | None -> Target_module.${setMod}.empty)`;
  }

  // Map and Hashtbl
  const isHashtbl = cleanType.includes("Hashtbl");
  const isMap =
    (argDef && argDef.getType() === ArgTag.DICTIONARY && !isHashtbl) ||
    cleanType.endsWith("Map.t") ||
    cleanType.includes(".Map.t") ||
    cleanType === "Map.t";

  if (isHashtbl) {
    const keyChild = argDef?.getChildren()[0];
    const valChild = argDef?.getChildren()[1];
    const keyType = keyChild
      ? OxcamlProgram.getTypeAnnotation(keyChild)
      : "string";
    const valType = valChild
      ? OxcamlProgram.getTypeAnnotation(valChild)
      : "int";
    return `(let tbl = Hashtbl.create 16 in
      (match List.nth_opt args ${idx} with
       | Some v ->
         let pairs = match v with
           | Msgpck.Map m ->
             (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____MAP____") m with
              | Some (_, Msgpck.List l) -> l
              | _ -> List.map (fun (k, val_) -> Msgpck.List [k; val_]) m)
           | Msgpck.List l -> l
           | _ -> []
         in
         List.iter (function
           | Msgpck.List [k; val_] -> Hashtbl.replace tbl (${buildSingleValDeserializer(keyType, "k", keyChild, progTypes)}) (${buildSingleValDeserializer(valType, "val_", valChild, progTypes)})
           | _ -> ()
         ) pairs
       | None -> ());
      tbl)`;
  }

  if (isMap) {
    const bare = cleanType.replace(/\.t$/, "");
    const mapMod = cleanType.includes(".")
      ? (bare.split(/\s+/).pop() ?? "Map")
      : "Map";
    let keyType: string;
    let valType: string;
    const children = argDef?.getChildren() ?? [];
    if (children.length === 1) {
      valType = OxcamlProgram.getTypeAnnotation(children[0]);
      keyType = mapMod.toLowerCase().includes("int") ? "int" : "string";
    } else if (children.length >= 2) {
      keyType = OxcamlProgram.getTypeAnnotation(children[0]);
      valType = OxcamlProgram.getTypeAnnotation(children[1]);
    } else {
      keyType = mapMod.toLowerCase().includes("int") ? "int" : "string";
      valType = "int";
    }
    const keyChild = children.length >= 2 ? children[0] : undefined;
    const valChild = children.length === 1 ? children[0] : children[1];
    return `(let pairs = match List.nth_opt args ${idx} with
        | Some v ->
          let l = match v with
            | Msgpck.Map m ->
              (match List.find_opt (fun (k, _) -> k = Msgpck.String "____JSONN____61581952310____MAP____") m with
               | Some (_, Msgpck.List pl) -> pl
               | _ -> List.map (fun (k, val_) -> Msgpck.List [k; val_]) m)
            | Msgpck.List pl -> pl
            | _ -> []
          in
          List.filter_map (function
            | Msgpck.List [k; val_] -> Some (${buildSingleValDeserializer(keyType, "k", keyChild, progTypes)}, ${buildSingleValDeserializer(valType, "val_", valChild, progTypes)})
            | _ -> None
          ) l
        | None -> []
      in
      List.fold_left (fun acc (k, val_) -> Target_module.${mapMod}.add k val_ acc) Target_module.${mapMod}.empty pairs)`;
  }

  if (cleanType === "int" || cleanType === "#int") {
    return `(match List.nth_opt args ${idx} with Some v -> get_int v | None -> 0)`;
  }
  if (cleanType === "int32") {
    return `(match List.nth_opt args ${idx} with Some v -> get_int32 v | None -> 0l)`;
  }
  if (cleanType === "int64") {
    return `(match List.nth_opt args ${idx} with Some v -> get_int64 v | None -> 0L)`;
  }
  if (cleanType === "nativeint") {
    return `(match List.nth_opt args ${idx} with Some v -> get_nativeint v | None -> 0n)`;
  }
  if (cleanType === "float" || cleanType === "#float") {
    return `(match List.nth_opt args ${idx} with Some v -> get_float v | None -> 0.0)`;
  }
  if (cleanType === "bool") {
    return `(match List.nth_opt args ${idx} with Some v -> get_bool v | None -> false)`;
  }
  if (cleanType === "string") {
    return `(match List.nth_opt args ${idx} with Some v -> get_string v | None -> "")`;
  }
  if (cleanType === "char") {
    return `(match List.nth_opt args ${idx} with Some v -> (let s = get_string v in if String.length s > 0 then s.[0] else '\\000') | None -> '\\000')`;
  }
  if (cleanType === "bytes") {
    return `(match List.nth_opt args ${idx} with Some v -> get_bytes v | None -> Bytes.empty)`;
  }

  // Variants (nullary enums, payload-bearing variants, polymorphic variants)
  const variantCtors = getVariantConstructors(cleanType, argDef, progTypes);
  if (variantCtors && variantCtors.length > 0) {
    const nullaryCtors = variantCtors.filter((c) => !c.hasPayload);
    const nullaryBranches = nullaryCtors
      .map((c) => {
        const ctorRef = c.isPoly ? c.name : `Target_module.${c.name}`;
        return `| "${c.name}" -> ${ctorRef}`;
      })
      .join("\n            ");

    const payloadCtors = variantCtors.filter((c) => c.hasPayload);
    const payloadBranches = payloadCtors
      .map((c) => {
        const ctorRef = c.isPoly ? c.name : `Target_module.${c.name}`;
        if (
          c.isTuplePayload &&
          c.tuplePayloadTypes &&
          c.tuplePayloadTypes.length > 1
        ) {
          const tupleArgs = c.tuplePayloadTypes
            .map((t, i) =>
              buildSingleValDeserializer(
                t,
                `(List.nth l ${i})`,
                undefined,
                progTypes
              )
            )
            .join(", ");
          return `| "${c.name}" ->
               let l = get_list val_payload in
               ${ctorRef} (${tupleArgs})`;
        } else {
          const deser = buildSingleValDeserializer(
            c.payloadType ?? "int",
            "val_payload",
            c.argDef,
            progTypes
          );
          return `| "${c.name}" -> ${ctorRef} (${deser})`;
        }
      })
      .join("\n            ");

    const defaultCtor = variantCtors[0];
    const defaultExpr = defaultCtor.hasPayload
      ? defaultCtor.isPoly
        ? `${defaultCtor.name} (${buildSingleValDeserializer(
            defaultCtor.payloadType ?? "int",
            "Msgpck.Nil",
            defaultCtor.argDef,
            progTypes
          )})`
        : `Target_module.${defaultCtor.name} (${buildSingleValDeserializer(
            defaultCtor.payloadType ?? "int",
            "Msgpck.Nil",
            defaultCtor.argDef,
            progTypes
          )})`
      : defaultCtor.isPoly
        ? defaultCtor.name
        : `Target_module.${defaultCtor.name}`;

    return `(match List.nth_opt args ${idx} with
      | Some v ->
        (match v with
         | Msgpck.String s ->
           (match s with
            ${nullaryBranches ? nullaryBranches + "\n            " : ""}| _ -> ${defaultExpr})
         | Msgpck.Map _ ->
           let tag_str = get_string (find_key "tag" v) in
           let val_payload = find_key "value" v in
           (match tag_str with
            ${payloadBranches ? payloadBranches + "\n            " : ""}${nullaryBranches ? nullaryBranches + "\n            " : ""}| _ -> ${defaultExpr})
         | _ -> ${defaultExpr})
      | None -> ${defaultExpr})`;
  }

  throw new Error(`Unsupported OCaml type for deserialization: '${cleanType}'`);
} // fn: buildDeserializer

/**
 * Builds an OCaml expression deserializing a single Msgpck value.
 */
function buildSingleValDeserializer(
  typeAnnot: string,
  valVar: string,
  argDef?: ArgDef,
  progTypes: Record<string, TypeRef> = {}
): string {
  const cleanType = typeAnnot.trim();

  // Result types
  if (
    cleanType.endsWith(" result") ||
    cleanType.endsWith(") result") ||
    cleanType.endsWith(" Result.t")
  ) {
    const tupleInner = cleanType
      .slice(0, cleanType.lastIndexOf(" result"))
      .trim();
    const resultParts = splitTupleType(tupleInner);
    const okType = resultParts[0] ?? "int";
    const errType = resultParts[1] ?? "string";
    const okChild = argDef?.getChildren()[0];
    const errChild = argDef?.getChildren()[1];
    return `(let m = get_map ${valVar} in
      match List.find_opt (fun (k, _) -> k = Msgpck.String "ok") m with
      | Some (_, ok_v) -> Ok (${buildSingleValDeserializer(okType, "ok_v", okChild, progTypes)})
      | None ->
        (match List.find_opt (fun (k, _) -> k = Msgpck.String "error") m with
         | Some (_, err_v) -> Error (${buildSingleValDeserializer(errType, "err_v", errChild, progTypes)})
         | None -> Ok (${buildSingleValDeserializer(okType, "Msgpck.Nil", okChild, progTypes)})))`;
  }

  // Tuples
  const tupleParts = splitTupleType(cleanType);
  if (tupleParts.length > 1) {
    const tupleChildren = argDef?.getChildren() ?? [];
    return `(let l = get_list ${valVar} in (${tupleParts.map((t, i) => buildSingleValDeserializer(t, `(List.nth l ${i})`, tupleChildren[i], progTypes)).join(", ")}) )`;
  }

  // Option
  if (cleanType.endsWith(" option")) {
    const elemType = cleanType.slice(0, -7).trim();
    const elemChild = getElementArgDef(argDef);
    return `(match ${valVar} with Msgpck.Nil -> None | v -> Some (${buildSingleValDeserializer(elemType, "v", elemChild, progTypes)}))`;
  }

  // List
  if (cleanType.endsWith(" list")) {
    const elemType = cleanType.slice(0, -5).trim();
    const elemChild = getElementArgDef(argDef);
    return `(List.map (fun item -> ${buildSingleValDeserializer(elemType, "item", elemChild, progTypes)}) (get_list ${valVar}))`;
  }

  // Array
  if (cleanType.endsWith(" array")) {
    const elemType = cleanType.slice(0, -6).trim();
    const elemChild = getElementArgDef(argDef);
    return `(Array.of_list (List.map (fun item -> ${buildSingleValDeserializer(elemType, "item", elemChild, progTypes)}) (get_list ${valVar})))`;
  }

  // Buffer.t
  if (cleanType === "Buffer.t" || cleanType === "Buffer") {
    return `(let buf = Buffer.create 16 in Buffer.add_string buf (get_string ${valVar}); buf)`;
  }

  // bigstring / Bigarray.Array1.t
  if (
    cleanType === "bigstring" ||
    cleanType.includes("Bigstring") ||
    cleanType.includes("Array1.t")
  ) {
    return `(let s = match ${valVar} with Msgpck.Bytes b -> b | Msgpck.String str -> str | _ -> Bytes.to_string (get_bytes ${valVar}) in let ba = Bigarray.Array1.create Bigarray.char Bigarray.c_layout (String.length s) in String.iteri (fun i c -> ba.{i} <- c) s; ba)`;
  }

  // Records
  const normCleanType = cleanType.startsWith("Target_module.")
    ? cleanType.slice("Target_module.".length)
    : cleanType;
  const isRecord =
    !cleanType.includes("Map") &&
    !cleanType.includes("Set") &&
    !cleanType.includes("Hashtbl") &&
    !cleanType.includes("result") &&
    ((argDef &&
      argDef.getType() === ArgTag.OBJECT &&
      argDef.getChildren().length > 0 &&
      argDef.getChildren().every((c) => c.getName() !== "unknown")) ||
      ((cleanType in progTypes || normCleanType in progTypes) &&
        (progTypes[cleanType]?.type?.type === ArgTag.OBJECT ||
          progTypes[normCleanType]?.type?.type === ArgTag.OBJECT) &&
        ((progTypes[cleanType]?.type?.children?.length ?? 0) > 0 ||
          (progTypes[normCleanType]?.type?.children?.length ?? 0) > 0)));
  if (isRecord) {
    const fields =
      argDef && argDef.getChildren().length > 0
        ? argDef.getChildren()
        : (progTypes[cleanType]?.type?.children ??
          progTypes[normCleanType]?.type?.children ??
          []);
    const fieldDesers = fields.map((f) => {
      if (f instanceof ArgDef) {
        const fieldName = f.getName();
        const fieldType = OxcamlProgram.getTypeAnnotation(f);
        return `${fieldName} = (match List.find_opt (fun (k, _) -> k = Msgpck.String "${fieldName}") m with Some (_, v) -> ${buildSingleValDeserializer(fieldType, "v", f, progTypes)} | None -> failwith "missing field ${fieldName}")`;
      } else {
        const fieldName = f.name ?? "";
        const fieldType = f.typeRefName ?? "int";
        return `${fieldName} = (match List.find_opt (fun (k, _) -> k = Msgpck.String "${fieldName}") m with Some (_, v) -> ${buildSingleValDeserializer(fieldType, "v", undefined, progTypes)} | None -> failwith "missing field ${fieldName}")`;
      }
    });
    return `(let m = get_map ${valVar} in { Target_module. ${fieldDesers.join("; ")} })`;
  }

  if (cleanType === "int" || cleanType === "#int") return `(get_int ${valVar})`;
  if (cleanType === "float" || cleanType === "#float")
    return `(get_float ${valVar})`;
  if (cleanType === "string") return `(get_string ${valVar})`;
  if (cleanType === "bool") return `(get_bool ${valVar})`;
  if (cleanType === "int32") return `(get_int32 ${valVar})`;
  if (cleanType === "int64") return `(get_int64 ${valVar})`;
  if (cleanType === "nativeint") return `(get_nativeint ${valVar})`;
  if (cleanType === "char")
    return `(let s = get_string ${valVar} in if String.length s > 0 then s.[0] else '\\000')`;
  if (cleanType === "bytes") return `(get_bytes ${valVar})`;

  // Variants (nullary enums, payload-bearing variants, polymorphic variants)
  const variantCtors = getVariantConstructors(cleanType, argDef, progTypes);
  if (variantCtors && variantCtors.length > 0) {
    const nullaryCtors = variantCtors.filter((c) => !c.hasPayload);
    const nullaryBranches = nullaryCtors
      .map((c) => {
        const ctorRef = c.isPoly ? c.name : `Target_module.${c.name}`;
        return `| "${c.name}" -> ${ctorRef}`;
      })
      .join("\n          ");

    const payloadCtors = variantCtors.filter((c) => c.hasPayload);
    const payloadBranches = payloadCtors
      .map((c) => {
        const ctorRef = c.isPoly ? c.name : `Target_module.${c.name}`;
        if (
          c.isTuplePayload &&
          c.tuplePayloadTypes &&
          c.tuplePayloadTypes.length > 1
        ) {
          const tupleArgs = c.tuplePayloadTypes
            .map((t, i) =>
              buildSingleValDeserializer(
                t,
                `(List.nth l ${i})`,
                undefined,
                progTypes
              )
            )
            .join(", ");
          return `| "${c.name}" ->
             let l = get_list val_payload in
             ${ctorRef} (${tupleArgs})`;
        } else {
          const deser = buildSingleValDeserializer(
            c.payloadType ?? "int",
            "val_payload",
            c.argDef,
            progTypes
          );
          return `| "${c.name}" -> ${ctorRef} (${deser})`;
        }
      })
      .join("\n          ");

    const defaultCtor = variantCtors[0];
    const defaultExpr = defaultCtor.hasPayload
      ? defaultCtor.isPoly
        ? `${defaultCtor.name} (${buildSingleValDeserializer(
            defaultCtor.payloadType ?? "int",
            "Msgpck.Nil",
            defaultCtor.argDef,
            progTypes
          )})`
        : `Target_module.${defaultCtor.name} (${buildSingleValDeserializer(
            defaultCtor.payloadType ?? "int",
            "Msgpck.Nil",
            defaultCtor.argDef,
            progTypes
          )})`
      : defaultCtor.isPoly
        ? defaultCtor.name
        : `Target_module.${defaultCtor.name}`;

    return `(match ${valVar} with
       | Msgpck.String s ->
         (match s with
          ${nullaryBranches ? nullaryBranches + "\n          " : ""}| _ -> ${defaultExpr})
       | Msgpck.Map _ ->
         let tag_str = get_string (find_key "tag" ${valVar}) in
         let val_payload = find_key "value" ${valVar} in
         (match tag_str with
          ${payloadBranches ? payloadBranches + "\n          " : ""}${nullaryBranches ? nullaryBranches + "\n          " : ""}| _ -> ${defaultExpr})
       | _ -> ${defaultExpr})`;
  }

  throw new Error(
    `Unsupported OCaml type for single value deserialization: '${cleanType}'`
  );
} // fn: buildSingleValDeserializer

function stripOuterParens(s: string): string {
  let str = s.trim();
  while ((str.startsWith("(") || str.startsWith("#(")) && str.endsWith(")")) {
    const isUnboxed = str.startsWith("#(");
    const startOffset = isUnboxed ? 2 : 1;
    let depth = 1;
    let matchesEnd = true;
    for (let i = startOffset; i < str.length - 1; i++) {
      if (str[i] === "(") depth++;
      else if (str[i] === ")") depth--;
      if (depth === 0) {
        matchesEnd = false;
        break;
      }
    }
    if (matchesEnd) {
      str = str.slice(startOffset, -1).trim();
    } else {
      break;
    }
  }
  return str;
} // fn: stripOuterParens

/**
 * Splits an OCaml tuple type string into its constituent element types.
 */
function splitTupleType(typeStr: string): string[] {
  const s = stripOuterParens(typeStr);
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === "*" || ch === ",") && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
} // fn: splitTupleType

/**
 * Resolves the ArgDef for elements inside a container (list, array, option).
 */
function getElementArgDef(argDef?: ArgDef): ArgDef | undefined {
  if (!argDef) return undefined;
  if (argDef.getChildren().length === 1 && argDef.getType() !== ArgTag.UNION) {
    return argDef.getChildren()[0];
  }
  if (argDef.getDim() > 0) {
    const nextDim = argDef.getDim() - 1;
    const nextTypeRefDims = Math.max(0, (argDef.getTypeRefDims() ?? 0) - 1);
    const elemDef = new ArgDef(
      argDef.getName(),
      argDef.getOffset(),
      argDef.getType(),
      argDef.getOptions(),
      nextDim,
      false,
      argDef.getIntervals(),
      argDef.getChildren(),
      argDef.getTypeRef(),
      nextTypeRefDims
    );
    const baseTypeRef = argDef.getBaseTypeRef();
    if (baseTypeRef !== undefined) {
      elemDef.setBaseTypeRef(baseTypeRef);
    }
    return elemDef;
  }
  if (argDef.isOptional()) {
    const elemDef = new ArgDef(
      argDef.getName(),
      argDef.getOffset(),
      argDef.getType(),
      argDef.getOptions(),
      0,
      false,
      argDef.getIntervals(),
      argDef.getChildren(),
      argDef.getTypeRef(),
      argDef.getTypeRefDims()
    );
    const baseTypeRef = argDef.getBaseTypeRef();
    if (baseTypeRef !== undefined) {
      elemDef.setBaseTypeRef(baseTypeRef);
    }
    return elemDef;
  }
  return argDef.getChildren()[0];
} // fn: getElementArgDef

/**
 * Builds an OCaml expression converting a return value `valVar` into a Msgpck.t.
 */
function buildSerializer(
  typeAnnot: string,
  valVar: string,
  argDef?: ArgDef,
  progTypes: Record<string, TypeRef> = {},
  isTransformer = false,
  isGenerator = false
): string {
  const cleanType = typeAnnot.trim();
  if (cleanType === "unit") return `Msgpck.Nil`;

  if (isGenerator) {
    const elemType = cleanType.endsWith(" option")
      ? cleanType.slice(0, -7).trim()
      : cleanType;
    const tupleParts = splitTupleType(elemType);
    if (tupleParts.length > 1) {
      const binders = tupleParts.map((_, i) => `t_${i}`).join(", ");
      const elems = tupleParts
        .map((t, i) => buildSerializer(t, `t_${i}`, undefined, progTypes))
        .join("; ");
      return `(match ${valVar} with None -> Msgpck.Nil | Some (${binders}) -> Msgpck.List [${elems}])`;
    }
    return `(match ${valVar} with None -> Msgpck.Nil | Some v -> Msgpck.List [${buildSerializer(elemType, "v", undefined, progTypes)}])`;
  }

  if (isTransformer) {
    const tupleParts = splitTupleType(cleanType);
    if (tupleParts.length > 1) {
      const binders = tupleParts.map((_, i) => `t_${i}`).join(", ");
      const elems = tupleParts
        .map((t, i) => buildSerializer(t, `t_${i}`, undefined, progTypes))
        .join("; ");
      return `(let (${binders}) = ${valVar} in Msgpck.List [${elems}])`;
    }
    return `Msgpck.List [${buildSerializer(cleanType, valVar, argDef, progTypes)}]`;
  }

  // Result types: ('a, 'e) result
  if (
    cleanType.endsWith(" result") ||
    cleanType.endsWith(") result") ||
    cleanType.endsWith(" Result.t")
  ) {
    const tupleInner = cleanType
      .slice(0, cleanType.lastIndexOf(" result"))
      .trim();
    const resultParts = splitTupleType(tupleInner);
    const okType = resultParts[0] ?? "int";
    const errType = resultParts[1] ?? "string";
    const okChild = argDef?.getChildren()[0];
    const errChild = argDef?.getChildren()[1];
    return `(match ${valVar} with
      | Ok v -> Msgpck.Map [(Msgpck.String "ok", ${buildSerializer(okType, "v", okChild, progTypes)})]
      | Error e -> Msgpck.Map [(Msgpck.String "error", ${buildSerializer(errType, "e", errChild, progTypes)})])`;
  }

  // Tuples
  const tupleParts = splitTupleType(cleanType);
  if (tupleParts.length > 1) {
    const tupleChildren = argDef?.getChildren() ?? [];
    const binders = tupleParts.map((_, i) => `t_${i}`).join(", ");
    const elems = tupleParts
      .map((t, i) => buildSerializer(t, `t_${i}`, tupleChildren[i], progTypes))
      .join("; ");
    return `(let (${binders}) = ${valVar} in Msgpck.List [${elems}])`;
  }

  // Option
  if (cleanType.endsWith(" option")) {
    const elemType = cleanType.slice(0, -7).trim();
    const elemChild = getElementArgDef(argDef);
    return `(match ${valVar} with None -> Msgpck.Nil | Some v -> ${buildSerializer(elemType, "v", elemChild, progTypes)})`;
  }

  // List
  if (cleanType.endsWith(" list")) {
    const elemType = cleanType.slice(0, -5).trim();
    const elemChild = getElementArgDef(argDef);
    return `Msgpck.List (List.map (fun v -> ${buildSerializer(elemType, "v", elemChild, progTypes)}) ${valVar})`;
  }

  // Array
  if (cleanType.endsWith(" array")) {
    const elemType = cleanType.slice(0, -6).trim();
    const elemChild = getElementArgDef(argDef);
    return `Msgpck.List (Array.to_list (Array.map (fun v -> ${buildSerializer(elemType, "v", elemChild, progTypes)}) ${valVar}))`;
  }

  // Buffer.t
  if (cleanType === "Buffer.t" || cleanType === "Buffer") {
    return `Msgpck.String (Buffer.contents ${valVar})`;
  }

  // bigstring / Bigarray.Array1.t
  if (
    cleanType === "bigstring" ||
    cleanType.includes("Bigstring") ||
    cleanType.includes("Array1.t")
  ) {
    return `(let len = Bigarray.Array1.dim ${valVar} in let b = Bytes.create len in for i = 0 to len - 1 do Bytes.set b i ${valVar}.{i} done; Msgpck.Bytes (Bytes.to_string b))`;
  }

  //  Records
  const normCleanType = cleanType.startsWith("Target_module.")
    ? cleanType.slice("Target_module.".length)
    : cleanType;
  const isRecord =
    !cleanType.includes("Map") &&
    !cleanType.includes("Set") &&
    !cleanType.includes("Hashtbl") &&
    !cleanType.includes("result") &&
    ((argDef &&
      argDef.getType() === ArgTag.OBJECT &&
      argDef.getChildren().length > 0 &&
      argDef.getChildren().every((c) => c.getName() !== "unknown")) ||
      ((cleanType in progTypes || normCleanType in progTypes) &&
        (progTypes[cleanType]?.type?.type === ArgTag.OBJECT ||
          progTypes[normCleanType]?.type?.type === ArgTag.OBJECT) &&
        ((progTypes[cleanType]?.type?.children?.length ?? 0) > 0 ||
          (progTypes[normCleanType]?.type?.children?.length ?? 0) > 0)));
  if (isRecord) {
    const fields =
      argDef && argDef.getChildren().length > 0
        ? argDef.getChildren()
        : (progTypes[cleanType]?.type?.children ??
          progTypes[normCleanType]?.type?.children ??
          []);
    const fieldSers = fields.map((f) => {
      if (f instanceof ArgDef) {
        const fieldName = f.getName();
        const fieldType = OxcamlProgram.getTypeAnnotation(f);
        return `(Msgpck.String "${fieldName}", ${buildSerializer(fieldType, `${valVar}.${fieldName}`, f, progTypes)})`;
      } else {
        const fieldName = f.name ?? "";
        const fieldType = f.typeRefName ?? "int";
        return `(Msgpck.String "${fieldName}", ${buildSerializer(fieldType, `${valVar}.${fieldName}`, undefined, progTypes)})`;
      }
    });
    return `Msgpck.Map [ ${fieldSers.join("; ")} ]`;
  }

  // Set modules
  const isSet =
    (argDef && argDef.getType() === ArgTag.SET) ||
    cleanType.endsWith("Set.t") ||
    cleanType.includes(".Set.t") ||
    cleanType === "Set.t";
  if (isSet) {
    const elemChild = argDef?.getChildren()[0];
    const elemType = elemChild
      ? OxcamlProgram.getTypeAnnotation(elemChild)
      : cleanType.includes("Int")
        ? "int"
        : cleanType.includes("String")
          ? "string"
          : "int";
    const bare = cleanType.replace(/\.t$/, "");
    const setMod = cleanType.includes(".")
      ? (bare.split(/\s+/).pop() ?? "Set")
      : "Set";
    return `Msgpck.List (let module S = Target_module.${setMod} in List.map (fun v -> ${buildSerializer(elemType, "v", elemChild, progTypes)}) (S.elements ${valVar}))`;
  }

  // Map and Hashtbl
  const isHashtbl = cleanType.includes("Hashtbl");
  const isMap =
    (argDef && argDef.getType() === ArgTag.DICTIONARY && !isHashtbl) ||
    cleanType.endsWith("Map.t") ||
    cleanType.includes(".Map.t") ||
    cleanType === "Map.t";

  if (isHashtbl) {
    const keyChild = argDef?.getChildren()[0];
    const valChild = argDef?.getChildren()[1];
    const keyType = keyChild
      ? OxcamlProgram.getTypeAnnotation(keyChild)
      : "string";
    const valType = valChild
      ? OxcamlProgram.getTypeAnnotation(valChild)
      : "int";
    return `Msgpck.List (Hashtbl.fold (fun k v acc -> Msgpck.List [${buildSerializer(keyType, "k", keyChild, progTypes)}; ${buildSerializer(valType, "v", valChild, progTypes)}] :: acc) ${valVar} [])`;
  }

  if (isMap) {
    const bare = cleanType.replace(/\.t$/, "");
    const mapMod = cleanType.includes(".")
      ? (bare.split(/\s+/).pop() ?? "Map")
      : "Map";
    let keyType: string;
    let valType: string;
    const children = argDef?.getChildren() ?? [];
    if (children.length === 1) {
      valType = OxcamlProgram.getTypeAnnotation(children[0]);
      keyType = mapMod.toLowerCase().includes("int") ? "int" : "string";
    } else if (children.length >= 2) {
      keyType = OxcamlProgram.getTypeAnnotation(children[0]);
      valType = OxcamlProgram.getTypeAnnotation(children[1]);
    } else {
      keyType = mapMod.toLowerCase().includes("int") ? "int" : "string";
      valType = "int";
    }
    const keyChild = children.length >= 2 ? children[0] : undefined;
    const valChild = children.length === 1 ? children[0] : children[1];
    return `Msgpck.List (let module M = Target_module.${mapMod} in List.map (fun (k, v) -> Msgpck.List [${buildSerializer(keyType, "k", keyChild, progTypes)}; ${buildSerializer(valType, "v", valChild, progTypes)}]) (M.bindings ${valVar}))`;
  }

  if (cleanType === "int" || cleanType === "#int") {
    return `(if ${valVar} >= -2147483648 && ${valVar} <= 2147483647 then Msgpck.Int ${valVar} else Msgpck.Int64 (Int64.of_int ${valVar}))`;
  }
  if (cleanType === "int32") {
    return `Msgpck.Int32 ${valVar}`;
  }
  if (cleanType === "int64") {
    return `Msgpck.Map [(Msgpck.String "____JSONN____61581952310____BIGINT____", Msgpck.String (Int64.to_string ${valVar}))]`;
  }
  if (cleanType === "nativeint") {
    return `Msgpck.Int64 (Int64.of_nativeint ${valVar})`;
  }
  if (cleanType === "float" || cleanType === "#float") {
    return `Msgpck.Float ${valVar}`;
  }
  if (cleanType === "bool") {
    return `Msgpck.Bool ${valVar}`;
  }
  if (cleanType === "string") {
    return `Msgpck.String ${valVar}`;
  }
  if (cleanType === "char") {
    return `Msgpck.String (String.make 1 ${valVar})`;
  }
  if (cleanType === "bytes") {
    return `Msgpck.Bytes (Bytes.to_string ${valVar})`;
  }

  // Variants (nullary enums, payload-bearing variants, polymorphic variants)
  const variantCtors = getVariantConstructors(cleanType, argDef, progTypes);
  if (variantCtors && variantCtors.length > 0) {
    const branches = variantCtors.map((c) => {
      const ctorRef = c.isPoly ? c.name : `Target_module.${c.name}`;
      if (!c.hasPayload) {
        return `| ${ctorRef} -> Msgpck.String "${c.name}"`;
      }
      if (
        c.isTuplePayload &&
        c.tuplePayloadTypes &&
        c.tuplePayloadTypes.length > 1
      ) {
        const binders = c.tuplePayloadTypes.map((_, i) => `p_${i}`).join(", ");
        const listItems = c.tuplePayloadTypes
          .map((t, i) => buildSerializer(t, `p_${i}`, undefined, progTypes))
          .join("; ");
        return `| ${ctorRef} (${binders}) ->
       Msgpck.Map [
         (Msgpck.String "tag", Msgpck.String "${c.name}");
         (Msgpck.String "value", Msgpck.List [${listItems}])
       ]`;
      } else {
        const serVal = buildSerializer(
          c.payloadType ?? "int",
          "v",
          c.argDef,
          progTypes
        );
        return `| ${ctorRef} v ->
       Msgpck.Map [
         (Msgpck.String "tag", Msgpck.String "${c.name}");
         (Msgpck.String "value", ${serVal})
       ]`;
      }
    });
    return `(match ${valVar} with
   ${branches.join("\n   ")})`;
  }

  throw new Error(`Unsupported OCaml type for serialization: '${cleanType}'`);
} // fn: buildSerializer

/**
 * Loads the runner host template from file or returns the embedded fallback.
 */
function getTemplate(): string {
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const candidates: string[] = [
    path.join(__dirname, "OxcamlRunnerHost.template.ml"),
    path.resolve(currModuleDir, "OxcamlRunnerHost.template.ml"),
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
        "oxcaml",
        "OxcamlRunnerHost.template.ml"
      ),
      path.join(rootDir, "build", "extension", "OxcamlRunnerHost.template.ml")
    );
  }

  candidates.push(
    path.resolve("./src/fuzzer/runners/oxcaml/OxcamlRunnerHost.template.ml"),
    path.resolve("./build/extension/OxcamlRunnerHost.template.ml")
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
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
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const projectRoot = findInAncestor(currModuleDir, "package.json");
  const candidates: string[] = [
    path.join(__dirname, "nanofuzz_runtime_oxcaml"),
    path.resolve(currModuleDir, "nanofuzz_runtime_oxcaml"),
  ];

  if (projectRoot) {
    const rootDir = path.dirname(projectRoot);
    candidates.push(
      path.join(rootDir, "packages", "runtime", "oxcaml"),
      path.join(rootDir, "build", "extension", "nanofuzz_runtime_oxcaml")
    );
  }

  candidates.push(
    path.resolve("./packages/runtime/oxcaml"),
    path.resolve("./build/extension/nanofuzz_runtime_oxcaml")
  );

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "dune-project"))) {
      return c;
    }
  }
  return undefined;
} // fn: findRuntimePackage

/**
 * Resolves the source directory for an external OCaml library.
 *
 * @param libName Name of the library to locate
 * @param targetDir Directory containing the target file
 * @returns Path to the directory containing library source files, or undefined
 */
function resolveLibrarySourceDir(
  libName: string,
  targetDir: string
): string | undefined {
  const normLibName = libName.toLowerCase();

  // Search relative to target directory (sibling, parent, subdirectories)
  const candidates = [
    path.resolve(targetDir, libName),
    path.resolve(targetDir, "..", libName),
    path.resolve(targetDir, "..", "..", libName),
    path.resolve(targetDir, normLibName),
    path.resolve(targetDir, "..", normLibName),
    path.resolve(targetDir, "..", "..", normLibName),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      const srcSub = path.join(c, "src");
      if (fs.existsSync(srcSub) && findMlFilesRecursive(srcSub).length > 0) {
        return srcSub;
      }
      if (findMlFilesRecursive(c).length > 0) {
        return c;
      }
    }
  }

  // Search in Dune project or workspace ancestors
  const duneProject = findInAncestor(targetDir, "dune-project");
  if (duneProject) {
    const projRoot = path.dirname(duneProject);
    const subCandidates = [
      path.join(projRoot, libName),
      path.join(projRoot, normLibName),
      path.join(projRoot, "lib", libName),
      path.join(projRoot, "lib", normLibName),
    ];
    for (const c of subCandidates) {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        const srcSub = path.join(c, "src");
        if (fs.existsSync(srcSub) && findMlFilesRecursive(srcSub).length > 0) {
          return srcSub;
        }
        if (findMlFilesRecursive(c).length > 0) {
          return c;
        }
      }
    }
  }

  // Search in OPAM switch library directory
  const switchPrefix = process.env.OPAM_SWITCH_PREFIX;
  if (switchPrefix) {
    const opamLib = path.join(switchPrefix, "lib", normLibName);
    if (fs.existsSync(opamLib) && findMlFilesRecursive(opamLib).length > 0) {
      return opamLib;
    }
  }

  return undefined;
} // fn: resolveLibrarySourceDir

/**
 * Recursively discovers all .ml files in a directory, ignoring build and test artifacts.
 *
 * @param dir Directory to search
 * @returns Array of absolute paths to .ml source files
 */
function findMlFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name !== "_build" &&
          entry.name !== ".git" &&
          entry.name !== "node_modules"
        ) {
          results.push(...findMlFilesRecursive(full));
        }
      } else if (entry.isFile() && entry.name.endsWith(".ml")) {
        if (!entry.name.includes(".nano.") && !entry.name.startsWith("test_")) {
          results.push(full);
        }
      }
    }
  } catch {
    // ignore directory read errors
  }
  return results;
} // fn: findMlFilesRecursive

/**
 * Recursively discovers all .mli interface files in a directory.
 *
 * @param dir Directory to search
 * @returns Array of absolute paths to .mli interface files
 */
function findMliFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name !== "_build" &&
          entry.name !== ".git" &&
          entry.name !== "node_modules"
        ) {
          results.push(...findMliFilesRecursive(full));
        }
      } else if (entry.isFile() && entry.name.endsWith(".mli")) {
        results.push(full);
      }
    }
  } catch {
    // ignore directory read errors
  }
  return results;
} // fn: findMliFilesRecursive

export type CoverageManifestEntry = {
  fileId: number;
  filePath: string;
  branchArms: Array<[number, number]>;
};

type VariantConstructor = {
  name: string;
  isPoly: boolean;
  hasPayload: boolean;
  payloadType?: string;
  isTuplePayload?: boolean;
  tuplePayloadTypes?: string[];
  argDef?: ArgDef;
};

/**
 * Extracts variant constructors (nullary or payload-bearing) from an ArgDef or TypeRef map.
 */
function getVariantConstructors(
  cleanType: string,
  argDef?: ArgDef,
  progTypes: Record<string, TypeRef> = {}
): VariantConstructor[] | undefined {
  const bareType = stripOuterParens(cleanType);
  if (
    cleanType.endsWith(" list") ||
    cleanType.endsWith(" array") ||
    cleanType.endsWith(" option") ||
    cleanType.endsWith(" result") ||
    cleanType.endsWith(") result") ||
    cleanType.endsWith(" Result.t") ||
    splitTupleType(bareType).length > 1
  ) {
    return undefined;
  }

  const normType = bareType.startsWith("Target_module.")
    ? bareType.slice("Target_module.".length)
    : bareType;

  if (argDef && argDef.getType() === ArgTag.UNION && argDef.getDim() === 0) {
    const argTypeRef = argDef.getTypeRef();
    if (
      !argTypeRef ||
      argTypeRef === normType ||
      argTypeRef === bareType ||
      bareType.startsWith("[")
    ) {
      const list: VariantConstructor[] = [];
      for (const child of argDef.getChildren()) {
        if (child.getType() === ArgTag.LITERAL) {
          const v = child.getConstantValue();
          const name = typeof v === "string" ? v : child.getName();
          if (name) {
            list.push({
              name,
              isPoly: name.startsWith("`"),
              hasPayload: false,
            });
          }
        } else if (child.getType() === ArgTag.OBJECT) {
          const tagChild = child
            .getChildren()
            .find((c) => c.getName() === "tag");
          const valChild = child
            .getChildren()
            .find((c) => c.getName() === "value");
          const tagVal = tagChild?.getConstantValue();
          const name = typeof tagVal === "string" ? tagVal : child.getName();
          if (name && valChild) {
            const isTuplePayload = valChild.getType() === ArgTag.TUPLE;
            const tuplePayloadTypes = isTuplePayload
              ? valChild
                  .getChildren()
                  .map((c) => OxcamlProgram.getTypeAnnotation(c))
              : undefined;
            list.push({
              name,
              isPoly: name.startsWith("`"),
              hasPayload: true,
              payloadType: OxcamlProgram.getTypeAnnotation(valChild),
              isTuplePayload,
              tuplePayloadTypes,
              argDef: valChild,
            });
          }
        }
      }
      if (list.length > 0) {
        return list;
      }
    }
  }

  const typeDef = progTypes[bareType] ?? progTypes[normType];
  if (typeDef?.type?.type === ArgTag.UNION && typeDef.type.children) {
    const list: VariantConstructor[] = [];
    for (const child of typeDef.type.children) {
      if (child.type?.type === ArgTag.LITERAL) {
        const v = child.type.value;
        const name = typeof v === "string" ? v : (child.name ?? "");
        if (name) {
          list.push({
            name,
            isPoly: name.startsWith("`"),
            hasPayload: false,
          });
        }
      } else if (child.type?.type === ArgTag.OBJECT && child.type.children) {
        const tagChild = child.type.children.find((c) => c.name === "tag");
        const valChild = child.type.children.find((c) => c.name === "value");
        const tagVal = tagChild?.type?.value;
        const name = typeof tagVal === "string" ? tagVal : (child.name ?? "");
        if (name && valChild) {
          const isTuplePayload = valChild.type?.type === ArgTag.TUPLE;
          const tuplePayloadTypes = isTuplePayload
            ? valChild.type?.children?.map((c) => c.typeRefName ?? "int")
            : undefined;
          const payloadType =
            valChild.typeRefName ??
            (isTuplePayload && tuplePayloadTypes
              ? tuplePayloadTypes.join(" * ")
              : "int");
          list.push({
            name,
            isPoly: name.startsWith("`"),
            hasPayload: true,
            payloadType,
            isTuplePayload,
            tuplePayloadTypes,
          });
        }
      }
    }
    if (list.length > 0) {
      return list;
    }
  }

  return undefined;
} // fn: getVariantConstructors
