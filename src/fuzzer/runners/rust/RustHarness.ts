import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { RustCompiler } from "../../compilers/rust/RustCompiler";
import { RustCompilerError } from "../../compilers/Types";
import { RustProgram } from "../../analysis/rust/RustProgram";
import { FuzzEnv } from "../../Types";
import { findInAncestor } from "../../Util";

const HARNESS_TEMPLATE_VER = "RustHarness-0.4.0";

/**
 * Builds and returns the compiled Rust harness binary for testing a target function.
 *
 * @param targetFile Source file containing the target function
 * @param fnName Name of the function to test
 * @param env FuzzEnv containing function definitions and validators
 * @param tmpDir Base temporary directory for compilation outputs
 * @returns Path to the compiled harness executable
 */
export function buildRustHarness(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  tmpDir?: string
): { binaryPath: string; harnessDir: string } {
  const normTarget = path.resolve(targetFile);
  if (!fs.existsSync(normTarget)) {
    throw new Error(`Target file does not exist: ${normTarget}`);
  }

  const baseTmp =
    tmpDir ?? path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "rust");
  fs.mkdirSync(baseTmp, { recursive: true });

  const targetMtime = fs.statSync(normTarget).mtimeMs;
  const validators = env?.validators.map((v) => v.name) ?? [];

  // Compute a deterministic cache key
  const cacheHash = crypto
    .createHash("md5")
    .update(
      `${normTarget}:${fnName}:${validators.sort().join(",")}:${HARNESS_TEMPLATE_VER}`
    )
    .digest("hex")
    .substring(0, 16);

  const harnessDir = path.join(baseTmp, `harness-${cacheHash}`);
  const binName =
    process.platform === "win32" ? "nanofuzz_harness.exe" : "nanofuzz_harness";
  const binaryPath = path.join(harnessDir, "target", "debug", binName);

  // Return cached binary if it already exists and is up-to-date relative to source
  if (
    fs.existsSync(binaryPath) &&
    fs.statSync(binaryPath).mtimeMs >= targetMtime
  ) {
    return { binaryPath, harnessDir };
  }

  fs.mkdirSync(path.join(harnessDir, "src"), { recursive: true });

  // Locate the nanofuzz-runtime crate
  const runtimeCratePath = findRuntimeCrate();
  if (!runtimeCratePath) {
    throw new Error(
      "Could not find nanofuzz-runtime crate in project or extension build directory"
    );
  }

  // Check for ancestor Cargo.toml to extract user dependencies
  const userCargoToml = findInAncestor(path.dirname(normTarget), "Cargo.toml");
  const extraDependencies = userCargoToml
    ? extractCargoDependencies(userCargoToml)
    : "";

  // Write Cargo.toml
  const cargoTomlContent = `[package]
name = "nanofuzz_harness"
version = "0.1.0"
edition = "2021"

[dependencies]
nanofuzz-runtime = { path = "${runtimeCratePath.replace(/\\/g, "/")}" }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
${extraDependencies}
`;
  fs.writeFileSync(
    path.join(harnessDir, "Cargo.toml"),
    cargoTomlContent,
    "utf8"
  );

  // Generate main.rs
  const mainRsContent = generateHarnessSource(normTarget, fnName, env);
  fs.writeFileSync(
    path.join(harnessDir, "src", "main.rs"),
    mainRsContent,
    "utf8"
  );

  // Compile with cargo build
  const cargoBin = RustCompiler.resolveCargo();
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

  const buildRes = ChildProcess.spawnSync(
    cargoBin,
    [
      "build",
      "--manifest-path",
      path.join(harnessDir, "Cargo.toml"),
      "--message-format=json",
    ],
    {
      cwd: harnessDir,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }
  );

  if (buildRes.status !== 0 || !fs.existsSync(binaryPath)) {
    throw new RustCompilerError("Failed to build Rust fuzzing harness", {
      inputFile: normTarget,
      cargoTomlPath: userCargoToml,
      commandCli: `${cargoBin} build --manifest-path ${path.join(harnessDir, "Cargo.toml")}`,
      output: [
        buildRes.stderr ||
          buildRes.stdout ||
          "Cargo build failed for test harness",
      ],
    });
  }

  return { binaryPath, harnessDir };
} // fn: buildRustHarness

/**
 * Generates the Rust harness code that hosts the function under test and property validators.
 */
function generateHarnessSource(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv
): string {
  const normPath = targetFile.replace(/\\/g, "/");
  const fnDef = env?.function;
  const argDefs = fnDef ? fnDef.getArgDefs() : [];
  const isVoid = fnDef ? fnDef.isVoid() : false;

  const argConversions: string[] = [];
  const callArgs: string[] = [];

  for (let i = 0; i < argDefs.length; i++) {
    const arg = argDefs[i];
    const typeAnnot = RustProgram.getTypeAnnotation(arg);
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
                };
                write_msg(&serde_json::to_vec(&resp).unwrap())?;
                continue;
            }
        };`
    );

    callArgs.push(deserInfo.callPrefix + `arg_${i}`);
  }

  const fnCallExpr = isVoid
    ? `target::${fnName}(${callArgs.join(", ")});\n                let json_val = serde_json::Value::Null;`
    : `let ret = target::${fnName}(${callArgs.join(", ")});\n                let json_val = serde_json::to_value(&ret).unwrap_or(serde_json::Value::Null);`;

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
  return template
    .replace("/* __NANOFUZZ_TARGET_PATH__ */", normPath)
    .replace("/* __NANOFUZZ_ARG_CONVERSIONS__ */", argConversions.join("\n\n"))
    .replace("/* __NANOFUZZ_FN_CALL__ */", fnCallExpr)
    .replace("/* __NANOFUZZ_VALIDATORS__ */", validatorExecution);
} // fn: generateHarnessSource

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
function extractCargoDependencies(cargoTomlPath: string): string {
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
          depLines.push(line);
        }
      }
    }

    return depLines.join("\n");
  } catch {
    return "";
  }
} // fn: extractCargoDependencies
