import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import { FileCoverageData } from "istanbul-lib-coverage";
import { RustCompiler } from "../../compilers/rust/RustCompiler";
import { RustCompilerError } from "../../compilers/Types";
import { RustProgram } from "../../analysis/rust/RustProgram";
import { FuzzEnv } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Parser from "../../adapters/ParserAdapter";
import * as ProgramFactory from "../../analysis/ProgramFactory";

const HARNESS_TEMPLATE_VER = "RustHarness-0.4.5";

/**
 * Builds and returns the compiled Rust harness binary for testing a target function.
 *
 * @param targetFile Source file containing the target function
 * @param fnName Name of the function to test
 * @param env FuzzEnv containing function definitions and validators
 * @param tmpDir Base temporary directory for compilation outputs
 * @returns Path to the compiled harness executable, directory, and Istanbul static coverage
 */
export function buildRustHarness(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  tmpDir?: string
): {
  binaryPath: string;
  harnessDir: string;
  staticCov: FileCoverageData;
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

  const targetSrc = fs.readFileSync(normTarget, "utf8");
  const { instrumentedSrc, staticCov, branchArms } = instrumentRustSource(
    targetSrc,
    normTarget
  );

  // Return cached binary if it already exists and is up-to-date relative to source
  if (
    fs.existsSync(binaryPath) &&
    fs.statSync(binaryPath).mtimeMs >= targetMtime
  ) {
    return { binaryPath, harnessDir, staticCov };
  }

  fs.mkdirSync(path.join(harnessDir, "src"), { recursive: true });

  const instTargetPath = path.join(harnessDir, "src", "target_instrumented.rs");
  fs.writeFileSync(instTargetPath, instrumentedSrc, "utf8");

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
  const mainRsContent = generateHarnessSource(
    normTarget,
    fnName,
    env,
    staticCov,
    branchArms,
    instTargetPath
  );
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

  return { binaryPath, harnessDir, staticCov };
} // fn: buildRustHarness

/**
 * Generates the Rust harness code that hosts the function under test and property validators.
 */
function generateHarnessSource(
  targetFile: string,
  fnName: string,
  env?: FuzzEnv,
  staticCov?: FileCoverageData,
  branchArms?: Array<[number, number]>,
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

  const argConversions: string[] = [];
  const callArgs: string[] = [];

  for (let i = 0; i < argDefs.length; i++) {
    const arg = argDefs[i];
    const typeAnnot = RustProgram.getTypeAnnotation(arg);

    if (arg.getName() === "prng" || typeAnnot.includes("Fn")) {
      argConversions.push(
        `        let mut seed_val_${i}: u64 = {
            let mut h: u64 = 0x811c9dc5;
            if let Some(seed_str) = input.args.get(${i}).and_then(|v| v.get("seed")).and_then(|s| s.as_str()) {
                for b in seed_str.as_bytes() {
                    h = h.wrapping_mul(0x100000001b3).wrapping_add(*b as u64);
                }
            } else {
                h = 123456789;
            }
            h
        };
        let mut arg_${i} = move || -> f64 {
            seed_val_${i} = seed_val_${i}.wrapping_add(0x9e3779b97f4a7c15);
            let mut z = seed_val_${i};
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
            let val = z ^ (z >> 31);
            (val as f64) / (u64::MAX as f64)
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
                write_msg(&serde_json::to_vec(&resp).unwrap())?;
                continue;
            }
        };`
    );

    callArgs.push(deserInfo.callPrefix + `arg_${i}`);
  }

  const callInvocation = `target::${fnName}(${callArgs.join(", ")})`;
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
  const staticCovMap = {
    [normPath]: staticCov ?? {
      path: normPath,
      statementMap: {},
      fnMap: {},
      branchMap: {},
      s: {},
      f: {},
      b: {},
    },
  };
  const staticCovPayload = JSON.stringify(staticCovMap);
  const branchArmsPayload = (branchArms ?? [])
    .map(([bId, arms]) => `(${bId}, ${arms})`)
    .join(", ");

  return template
    .replaceAll(
      "/* __NANOFUZZ_TARGET_PATH__ */",
      (instTargetPath ?? targetFile).replace(/\\/g, "/")
    )
    .replaceAll("/* __NANOFUZZ_REAL_PATH__ */", normPath)
    .replaceAll("/* __NANOFUZZ_BRANCH_ARMS__ */", branchArmsPayload)
    .replaceAll("/* __NANOFUZZ_STATIC_COV_JSON__ */", staticCovPayload)
    .replaceAll(
      "/* __NANOFUZZ_ARG_CONVERSIONS__ */",
      argConversions.join("\n\n")
    )
    .replaceAll("/* __NANOFUZZ_FN_CALL__ */", fnCallExpr)
    .replaceAll("/* __NANOFUZZ_VALIDATORS__ */", validatorExecution);
} // fn: generateHarnessSource

/**
 * Instruments Rust source code by inserting statement, function, and branch hit probes,
 * while extracting the Istanbul-compatible static coverage metadata.
 *
 * @param src Target Rust source code
 * @param targetFile Absolute path of the target file
 * @param fileId Optional file identifier for multi-file coverage attribution (default: 0)
 * @returns Object with instrumented source code, static coverage, and branch arms
 */
export function instrumentRustSource(
  src: string,
  targetFile: string = "",
  fileId: number = 0
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

  // 1. Function items
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

    insertions.push({
      pos: bodyNode.startIndex + 1,
      text: ` nanofuzz_runtime::coverage::hit_fn(${fileId}, ${currentFIdx}); `,
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
      insertions.push({
        pos: child.startIndex,
        text: `nanofuzz_runtime::coverage::hit_stmt(${fileId}, ${currentSIdx}); `,
      });
    }
  }

  // 2. If branches
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

    insertions.push({
      pos: thenBlock.startIndex + 1,
      text: ` nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 0); `,
    });

    if (elseNode) {
      if (elseNode.type === "block") {
        insertions.push({
          pos: elseNode.startIndex + 1,
          text: ` nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 1); `,
        });
      } else if (elseNode.type === "if_expression") {
        insertions.push({
          pos: elseNode.startIndex,
          text: `{ nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 1); `,
        });
        insertions.push({
          pos: elseNode.endIndex,
          text: ` }`,
        });
      }
    } else {
      insertions.push({
        pos: thenBlock.endIndex,
        text: ` else { nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, 1); } `,
      });
    }
  }

  // 3. Match branches
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
          insertions.push({
            pos: valNode.startIndex + 1,
            text: ` nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, ${j}); `,
          });
        } else {
          insertions.push({
            pos: valNode.startIndex,
            text: `{ nanofuzz_runtime::coverage::hit_branch(${fileId}, ${currentBIdx}, ${j}); `,
          });
          insertions.push({
            pos: valNode.endIndex,
            text: ` }`,
          });
        }
      }
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
