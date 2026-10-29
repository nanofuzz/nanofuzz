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
import * as Config from "../../../Config";
import { parseCoverageScope } from "../../measures/Util";
import { CoverageScopeConfig } from "../../measures/Types";

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

  // Discover and instrument all project .go files across directories
  const projectFiles = GoProgram.findProjectSourceFiles(normTarget);
  let nextFileId = 1;
  const instrumentedProjectFiles: Array<{ destPath: string; src: string }> = [];

  for (const pFile of projectFiles) {
    const pSrc = fs.readFileSync(pFile, "utf8");
    const fid = nextFileId++;
    const extraction = extractGoStaticCoverage(pSrc, pFile, fid);
    staticCovMap[pFile] = extraction.staticCov;
    manifestEntries.push({
      fileId: fid,
      filePath: pFile,
      branchArms: extraction.branchSpecs,
    });
    const safeBaseName = `proj_${fid}_${path.basename(pFile)}`;
    instrumentedProjectFiles.push({
      destPath: path.join(harnessDir, safeBaseName),
      src: rewritePackageToMain(extraction.instrumentedSrc),
    });
  }

  // Discover and vendor direct external imports if directimports scope is active
  const coverageScopeRaw = Config.get<string>(
    "nanofuzz.fuzzer.coverageScope",
    "project static"
  );
  const scopeConfig: CoverageScopeConfig = parseCoverageScope(coverageScopeRaw);
  const externalModuleReplaces: Map<string, string> = new Map();

  if (scopeConfig.target.includes("directimports")) {
    const directImports = GoProgram.findDirectImports(normTarget);
    if (directImports.length > 0) {
      const userModDir = path.dirname(
        GoProgram.findGoMod(normTarget) ?? normTarget
      );
      const goPath = GoCompiler.resolveGo();
      if (goPath) {
        const directListRes = ChildProcess.spawnSync(
          goPath,
          ["list", "-json", ...directImports],
          {
            cwd: userModDir,
            encoding: "utf-8",
            maxBuffer: 20 * 1024 * 1024,
          }
        );
        if (directListRes.status === 0 && directListRes.stdout) {
          const modPkgs = parseGoListJson(directListRes.stdout);
          const runtimeDir = resolveGoRuntimeDir();
          for (const pkg of modPkgs) {
            if (pkg.Standard || !pkg.Module?.Path || !pkg.Module.Dir) {
              continue;
            }
            if (pkg.Module.Path === "github.com/nanofuzz/runtime") {
              continue;
            }

            let resolvedModDir = pkg.Module.Dir;
            if (
              pkg.Module.Dir.toLowerCase().startsWith(userModDir.toLowerCase())
            ) {
              const rel = pkg.Module.Dir.slice(userModDir.length).replace(
                /^[/\\]+/,
                ""
              );
              resolvedModDir = rel ? path.join(userModDir, rel) : userModDir;
            }

            let resolvedPkgDir = pkg.Dir;
            if (pkg.Dir.toLowerCase().startsWith(userModDir.toLowerCase())) {
              const rel = pkg.Dir.slice(userModDir.length).replace(
                /^[/\\]+/,
                ""
              );
              resolvedPkgDir = rel ? path.join(userModDir, rel) : userModDir;
            }

            const modPath = pkg.Module.Path;
            const modDir = resolvedModDir;
            const safeModRel = path.join(
              "external",
              modPath.replace(/[^a-zA-Z0-9_-]/g, "_")
            );
            const vendorDest = path.join(harnessDir, safeModRel);

            if (!externalModuleReplaces.has(modPath)) {
              copyDirSync(modDir, vendorDest);
              externalModuleReplaces.set(
                modPath,
                `./${safeModRel.replace(/\\/g, "/")}`
              );

              // Update vendored module's go.mod to reference runtime
              const vendoredGoMod = path.join(vendorDest, "go.mod");
              if (fs.existsSync(vendoredGoMod)) {
                let vendoredContent = fs.readFileSync(vendoredGoMod, "utf8");
                vendoredContent += `\nrequire github.com/nanofuzz/runtime v0.0.0\nreplace github.com/nanofuzz/runtime => ${runtimeDir.replace(/\\/g, "/")}\n`;
                fs.writeFileSync(vendoredGoMod, vendoredContent, "utf8");
              }
            }

            // Instrument all .go files in this package directory
            const goFiles = pkg.GoFiles ?? [];
            for (const gf of goFiles) {
              const rawOrigFile = path.join(resolvedPkgDir, gf);
              const origFile = fs.existsSync(rawOrigFile)
                ? fs.realpathSync(rawOrigFile)
                : path.resolve(rawOrigFile);
              const vendoredFile = path.join(
                vendorDest,
                path.relative(modDir, path.join(pkg.Dir, gf))
              );
              if (fs.existsSync(vendoredFile) && !staticCovMap[origFile]) {
                const depSrc = fs.readFileSync(vendoredFile, "utf8");
                const fid = nextFileId++;
                const extraction = extractGoStaticCoverage(
                  depSrc,
                  origFile,
                  fid
                );
                staticCovMap[origFile] = extraction.staticCov;
                manifestEntries.push({
                  fileId: fid,
                  filePath: origFile,
                  branchArms: extraction.branchSpecs,
                });
                fs.writeFileSync(
                  vendoredFile,
                  extraction.instrumentedSrc,
                  "utf8"
                );
              }
            }
          }
        }
      }
    }
  }

  // Write instrumented target file
  const instTargetFile = path.join(harnessDir, "target_inst.go");
  fs.writeFileSync(
    instTargetFile,
    rewritePackageToMain(targetExtraction.instrumentedSrc),
    "utf8"
  );

  // Write instrumented project files
  for (const pf of instrumentedProjectFiles) {
    fs.writeFileSync(pf.destPath, pf.src, "utf8");
  }

  // Generate harness source code
  const pgm = ProgramFactory.fromSource(() => targetSrc, "go", normTarget);
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
  setupHarnessGoMod(harnessDir, normTarget, externalModuleReplaces);

  // Compile the harness
  const goPath = GoCompiler.resolveGo();
  if (!goPath) {
    throw new Error(
      "No Go compiler found. Please ensure 'go' is installed and available on PATH."
    );
  }

  // If external packages are vendored/replaced, run 'go mod tidy -e' to align module requirements
  if (externalModuleReplaces.size > 0) {
    ChildProcess.spawnSync(goPath, ["mod", "tidy", "-e"], {
      cwd: harnessDir,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  const buildArgs = ["build", "-mod=mod", "-o", binaryName, "."];
  const buildRes = ChildProcess.spawnSync(goPath, buildArgs, {
    cwd: harnessDir,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (buildRes.status !== 0) {
    const stderr = buildRes.stderr || buildRes.stdout || "go build failed";
    throw new GoCompilerError(`Go harness build failed:\n${stderr}`, {
      inputFile: harnessFilePath,
      output: stderr.split("\n"),
      commandCli: `${goPath} ${buildArgs.join(" ")}`,
    });
  }

  return {
    binaryPath,
    harnessDir,
    staticCov: targetExtraction.staticCov,
    staticCovMap,
  };
} // fn: buildGoHarness

/**
 * Rewrites Go source code to belong to package main and renames any
 * pre-existing main() function to prevent symbols colliding with the harness main.
 *
 * @param src Original Go source code string
 * @returns Rewritten Go source code
 */
function rewritePackageToMain(src: string): string {
  // Replace package declaration with package main
  let res = src.replace(/\bpackage\s+[a-zA-Z0-9_]+/g, "package main");
  // If source contains func main(), rename it to avoid conflicting with harness main()
  res = res.replace(/\bfunc\s+main\s*\(/g, "func __nanofuzz_orig_main(");
  return res;
} // fn: rewritePackageToMain

/**
 * Creates and writes the go.mod configuration for the harness module,
 * wiring in the nanofuzz runtime replacement, user module dependencies,
 * and external package replacements.
 *
 * @param harnessDir Directory where the harness go.mod is written
 * @param targetFile Target Go file whose ancestor go.mod dependencies to inherit
 * @param externalReplaces Optional map of module paths to local vendored paths
 */
function setupHarnessGoMod(
  harnessDir: string,
  targetFile: string,
  externalReplaces?: Map<string, string>
): void {
  const runtimeDir = resolveGoRuntimeDir();
  const userGoMod = GoProgram.findGoMod(targetFile);

  let userModDeps = "";
  if (userGoMod && fs.existsSync(userGoMod)) {
    const userModDir = path.dirname(userGoMod);
    const userContent = fs.readFileSync(userGoMod, "utf8");
    // Extract require blocks
    const requireMatches = userContent.match(
      /require\s*\([^)]*\)|require\s+[^\n]+/g
    );
    // Extract replace blocks
    const replaceMatches = userContent.match(
      /replace\s*\([^)]*\)|replace\s+[^\n]+/g
    );
    if (requireMatches) userModDeps += "\n" + requireMatches.join("\n");
    if (replaceMatches) {
      for (const rep of replaceMatches) {
        const lines = rep.split("\n");
        const transformedLines = lines.map((line) => {
          // If replaced in externalReplaces, drop it
          if (externalReplaces) {
            for (const extMod of externalReplaces.keys()) {
              if (
                line.includes(`replace ${extMod} `) ||
                line.includes(`${extMod} =>`)
              ) {
                return "";
              }
            }
          }
          // If replace directive contains a relative path => ./... or => ../...
          // resolve it relative to userModDir
          const match = line.match(/(.*?=>\s*)(\.{1,2}\/[^\s\n]+)(.*)/);
          if (match) {
            const prefix = match[1];
            const relPath = match[2];
            const suffix = match[3];
            const absPath = path.resolve(userModDir, relPath);
            return `${prefix}${absPath.replace(/\\/g, "/")}${suffix}`;
          }
          return line;
        });
        const validLines = transformedLines.filter((l) => l.trim().length > 0);
        if (validLines.length > 0) {
          userModDeps += "\n" + validLines.join("\n");
        }
      }
    }
  }

  let extReplaceDirectives = "";
  if (externalReplaces) {
    for (const [modPath, relPath] of externalReplaces.entries()) {
      extReplaceDirectives += `\nrequire ${modPath} v0.0.0\nreplace ${modPath} => ${relPath}\n`;
    }
  }

  const modContent = `module nanofuzz_harness

go 1.22

require github.com/nanofuzz/runtime v0.0.0
replace github.com/nanofuzz/runtime => ${runtimeDir.replace(/\\/g, "/")}
${extReplaceDirectives}
${userModDeps}
`;

  fs.writeFileSync(path.join(harnessDir, "go.mod"), modContent, "utf8");
} // fn: setupHarnessGoMod

/**
 * Resolves the filesystem directory containing the nanofuzz Go runtime module.
 *
 * @returns Absolute directory path to packages/runtime/go
 */
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
    const candidate = path.join(
      path.dirname(root),
      "packages",
      "runtime",
      "go"
    );
    if (fs.existsSync(candidate)) return candidate;
    const builtCand = path.join(
      path.dirname(root),
      "build",
      "extension",
      "nanofuzz-runtime-go"
    );
    if (fs.existsSync(builtCand)) return builtCand;
  }
  return path.resolve("./packages/runtime/go");
} // fn: resolveGoRuntimeDir

/**
 * Loads the Go harness daemon template source file from disk.
 *
 * @returns Template string content of GoRunnerHost.template.go
 */
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

/**
 * Generates the complete Go harness daemon source by injecting arguments conversion,
 * function call invocation, validators execution, and coverage manifest into the template.
 *
 * @param fnName Name of function under test
 * @param fnDef AST function definition metadata
 * @param env Fuzzing environment with validators and transformers
 * @param manifestEntries Coverage manifest records for all tracked source files
 * @param staticCovMap Static coverage map mapping source file paths to FileCoverageData
 * @returns Fully generated harness.go source code
 */
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

  const isGenerator = fnName.endsWith("Generator");
  const isTransformer = fnName.endsWith("Transformer");
  let hasPrng = false;

  for (let i = 0; i < argDefs.length; i++) {
    const arg = argDefs[i];
    const typeAnnot = GoProgram.getTypeAnnotation(arg);
    if (arg.getName() === "prng" || typeAnnot.includes("func()")) {
      hasPrng = true;
      argConversions.push(
        `\t\tvar prngSeed int64 = time.Now().UnixNano() + input.Seq + 1\n\t\tif len(input.Args) > ${i} && input.Args[${i}] != nil {\n\t\t\tif s, ok := input.Args[${i}].(float64); ok {\n\t\t\t\tprngSeed = int64(s)\n\t\t\t} else if m, ok := input.Args[${i}].(map[string]any); ok {\n\t\t\t\tif s, ok := m["seed"].(float64); ok {\n\t\t\t\t\tprngSeed = int64(s)\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t\tr := rand.New(rand.NewSource(prngSeed))\n\t\targ_${i} := func() float64 {\n\t\t\treturn r.Float64()\n\t\t}`
      );
      callArgs.push(`arg_${i}`);
      continue;
    }
    argConversions.push(
      `\t\tvar arg_${i} ${typeAnnot}\n\t\tif len(input.Args) > ${i} && input.Args[${i}] != nil {\n\t\t\trawBytes, _ := json.Marshal(input.Args[${i}])\n\t\t\t_ = json.Unmarshal(rawBytes, &arg_${i})\n\t\t}`
    );
    callArgs.push(`arg_${i}`);
  }

  const isVoid = fnDef?.isVoid() ?? false;
  const returnArg = fnDef?.getReturnArg();
  const isTuple = returnArg?.getType() === ArgTag.TUPLE;

  let fnCallCode: string;
  if (isGenerator) {
    if (isTuple) {
      const count = returnArg?.getChildren().length ?? 2;
      const vars = Array.from({ length: count }, (_, idx) => `r${idx}`);
      const dataVars = vars.slice(0, -1);
      const okVar = vars[vars.length - 1];
      fnCallCode = `\t\t\t${vars.join(", ")} := ${fnName}(${callArgs.join(", ")})\n\t\t\tif !${okVar} {\n\t\t\t\toutVal = nil\n\t\t\t} else {\n\t\t\t\toutVal = []any{${dataVars.join(", ")}}\n\t\t\t}`;
    } else {
      fnCallCode = `\t\t\tr, ok := ${fnName}(${callArgs.join(", ")})\n\t\t\tif !ok {\n\t\t\t\toutVal = nil\n\t\t\t} else {\n\t\t\t\toutVal = []any{r}\n\t\t\t}`;
    }
  } else if (isVoid) {
    fnCallCode = `\t\t\t${fnName}(${callArgs.join(", ")})\n\t\t\toutVal = nil`;
  } else if (isTuple) {
    const childrenCount = returnArg?.getChildren().length ?? 2;
    const retVars = Array.from(
      { length: childrenCount },
      (_, idx) => `r${idx}`
    );
    fnCallCode = `\t\t\t${retVars.join(", ")} := ${fnName}(${callArgs.join(", ")})\n\t\t\toutVal = []any{${retVars.join(", ")}}`;
  } else if (isTransformer) {
    fnCallCode = `\t\t\toutVal = []any{${fnName}(${callArgs.join(", ")})}`;
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
\t\t\t\t\t\t} else if u, ok := r.(*runtime.UnsatisfiedAssumptionError); ok && u != nil {
\t\t\t\t\t\t\tif validatorsRes == nil { validatorsRes = make(map[string]ValidatorResult) }
\t\t\t\t\t\t\tvalidatorsRes["${v.name}"] = ValidatorResult{Tag: "skip", Message: u.Message}
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\trStr := fmt.Sprint(r)
\t\t\t\t\t\t\tlower := strings.ToLower(rStr)
\t\t\t\t\t\t\tif strings.HasPrefix(lower, "unsatisfied assumption") {
\t\t\t\t\t\t\t\tif validatorsRes == nil { validatorsRes = make(map[string]ValidatorResult) }
\t\t\t\t\t\t\t\tprefix := "unsatisfied assumption:"
\t\t\t\t\t\t\t\tvar msg string
\t\t\t\t\t\t\t\tif strings.HasPrefix(lower, prefix) {
\t\t\t\t\t\t\t\t\tmsg = strings.TrimSpace(rStr[len(prefix):])
\t\t\t\t\t\t\t\t} else {
\t\t\t\t\t\t\t\t\tmsg = rStr
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\tvalidatorsRes["${v.name}"] = ValidatorResult{Tag: "skip", Message: msg}
\t\t\t\t\t\t\t} else {
\t\t\t\t\t\t\t\tif validatorsRes == nil { validatorsRes = make(map[string]ValidatorResult) }
\t\t\t\t\t\t\t\tvalidatorsRes["${v.name}"] = ValidatorResult{Tag: "error", Message: rStr}
\t\t\t\t\t\t\t}
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
    .replaceAll(
      "/* __NANOFUZZ_IMPORTS__ */",
      hasPrng ? '\t"math/rand"\n\t"time"\n' : ""
    )
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
        start: {
          line: declNode.startPosition.row + 1,
          column: declNode.startPosition.column,
        },
        end: {
          line: declNode.endPosition.row + 1,
          column: declNode.endPosition.column,
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
    if (
      node.parent?.type === "for_clause" ||
      node.parent?.type === "range_clause"
    ) {
      continue;
    }

    const currentSIdx = sIdx++;
    statementMap[currentSIdx] = {
      start: {
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      },
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
        start: {
          line: stmtNode.startPosition.row + 1,
          column: stmtNode.startPosition.column,
        },
        end: {
          line: stmtNode.endPosition.row + 1,
          column: stmtNode.endPosition.column,
        },
      },
      type: "if",
      locations: [
        {
          start: {
            line: thenBlock.startPosition.row + 1,
            column: thenBlock.startPosition.column,
          },
          end: {
            line: thenBlock.endPosition.row + 1,
            column: thenBlock.endPosition.column,
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
                line: stmtNode.startPosition.row + 1,
                column: stmtNode.startPosition.column,
              },
              end: {
                line: stmtNode.endPosition.row + 1,
                column: stmtNode.endPosition.column,
              },
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
      } else {
        branchProbes.push({
          pos: elseNode.startIndex,
          code: `{\n\tcoverage.HitBranch(${fileId}, ${currentBIdx}, 1)\n\t`,
        });
        branchProbes.push({
          pos: elseNode.endIndex,
          code: `\n}`,
        });
      }
    } else {
      branchProbes.push({
        pos: thenBlock.endIndex,
        code: ` else { coverage.HitBranch(${fileId}, ${currentBIdx}, 1) }`,
      });
    }
  }

  // Branches: switch statements
  const switchQuery = Parser.query(
    "go",
    `[
      (expression_switch_statement)
      (type_switch_statement)
    ] @switch.stmt`
  );

  const switchMatches = switchQuery.matches(tree.rootNode);
  for (const match of switchMatches) {
    const stmtNode = match.captures.find((c) => c.name === "switch.stmt")?.node;
    if (!stmtNode) continue;

    const clauses = stmtNode.descendantsOfType([
      "expression_case",
      "type_case",
      "default_case",
    ]);
    if (clauses.length === 0) continue;

    const currentBIdx = bIdx++;
    const armCount = clauses.length;
    branchSpecs.push({ branchId: currentBIdx, armCount });

    const locations = clauses.map((c) => ({
      start: { line: c.startPosition.row + 1, column: c.startPosition.column },
      end: { line: c.endPosition.row + 1, column: c.endPosition.column },
    }));

    branchMap[currentBIdx] = {
      loc: {
        start: {
          line: stmtNode.startPosition.row + 1,
          column: stmtNode.startPosition.column,
        },
        end: {
          line: stmtNode.endPosition.row + 1,
          column: stmtNode.endPosition.column,
        },
      },
      type: "switch",
      locations,
      line: stmtNode.startPosition.row + 1,
    };
    b[currentBIdx] = new Array(armCount).fill(0);

    for (let armIdx = 0; armIdx < clauses.length; armIdx++) {
      const clause = clauses[armIdx];
      // Find colon token in clause
      let colonPos = clause.startIndex;
      for (let ci = 0; ci < clause.childCount; ci++) {
        const ch = clause.child(ci);
        if (ch?.type === ":") {
          colonPos = ch.endIndex;
          break;
        }
      }
      branchProbes.push({
        pos: colonPos,
        code: `\n\tcoverage.HitBranch(${fileId}, ${currentBIdx}, ${armIdx})\n`,
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
  if (
    allProbes.length > 0 &&
    !instrumentedSrc.includes('"github.com/nanofuzz/runtime/coverage"')
  ) {
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

interface GoPackageInfo {
  Dir: string;
  ImportPath: string;
  Name: string;
  Standard?: boolean;
  GoFiles?: string[];
  Module?: {
    Path: string;
    Dir: string;
    GoMod: string;
  };
}

/**
 * Parses concatenated JSON output objects produced by 'go list -json ...'.
 *
 * @param jsonStream Raw JSON string output from go list
 * @returns Array of parsed package info records
 */
function parseGoListJson(jsonStream: string): GoPackageInfo[] {
  const results: GoPackageInfo[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < jsonStream.length; i++) {
    const ch = jsonStream[i];
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const objStr = jsonStream.slice(start, i + 1);
        const parsed: unknown = JSON.parse(objStr);
        if (isGoPackageInfo(parsed)) {
          results.push(parsed);
        }
        start = -1;
      }
    }
  }

  return results;
} // fn: parseGoListJson

/**
 * Type guard verifying an unknown object conforms to the GoPackageInfo interface.
 *
 * @param val Candidate value to inspect
 * @returns True if value matches GoPackageInfo shape
 */
function isGoPackageInfo(val: unknown): val is GoPackageInfo {
  return (
    typeof val === "object" &&
    val !== null &&
    "Dir" in val &&
    typeof val.Dir === "string" &&
    "ImportPath" in val &&
    typeof val.ImportPath === "string"
  );
} // fn: isGoPackageInfo

/**
 * Recursively copies a directory tree synchronously, omitting .git metadata.
 *
 * @param src Source directory path
 * @param dest Destination directory path
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
} // fn: copyDirSync
