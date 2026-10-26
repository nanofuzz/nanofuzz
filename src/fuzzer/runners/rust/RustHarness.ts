import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { FileCoverageData } from "istanbul-lib-coverage";
import { RustCompiler, CargoPackage } from "../../compilers/rust/RustCompiler";
import { RustCompilerError } from "../../compilers/Types";
import { RustProgram } from "../../analysis/rust/RustProgram";
import { FuzzEnv } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import * as Config from "../../../Config";
import { parseCoverageScope } from "../../measures/Util";
import { CoverageScopeConfig } from "../../measures/Types";
import { getSanitizerAdapter } from "./sanitizers/Registry";

const HARNESS_TEMPLATE_VER = "RustHarness-0.5.0";

/**
 * Builds and returns the compiled Rust harness binary for testing a target function.
 *
 * @param targetFile Source file containing the target function
 * @param fnName Name of the function to test
 * @param env FuzzEnv containing function definitions and validators
 * @param tmpDir Base temporary directory for compilation outputs
 * @param sanitizer Optional sanitizer to enable (e.g. "borrow")
 * @returns Path to the compiled harness executable, directory, and Istanbul static coverage
 */
export function buildRustHarness(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  tmpDir?: string,
  sanitizer?: string
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
    tmpDir ?? path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "rust");
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

  // Discover local module files for multi-file coverage in project scope
  const userCargoToml = findInAncestor(path.dirname(normTarget), "Cargo.toml");
  let baseDir = path.dirname(normTarget);
  const localModules = RustProgram.findLocalModules(normTarget);

  if (userCargoToml) {
    const crateSrcDir = path.join(path.dirname(userCargoToml), "src");
    if (fs.existsSync(crateSrcDir) && normTarget.startsWith(crateSrcDir)) {
      baseDir = crateSrcDir;
      try {
        const allSrcFiles = fs.readdirSync(crateSrcDir, { recursive: true });
        for (const f of allSrcFiles) {
          if (typeof f === "string" && f.endsWith(".rs")) {
            const full = fs.realpathSync(path.join(crateSrcDir, f));
            if (full !== normTarget && !localModules.includes(full)) {
              localModules.push(full);
            }
          }
        }
      } catch {
        // ignore directory read errors
      }
    }
  }

  // Discover direct external crates if directimports scope is active
  const externalCratesToVendor: CargoPackage[] = [];
  const cratesIoPatches = new Map<string, string>();
  const pathDepOverrides = new Map<string, string>();

  if (scopeConfig.target.includes("directimports") && userCargoToml) {
    const directCrateNames = RustProgram.findDirectCrates(normTarget);
    const localModNames = new Set(
      localModules.map((f) => path.basename(f, ".rs"))
    );
    const candidateCrateNames = directCrateNames.filter(
      (c) => !localModNames.has(c)
    );

    if (candidateCrateNames.length > 0) {
      const metadata = RustCompiler.getCargoMetadata(userCargoToml);
      if (metadata) {
        for (const cName of candidateCrateNames) {
          const pkg = metadata.packages.find((p) => {
            if (p.manifest_path === userCargoToml) return false;
            if (
              p.name === "nanofuzz-runtime" ||
              p.name === "serde" ||
              p.name === "serde_json"
            ) {
              return false;
            }
            const norm = p.name.replace(/-/g, "_");
            if (p.name === cName || norm === cName) return true;
            return p.targets.some(
              (t) => t.name === cName || t.name.replace(/-/g, "_") === cName
            );
          });
          if (pkg && !externalCratesToVendor.some((e) => e.name === pkg.name)) {
            externalCratesToVendor.push(pkg);
          }
        }
      }
    }
  }

  const externalCrateFiles: Array<{
    rsFile: string;
    origPath: string;
    relVendorPath: string;
    pkgName: string;
  }> = [];

  for (const pkg of externalCratesToVendor) {
    const pkgDir = path.dirname(pkg.manifest_path);

    if (pkg.source !== null) {
      cratesIoPatches.set(pkg.name, `vendor/${pkg.name}`);
    } else {
      pathDepOverrides.set(pkg.name, `vendor/${pkg.name}`);
    }

    const pkgSrcDir = path.join(pkgDir, "src");
    const searchDir = fs.existsSync(pkgSrcDir) ? pkgSrcDir : pkgDir;
    const rsFiles = findRsFilesRecursive(searchDir);

    for (const rsFile of rsFiles) {
      const origPath = fs.existsSync(rsFile)
        ? fs.realpathSync(rsFile)
        : path.resolve(rsFile);
      const rel = path.relative(pkgDir, rsFile);
      const relVendorPath = path.join("vendor", pkg.name, rel);
      externalCrateFiles.push({
        rsFile,
        origPath,
        relVendorPath,
        pkgName: pkg.name,
      });
    }
  }

  const allProjectFiles = [
    normTarget,
    ...localModules,
    ...externalCrateFiles.map((e) => e.origPath),
  ];
  let maxMtime = 0;
  for (const pf of allProjectFiles) {
    if (fs.existsSync(pf)) {
      const m = fs.statSync(pf).mtimeMs;
      if (m > maxMtime) maxMtime = m;
    }
  }

  const validators = env?.validators.map((v) => v.name) ?? [];

  const sanitizerName =
    sanitizer ?? Config.get<string>("nanofuzz.rust.sanitizer", "none");
  const sanitizerAdapter = getSanitizerAdapter(sanitizerName);

  if (sanitizerAdapter.id !== "none") {
    const detection = sanitizerAdapter.detect();
    if (!detection.available) {
      throw new RustCompilerError(
        `Rust sanitizer '${sanitizerAdapter.id}' cannot be enabled: ${detection.error ?? "Sanitizer unavailable"}`,
        {
          inputFile: normTarget,
          cargoTomlPath: userCargoToml,
          commandCli: "cargo build",
          output: [
            detection.error ??
              `Rust sanitizer '${sanitizerAdapter.id}' is unavailable on this system.`,
          ],
        }
      );
    }
  }

  const sanitizerBuildConfig = sanitizerAdapter.configureBuild(process.env);
  const cargoBin = RustCompiler.resolveCargo();
  const rustcBin = cargoBin ? RustCompiler.resolveRustc(cargoBin) : undefined;
  const rustcVer = rustcBin
    ? (RustCompiler.getRustcVersion(rustcBin) ?? "")
    : "";

  // Compute a deterministic cache key including all project and external files, compiler version, and sanitizer
  const cacheHash = crypto
    .createHash("md5")
    .update(
      `${allProjectFiles.sort().join(",")}:${fnName}:${validators.sort().join(",")}:${scopeConfig.target}:${HARNESS_TEMPLATE_VER}:${rustcVer}:${sanitizerAdapter.id}`
    )
    .digest("hex")
    .substring(0, 16);

  const sharedTargetDir = path.join(baseTmp, "target");
  const pkgName = `harness_${cacheHash}`;
  const binName = process.platform === "win32" ? `${pkgName}.exe` : pkgName;
  const binaryPath = path.join(sharedTargetDir, "debug", binName);
  const harnessDir = path.join(baseTmp, `harness-${cacheHash}`);

  // Instrument target file (fileId = 0)
  const targetSrc = fs.readFileSync(normTarget, "utf8");
  const targetCov = instrumentRustSource(targetSrc, normTarget, 0);

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

  // Instrument all local module files (fileId = 1, 2, ...)
  const instrumentedModules: Array<{
    instLocalPath: string;
    instrumentedSrc: string;
  }> = [];

  for (let i = 0; i < localModules.length; i++) {
    const localFile = localModules[i];
    const fileId = i + 1;
    const localSrc = fs.readFileSync(localFile, "utf8");
    const localCov = instrumentRustSource(localSrc, localFile, fileId);
    staticCovMap[localFile.replace(/\\/g, "/")] = localCov.staticCov;
    manifestEntries.push({
      fileId,
      filePath: localFile,
      branchArms: localCov.branchArms,
    });

    const rel = path.relative(baseDir, localFile);
    const safeRel = rel.startsWith("..") ? path.basename(localFile) : rel;
    const instLocalPath = path.join(harnessDir, "src", safeRel);
    instrumentedModules.push({
      instLocalPath,
      instrumentedSrc: localCov.instrumentedSrc,
    });
  }

  // Instrument all external crate files (fileId = nextFileId, ...)
  let nextFileId = 1 + localModules.length;
  const vendoredFilesToWrite: Array<{
    destFile: string;
    instrumentedSrc: string;
  }> = [];

  for (const item of externalCrateFiles) {
    const fileId = nextFileId++;
    const extSrc = fs.readFileSync(item.origPath, "utf8");
    const extCov = instrumentRustSource(extSrc, item.origPath, fileId, true);
    staticCovMap[item.origPath.replace(/\\/g, "/")] = extCov.staticCov;
    manifestEntries.push({
      fileId,
      filePath: item.origPath,
      branchArms: extCov.branchArms,
    });
    vendoredFilesToWrite.push({
      destFile: path.join(harnessDir, item.relVendorPath),
      instrumentedSrc: extCov.instrumentedSrc,
    });
  }

  // Return cached binary if it already exists and is up-to-date relative to all project files
  let cachedBinaryPath = binaryPath;
  if (!fs.existsSync(cachedBinaryPath) && fs.existsSync(sharedTargetDir)) {
    const entries = fs.readdirSync(sharedTargetDir);
    for (const entry of entries) {
      const candidate = path.join(sharedTargetDir, entry, "debug", binName);
      if (fs.existsSync(candidate)) {
        cachedBinaryPath = candidate;
        break;
      }
    }
  }

  if (
    fs.existsSync(cachedBinaryPath) &&
    fs.statSync(cachedBinaryPath).mtimeMs >= maxMtime
  ) {
    return {
      binaryPath: cachedBinaryPath,
      harnessDir,
      staticCov: targetCov.staticCov,
      staticCovMap,
    };
  }

  fs.mkdirSync(path.join(harnessDir, "src"), { recursive: true });

  const targetRel = path.relative(baseDir, normTarget);
  const targetRelDir = path.dirname(targetRel);
  const safeTargetRelDir = targetRel.startsWith("..") ? "" : targetRelDir;
  const instTargetPath = path.join(
    harnessDir,
    "src",
    safeTargetRelDir,
    "target_instrumented.rs"
  );
  fs.mkdirSync(path.dirname(instTargetPath), { recursive: true });
  fs.writeFileSync(instTargetPath, targetCov.instrumentedSrc, "utf8");

  // Write instrumented local module files
  for (const mod of instrumentedModules) {
    fs.mkdirSync(path.dirname(mod.instLocalPath), { recursive: true });
    fs.writeFileSync(mod.instLocalPath, mod.instrumentedSrc, "utf8");
  }

  // Vendor external crates and write instrumented external files
  for (const pkg of externalCratesToVendor) {
    const pkgDir = path.dirname(pkg.manifest_path);
    const vendorPkgDir = path.join(harnessDir, "vendor", pkg.name);
    fs.mkdirSync(vendorPkgDir, { recursive: true });
    fs.cpSync(pkgDir, vendorPkgDir, {
      recursive: true,
      filter: (srcPath) => !srcPath.includes(path.sep + "target"),
    });
  }

  for (const vf of vendoredFilesToWrite) {
    fs.mkdirSync(path.dirname(vf.destFile), { recursive: true });
    try {
      fs.chmodSync(vf.destFile, 0o666);
    } catch {
      // ignore chmod errors
    }
    fs.writeFileSync(vf.destFile, vf.instrumentedSrc, "utf8");
  }

  // Locate the nanofuzz-runtime crate
  const runtimeCratePath = findRuntimeCrate();
  if (!runtimeCratePath) {
    throw new Error(
      "Could not find nanofuzz-runtime crate in project or extension build directory"
    );
  }

  // Check for ancestor Cargo.toml to extract user dependencies
  const extraDependencies = userCargoToml
    ? extractCargoDependencies(userCargoToml, pathDepOverrides)
    : "";

  let patchSection = "";
  if (cratesIoPatches.size > 0) {
    const patchLines = Array.from(cratesIoPatches.entries()).map(
      ([name, relPath]) => `${name} = { path = "${relPath}" }`
    );
    patchSection = `\n[patch.crates-io]\n${patchLines.join("\n")}\n`;
  }

  // Write Cargo.toml
  const cargoTomlContent = `[package]
name = "${pkgName}"
version = "0.1.0"
edition = "2021"

[dependencies]
nanofuzz-runtime = { path = "${runtimeCratePath.replace(/\\/g, "/")}" }
nanofuzz_prng = { package = "fastrand", version = "2" }
serde = { version = "1.0", features = ["derive", "rc"] }
serde_json = "1.0"
rmp-serde = "1.3"
${extraDependencies}
${patchSection}
`;
  fs.writeFileSync(
    path.join(harnessDir, "Cargo.toml"),
    cargoTomlContent,
    "utf8"
  );

  // Generate main.rs
  const mainRsContent = generateHarnessSource(
    normTarget,
    fnName,
    env,
    staticCovMap,
    manifestEntries,
    instTargetPath
  );
  fs.writeFileSync(
    path.join(harnessDir, "src", "main.rs"),
    mainRsContent,
    "utf8"
  );

  // Compile with cargo build
  if (!cargoBin) {
    throw new RustCompilerError(
      "Cargo executable not found. Please install Rust or ensure cargo is on PATH.",
      {
        inputFile: normTarget,
        cargoTomlPath: userCargoToml,
        commandCli: "cargo build",
        output: ["Cargo executable not found on PATH or in ~/.cargo/bin."],
      }
    );
  }

  let combinedRustflags = process.env.RUSTFLAGS ?? "";
  if (sanitizerBuildConfig.rustflags.length > 0) {
    combinedRustflags =
      `${combinedRustflags} ${sanitizerBuildConfig.rustflags.join(" ")}`.trim();
  }

  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...sanitizerBuildConfig.env,
    CARGO_TARGET_DIR: sharedTargetDir,
    ...(combinedRustflags ? { RUSTFLAGS: combinedRustflags } : {}),
  };

  const subcmd = sanitizerBuildConfig.cargoCommand ?? ["build"];
  const cargoBuildArgs = [
    ...subcmd,
    "--manifest-path",
    path.join(harnessDir, "Cargo.toml"),
    "--target-dir",
    sharedTargetDir,
    "--message-format=json",
    ...sanitizerBuildConfig.cargoArgs,
  ];

  const buildRes = ChildProcess.spawnSync(cargoBin, cargoBuildArgs, {
    cwd: harnessDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: spawnEnv,
  });

  // Attempt to resolve compiled executable from cargo's artifact messages
  let compiledBinary = binaryPath;
  if (buildRes.stdout) {
    const lines = buildRes.stdout.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          parsed &&
          typeof parsed === "object" &&
          "reason" in parsed &&
          parsed.reason === "compiler-artifact" &&
          "executable" in parsed &&
          typeof parsed.executable === "string" &&
          parsed.executable.length > 0 &&
          path.basename(parsed.executable) === binName
        ) {
          compiledBinary = parsed.executable;
        }
      } catch {
        // ignore non-json lines
      }
    }
  }

  if (buildRes.status !== 0 || !fs.existsSync(compiledBinary)) {
    throw new RustCompilerError("Failed to build Rust fuzzing harness", {
      inputFile: normTarget,
      cargoTomlPath: userCargoToml,
      commandCli: `${cargoBin} ${cargoBuildArgs.join(" ")}`,
      output: [
        buildRes.stderr ||
          buildRes.stdout ||
          "Cargo build failed for test harness",
      ],
    });
  }

  return {
    binaryPath: compiledBinary,
    harnessDir,
    staticCov: targetCov.staticCov,
    staticCovMap,
  };
} // fn: buildRustHarness

/**
 * Generates the Rust harness code that hosts the function under test and property validators.
 */
function generateHarnessSource(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  staticCovMap?: Record<string, FileCoverageData>,
  manifestEntries?: CoverageManifestEntry[],
  instTargetPath?: string
): string {
  const normPath = targetFile.replace(/\\/g, "/");
  const prog = ProgramFactory.fromFile(targetFile, "rust");
  const targetFnDef =
    env?.function?.getName() === fnName
      ? env.function
      : (prog.functions[fnName] ?? env?.function);
  const argDefs = targetFnDef ? targetFnDef.getArgDefs() : [];
  const isVoid = targetFnDef ? targetFnDef.isVoid() : false;
  const isAsync = targetFnDef ? targetFnDef.isAsync() : false;
  const isExported = targetFnDef ? targetFnDef.isExported() : true;

  let shimDef = "";
  if (!isExported) {
    const shimParams: string[] = [];
    const shimCallArgs: string[] = [];
    for (let i = 0; i < argDefs.length; i++) {
      const arg = argDefs[i];
      const typeAnnot = RustProgram.getTypeAnnotation(arg);
      shimParams.push(`arg_${i}: ${typeAnnot}`);
      shimCallArgs.push(`arg_${i}`);
    }
    const retArg = targetFnDef?.getReturnArg();
    const retAnnot = isVoid
      ? ""
      : retArg
        ? ` -> ${RustProgram.getTypeAnnotation(retArg)}`
        : targetFnDef?.getReturnType()?.name
          ? ` -> ${targetFnDef.getReturnType()?.name}`
          : "";
    const asyncKw = isAsync ? "async " : "";
    const awaitSuffix = isAsync ? ".await" : "";
    shimDef = `\n    pub ${asyncKw}fn __nanofuzz_get__(${shimParams.join(", ")})${retAnnot} {\n        ${fnName}(${shimCallArgs.join(", ")})${awaitSuffix}\n    }\n`;
  }

  const argConversions: string[] = [];
  const callArgs: string[] = [];

  for (let i = 0; i < argDefs.length; i++) {
    const arg = argDefs[i];
    const typeAnnot = RustProgram.getTypeAnnotation(arg);

    if (arg.getName() === "prng" || typeAnnot.includes("Fn")) {
      argConversions.push(
        `        let mut rng_opt_${i}: Option<nanofuzz_prng::Rng> = {
            let arg_val = input.args.get(${i});
            let seed_str = arg_val
                .and_then(|v| v.get("seed").and_then(|s| s.as_str()).or_else(|| v.as_str()));
            let seed_num = arg_val
                .and_then(|v| v.get("seed").and_then(|n| n.as_u64()).or_else(|| v.as_u64()));

            if let Some(s) = seed_str {
                let mut h: u64 = 0xcbf29ce484222325;
                for b in s.as_bytes() {
                    h = (h ^ (*b as u64)).wrapping_mul(0x100000001b3);
                }
                Some(nanofuzz_prng::Rng::with_seed(h))
            } else if let Some(n) = seed_num {
                Some(nanofuzz_prng::Rng::with_seed(n))
            } else {
                None
            }
        };
        #[allow(unused_mut)]
        let mut arg_${i} = move || -> f64 {
            match rng_opt_${i}.as_mut() {
                Some(rng) => rng.f64(),
                None => nanofuzz_prng::f64(),
            }
        };`
      );
      if (typeAnnot.startsWith("&")) {
        callArgs.push(`&mut arg_${i}`);
      } else {
        callArgs.push(`arg_${i}`);
      }
      continue;
    }

    const deserInfo = getDeserializationInfo(typeAnnot);

    argConversions.push(
      `        let arg_${i}: ${deserInfo.deserType} = match serde_json::from_value(input.args.get(${i}).cloned().unwrap_or(serde_json::Value::Null)) {
            Ok(v) => v,
            Err(e) => {
                let resp = RunnerResultPayload::Error {
                    name: "DeserializationError".to_string(),
                    message: format!("Argument ${i} deserialization error: {}", e),
                    source: "put",
                    seq: input.seq,
                    validators: None,
                    coverage_data: None,
                };
                write_msg(&rmp_serde::to_vec_named(&resp).unwrap())?;
                continue;
            }
        };`
    );

    callArgs.push(deserInfo.callPrefix + `arg_${i}`);
  }

  const callTarget = isExported
    ? `target::${fnName}`
    : `target::__nanofuzz_get__`;
  const callInvocation = `${callTarget}(${callArgs.join(", ")})`;
  const actualCall = isAsync ? `block_on(${callInvocation})` : callInvocation;

  const fnCallExpr = isVoid
    ? `${actualCall};\n                let json_val = serde_json::Value::Null;`
    : `let ret = ${actualCall};\n                let json_val = serde_json::to_value(&ret).unwrap_or(serde_json::Value::Null);`;

  const validators = env?.validators ?? [];
  const validatorBlocks: string[] = [];

  for (const v of validators) {
    validatorBlocks.push(`
                if input.validators.iter().any(|name| name == "${v.name}") {
                    let ftr = nanofuzz_runtime::FuzzTestResult::new(
                        input.args.clone(),
                        json_val.clone(),
                        false,
                        false,
                    );
                    let v_res = catch_unwind(AssertUnwindSafe(|| {
                        target::${v.name}(&ftr)
                    }));
                    match v_res {
                        Ok(v_out) => {
                            let json_out = serde_json::to_value(&v_out)
                                .unwrap_or_else(|_| serde_json::json!(format!("{:?}", v_out)));
                            vm.insert("${v.name}".to_string(), ValidatorResult::Value { value: json_out });
                        }
                        Err(e) => {
                            if let Some(assump) = e.downcast_ref::<nanofuzz_runtime::UnsatisfiedAssumption>() {
                                vm.insert("${v.name}".to_string(), ValidatorResult::Skip { message: assump.message.clone() });
                            } else {
                                let msg = e.downcast_ref::<String>().cloned()
                                    .or_else(|| e.downcast_ref::<&'static str>().map(|s| s.to_string()))
                                    .unwrap_or_else(|| "validator panic".to_string());
                                vm.insert("${v.name}".to_string(), ValidatorResult::Error { message: msg });
                            }
                        }
                    }
                }`);
  }

  const validatorExecution =
    validatorBlocks.length > 0
      ? `                let mut vm = HashMap::new();
${validatorBlocks.join("\n")}
                let validators_res = if vm.is_empty() { None } else { Some(vm) };`
      : `                let validators_res = None;`;

  const template = getHarnessTemplate();
  const staticCovPayload = JSON.stringify(staticCovMap ?? {});
  const manifestPayload = (
    manifestEntries ?? [{ fileId: 0, filePath: normPath, branchArms: [] }]
  )
    .map(
      (m) =>
        `(${m.fileId}, r#"${m.filePath.replace(/\\/g, "/")}"#, &[${m.branchArms.map(([bId, arms]) => `(${bId}, ${arms})`).join(", ")}])`
    )
    .join(",\n    ");

  let rendered = template
    .replaceAll(
      "/* __NANOFUZZ_TARGET_PATH__ */",
      (instTargetPath ?? targetFile).replace(/\\/g, "/")
    )
    .replaceAll("/* __NANOFUZZ_SHIM__ */", shimDef)
    .replaceAll("/* __NANOFUZZ_COVERAGE_MANIFEST__ */", manifestPayload)
    .replaceAll("/* __NANOFUZZ_STATIC_COV_JSON__ */", staticCovPayload)
    .replaceAll(
      "/* __NANOFUZZ_ARG_CONVERSIONS__ */",
      argConversions.join("\n\n")
    )
    .replaceAll("/* __NANOFUZZ_FN_CALL__ */", fnCallExpr)
    .replaceAll("/* __NANOFUZZ_VALIDATORS__ */", validatorExecution);

  if (shimDef && !template.includes("/* __NANOFUZZ_SHIM__ */")) {
    rendered = rendered.replace(/include!\("[^"]*"\);/, `$&\n${shimDef}`);
  }

  return rendered;
} // fn: generateHarnessSource

/**
 * Instruments Rust source code by inserting statement, function, and branch hit probes,
 * while extracting the Istanbul-compatible static coverage metadata.
 *
 * @param src Target Rust source code
 * @param targetFile Absolute path of the target file
 * @param fileId Optional file identifier for multi-file coverage attribution (default: 0)
 * @param useExternC When true, emits FFI extern C probes for external vendored crates
 * @returns Object with instrumented source code, static coverage, and branch arms
 */
export function instrumentRustSource(
  src: string,
  targetFile: string = "",
  fileId: number = 0,
  useExternC: boolean = false
): {
  instrumentedSrc: string;
  staticCov: FileCoverageData;
  branchArms: Array<[number, number]>;
} {
  const tree = Parser.parse("rust", src);
  if (!tree) {
    throw new Error("Parser failed to parse Rust source for instrumentation");
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

  // Function items
  const fnQuery = Parser.query(
    "rust",
    `
(function_item
  name: (identifier) @fn.name
  body: (block) @fn.body) @fn.item
`
  );
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const m of fnMatches) {
    const itemNode = m.captures.find((c) => c.name === "fn.item")?.node;
    const nameNode = m.captures.find((c) => c.name === "fn.name")?.node;
    const bodyNode = m.captures.find((c) => c.name === "fn.body")?.node;
    if (!itemNode || !nameNode || !bodyNode) continue;

    const currentFIdx = String(fIdx++);
    fnMap[currentFIdx] = {
      name: nameNode.text,
      decl: {
        start: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column,
        },
        end: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column + itemNode.text.length,
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
      line: itemNode.startPosition.row + 1,
    };
    f[currentFIdx] = 0;

    const fnProbe = useExternC
      ? ` unsafe { __nanofuzz_hit_fn(${fileId}, ${currentFIdx}); }; `
      : ` nanofuzz_runtime::coverage::hit_fn(${fileId}, ${currentFIdx}); `;
    insertions.push({
      pos: bodyNode.startIndex + 1,
      text: fnProbe,
    });

    for (let i = 0; i < bodyNode.childCount; i++) {
      const child = bodyNode.child(i);
      if (!child) continue;
      if (
        child.type === "{" ||
        child.type === "}" ||
        child.type === "line_comment" ||
        child.type === "block_comment"
      ) {
        continue;
      }
      const currentSIdx = String(sIdx++);
      statementMap[currentSIdx] = {
        start: {
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        },
        end: {
          line: child.endPosition.row + 1,
          column: child.endPosition.column,
        },
      };
      s[currentSIdx] = 0;
      const stmtProbe = useExternC
        ? `unsafe { __nanofuzz_hit_stmt(${fileId}, ${currentSIdx}); }; `
        : `nanofuzz_runtime::coverage::hit_stmt(${fileId}, ${currentSIdx}); `;
      insertions.push({
        pos: child.startIndex,
        text: stmtProbe,
      });
    }
  }

  // If branches
  const ifQuery = Parser.query(
    "rust",
    `
(if_expression
  consequence: (block) @if.then
  alternative: (else_clause (_)? @if.else)? ) @if.item
`
  );
  const ifMatches = ifQuery.matches(tree.rootNode);
  for (const m of ifMatches) {
    const itemNode = m.captures.find((c) => c.name === "if.item")?.node;
    const thenBlock = m.captures.find((c) => c.name === "if.then")?.node;
    const elseNode = m.captures.find((c) => c.name === "if.else")?.node;
    if (!itemNode || !thenBlock) continue;

    const currentBIdx = String(bIdx++);
    branchArms.push([Number(currentBIdx), 2]);

    const locations = [
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
              line: itemNode.startPosition.row + 1,
              column: itemNode.startPosition.column,
            },
            end: {
              line: itemNode.endPosition.row + 1,
              column: itemNode.endPosition.column,
            },
          },
    ];

    branchMap[currentBIdx] = {
      loc: {
        start: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column,
        },
        end: {
          line: itemNode.endPosition.row + 1,
          column: itemNode.endPosition.column,
        },
      },
      type: "if",
      locations,
      line: itemNode.startPosition.row + 1,
    };
    b[currentBIdx] = [0, 0];

    const branchProbe0 = useExternC
      ? ` unsafe { __nanofuzz_hit_branch(${fileId}, ${currentBIdx}, 0); }; `
      : ` nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 0); `;
    insertions.push({
      pos: thenBlock.startIndex + 1,
      text: branchProbe0,
    });

    if (elseNode) {
      if (elseNode.type === "block") {
        const branchProbe1 = useExternC
          ? ` unsafe { __nanofuzz_hit_branch(${fileId}, ${currentBIdx}, 1); }; `
          : ` nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 1); `;
        insertions.push({
          pos: elseNode.startIndex + 1,
          text: branchProbe1,
        });
      } else if (elseNode.type === "if_expression") {
        const branchProbe1 = useExternC
          ? `{ unsafe { __nanofuzz_hit_branch(${fileId}, ${currentBIdx}, 1); }; `
          : `{ nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 1); `;
        insertions.push({
          pos: elseNode.startIndex,
          text: branchProbe1,
        });
        insertions.push({
          pos: elseNode.endIndex,
          text: ` }`,
        });
      }
    } else {
      const branchProbe1 = useExternC
        ? ` else { unsafe { __nanofuzz_hit_branch(${fileId}, ${currentBIdx}, 1); }; } `
        : ` else { nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 1); } `;
      insertions.push({
        pos: thenBlock.endIndex,
        text: branchProbe1,
      });
    }
  }

  // Match branches
  const matchQuery = Parser.query(
    "rust",
    `
(match_expression
  body: (match_block
    (match_arm) @match.arm)) @match.item
`
  );
  const matchMatches = matchQuery.matches(tree.rootNode);
  const matchGroups = new Map<
    number,
    { itemNode: Parser.SyntaxNode; arms: Parser.SyntaxNode[] }
  >();
  for (const m of matchMatches) {
    const itemNode = m.captures.find((c) => c.name === "match.item")?.node;
    const armNode = m.captures.find((c) => c.name === "match.arm")?.node;
    if (!itemNode || !armNode) continue;
    const line = itemNode.startPosition.row + 1;
    if (!matchGroups.has(line)) {
      matchGroups.set(line, { itemNode, arms: [] });
    }
    matchGroups.get(line)!.arms.push(armNode);
  }

  for (const { itemNode, arms } of matchGroups.values()) {
    const currentBIdx = String(bIdx++);
    branchArms.push([Number(currentBIdx), arms.length]);

    const locations = arms.map((arm) => ({
      start: {
        line: arm.startPosition.row + 1,
        column: arm.startPosition.column,
      },
      end: {
        line: arm.endPosition.row + 1,
        column: arm.endPosition.column,
      },
    }));

    branchMap[currentBIdx] = {
      loc: {
        start: {
          line: itemNode.startPosition.row + 1,
          column: itemNode.startPosition.column,
        },
        end: {
          line: itemNode.endPosition.row + 1,
          column: itemNode.endPosition.column,
        },
      },
      type: "match",
      locations,
      line: itemNode.startPosition.row + 1,
    };
    b[currentBIdx] = arms.map(() => 0);

    for (let j = 0; j < arms.length; j++) {
      const arm = arms[j];
      let valNode: Parser.SyntaxNode | null = null;
      let seenArrow = false;
      for (let i = 0; i < arm.childCount; i++) {
        const c = arm.child(i);
        if (!c) continue;
        if (c.type === "=>") {
          seenArrow = true;
          continue;
        }
        if (seenArrow && c.type !== "," && c.type !== "line_comment") {
          valNode = c;
          break;
        }
      }

      if (valNode) {
        if (valNode.type === "block") {
          const matchArmProbe = useExternC
            ? ` unsafe { __nanofuzz_hit_branch(${fileId}, ${currentBIdx}, ${j}); }; `
            : ` nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, ${j}); `;
          insertions.push({
            pos: valNode.startIndex + 1,
            text: matchArmProbe,
          });
        } else {
          const matchArmProbe = useExternC
            ? `{ unsafe { __nanofuzz_hit_branch(${fileId}, ${currentBIdx}, ${j}); }; `
            : `{ nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, ${j}); `;
          insertions.push({
            pos: valNode.startIndex,
            text: matchArmProbe,
          });
          insertions.push({
            pos: valNode.endIndex,
            text: ` }`,
          });
        }
      }
    }
  }

  // Struct and Enum derive injection (Option A)
  const itemQuery = Parser.query(
    "rust",
    `
[
  (struct_item) @item
  (enum_item) @item
]
`
  );
  const itemMatches = itemQuery.matches(tree.rootNode);
  for (const m of itemMatches) {
    const itemNode = m.captures.find((c) => c.name === "item")?.node;
    if (!itemNode) continue;

    let alreadyDerives = false;
    let prev = itemNode.previousNamedSibling;
    while (prev && prev.type === "attribute_item") {
      const text = prev.text;
      if (text.includes("Serialize") && text.includes("Deserialize")) {
        alreadyDerives = true;
        break;
      }
      prev = prev.previousNamedSibling;
    }

    if (!alreadyDerives) {
      insertions.push({
        pos: itemNode.startIndex,
        text: `#[derive(serde::Serialize, serde::Deserialize)]\n`,
      });
    }
  }

  insertions.sort((a, b) => b.pos - a.pos);
  let instrumentedSrc = src;
  for (const ins of insertions) {
    instrumentedSrc =
      instrumentedSrc.slice(0, ins.pos) +
      ins.text +
      instrumentedSrc.slice(ins.pos);
  }

  if (useExternC) {
    instrumentedSrc += `\n#[allow(dead_code)]\nextern "C" {\n    fn __nanofuzz_hit_stmt(file_id: u32, id: u32);\n    fn __nanofuzz_hit_fn(file_id: u32, id: u32);\n    fn __nanofuzz_hit_branch(file_id: u32, branch_id: u32, arm_id: u32);\n}\n`;
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
} // fn: instrumentRustSource

/**
 * Loads the Rust runner host template source.
 */
function getHarnessTemplate(): string {
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const candidates: string[] = [
    path.join(__dirname, "RustRunnerHost.template.rs"),
    path.resolve(currModuleDir, "RustRunnerHost.template.rs"),
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
        "rust",
        "RustRunnerHost.template.rs"
      ),
      path.join(rootDir, "build", "extension", "RustRunnerHost.template.rs")
    );
  }

  candidates.push(
    path.resolve("./src/fuzzer/runners/rust/RustRunnerHost.template.rs"),
    path.resolve("./build/extension/RustRunnerHost.template.rs")
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }

  throw new Error("Could not find RustRunnerHost.template.rs template file");
} // fn: getHarnessTemplate

/**
 * Resolves parameter type annotation to its deserialization type and call argument prefix.
 */
function getDeserializationInfo(typeAnnot: string): {
  deserType: string;
  callPrefix: string;
} {
  const trimmed = typeAnnot.trim();
  if (trimmed === "&str") {
    return { deserType: "String", callPrefix: "&" };
  }
  if (trimmed.startsWith("&[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(2, -1);
    return { deserType: `Vec<${inner}>`, callPrefix: "&" };
  }
  if (trimmed.startsWith("&")) {
    const inner = trimmed.slice(1).trim();
    return { deserType: inner, callPrefix: "&" };
  }
  return { deserType: trimmed, callPrefix: "" };
} // fn: getDeserializationInfo

/**
 * Finds the local path to the nanofuzz-runtime crate.
 */
function findRuntimeCrate(): string | undefined {
  const currModuleDir = path.dirname(path.resolve(module.filename));
  const projectRoot = findInAncestor(currModuleDir, "package.json");
  const candidates: string[] = [];

  if (projectRoot) {
    const rootDir = path.dirname(projectRoot);
    candidates.push(path.join(rootDir, "packages", "runtime", "rust"));
    candidates.push(
      path.join(rootDir, "build", "extension", "nanofuzz-runtime")
    );
  }

  candidates.push(path.resolve("./packages/runtime/rust"));
  candidates.push(path.resolve("./build/extension/nanofuzz-runtime"));

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "Cargo.toml"))) {
      return c;
    }
  }

  return undefined;
} // fn: findRuntimeCrate

/**
 * Extracts dependencies block from a Cargo.toml file.
 */
function extractCargoDependencies(
  cargoTomlPath: string,
  pathOverrides?: Map<string, string>
): string {
  try {
    const content = fs.readFileSync(cargoTomlPath, "utf8");
    const lines = content.split(/\r?\n/);
    const depLines: string[] = [];
    let inDeps = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inDeps = trimmed === "[dependencies]";
        continue;
      }
      if (inDeps && trimmed.length > 0 && !trimmed.startsWith("#")) {
        if (
          !trimmed.startsWith("nanofuzz-runtime") &&
          !trimmed.startsWith("serde")
        ) {
          const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
          if (match && pathOverrides && pathOverrides.has(match[1])) {
            const overrideRel = pathOverrides.get(match[1])!;
            if (line.includes("path")) {
              depLines.push(
                line.replace(/path\s*=\s*"[^"]+"/, `path = "${overrideRel}"`)
              );
            } else {
              depLines.push(`${match[1]} = { path = "${overrideRel}" }`);
            }
          } else {
            const pathMatch = line.match(/path\s*=\s*"([^"]+)"/);
            if (pathMatch && !path.isAbsolute(pathMatch[1])) {
              const abs = path
                .resolve(path.dirname(cargoTomlPath), pathMatch[1])
                .replace(/\\/g, "/");
              depLines.push(
                line.replace(/path\s*=\s*"[^"]+"/, `path = "${abs}"`)
              );
            } else {
              depLines.push(line);
            }
          }
        }
      }
    }

    return depLines.join("\n");
  } catch {
    return "";
  }
} // fn: extractCargoDependencies

function findRsFilesRecursive(dir: string): string[] {
  const rsFiles: string[] = [];
  if (!fs.existsSync(dir)) return rsFiles;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "target") {
        rsFiles.push(...findRsFilesRecursive(full));
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        rsFiles.push(full);
      }
    }
  } catch {
    // ignore
  }
  return rsFiles;
} // fn: findRsFilesRecursive

type CoverageManifestEntry = {
  fileId: number;
  filePath: string;
  branchArms: Array<[number, number]>;
};
