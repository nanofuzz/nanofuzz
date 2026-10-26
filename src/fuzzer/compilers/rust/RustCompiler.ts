import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as ChildProcess from "node:child_process";
import * as JSONN from "../../../Jsonn";
import { FuzzStatusUpdater } from "../../Types";
import { findInAncestor } from "../../Util";
import * as Config from "../../../Config";
import {
  CompilerStaleness,
  RustCompilerError,
  RustCompilerErrorDetails,
  RustCompilerDiagnosticSpan,
} from "../Types";
import { RustProgram } from "../../analysis/rust/RustProgram";

/**
 * A Rust compiler wrapper for cargo and rustc.
 */
export class RustCompiler {
  protected _moduleFile: string;
  protected _projectPath: string;
  protected _cargoTomlPath?: string;
  protected _cargoPath?: string;
  protected _rustcPath?: string;
  protected _cargoVersion?: string;
  protected _rustcVersion?: string;
  protected _options: RustCompilerOptions;
  protected static _canExecuteCache: Map<
    string,
    { result: boolean; expiresAt: number }
  > = new Map();
  protected static _metadataCache: Map<
    string,
    { metadata: CargoMetadata; mtimeMs: number }
  > = new Map();

  constructor(fqModulePath: string) {
    this._moduleFile = fqModulePath;

    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    this._cargoTomlPath = findInAncestor(
      path.dirname(this._moduleFile),
      "Cargo.toml"
    );
    this._projectPath = this._cargoTomlPath
      ? path.dirname(this._cargoTomlPath)
      : path.dirname(this._moduleFile);

    this._cargoPath = RustCompiler.resolveCargo();
    this._rustcPath = RustCompiler.resolveRustc(this._cargoPath);
    this._cargoVersion = RustCompiler.getCargoVersion(this._cargoPath);
    this._rustcVersion = RustCompiler.getRustcVersion(this._rustcPath);
    this._options = structuredClone(defaultRustCompilerOptions);
  } // constructor

  /**
   * Gets the current compiler options.
   */
  get options(): RustCompilerOptions {
    return structuredClone(this._options);
  } // get: options

  /**
   * Gets the path to the module file under compilation.
   */
  get moduleFile(): string {
    return this._moduleFile;
  } // get: moduleFile

  /**
   * Gets the path to the ancestor Cargo.toml if within a cargo project.
   */
  get cargoTomlPath(): string | undefined {
    return this._cargoTomlPath;
  } // get: cargoTomlPath

  /**
   * Gets the project directory path.
   */
  get projectPath(): string {
    return this._projectPath;
  } // get: projectPath

  /**
   * Gets the resolved cargo path.
   */
  get cargoPath(): string | undefined {
    return this._cargoPath;
  } // get: cargoPath

  /**
   * Gets the resolved rustc path.
   */
  get rustcPath(): string | undefined {
    return this._rustcPath;
  } // get: rustcPath

  /**
   * Sets the rustc version for testing staleness detection.
   *
   * @param version Rustc version string to simulate
   */
  public setRustcVersionForTest(version: string): void {
    this._rustcVersion = version;
  } // fn: setRustcVersionForTest

  /**
   * Returns clean source file paths for all dependencies required during compilation.
   */
  public getCompiledDependencies(): string[] {
    const deps = [this._moduleFile];
    if (this._cargoTomlPath) {
      const srcDir = path.join(this._projectPath, "src");
      if (fs.existsSync(srcDir)) {
        try {
          const files = fs.readdirSync(srcDir, { recursive: true });
          for (const f of files) {
            if (typeof f === "string" && f.endsWith(".rs")) {
              const full = path.join(srcDir, f);
              if (full !== this._moduleFile && fs.existsSync(full)) {
                deps.push(full);
              }
            }
          }
        } catch {
          // ignore directory read errors
        }
      }
    } else {
      try {
        const localModules = RustProgram.findLocalModules(this._moduleFile);
        for (const modFile of localModules) {
          if (!deps.includes(modFile) && fs.existsSync(modFile)) {
            deps.push(modFile);
          }
        }
      } catch {
        // ignore module discovery errors
      }
    }
    return deps;
  } // fn: getCompiledDependencies

  /**
   * Returns true if any of the source files or configurations have been modified
   * since the most-recent compilation or if no prior compilation has occurred.
   *
   * @param inSrcFile Optional specific source file to check
   * @returns A staleness reason code if re-compilation is needed, or false otherwise.
   */
  public isStale(inSrcFile?: string): CompilerStaleness {
    const compRec = this._getCompilationRecord(this._moduleFile);
    if (!compRec) {
      return "notcompiled";
    }

    const checkFiles =
      inSrcFile !== undefined ? [inSrcFile] : this.getCompiledDependencies();

    for (const file of checkFiles) {
      if (!fs.existsSync(file)) {
        return "notcompiled";
      }
      const mtime = fs.statSync(file).mtime.toISOString();
      if (file === this._moduleFile && compRec.srcDatetime !== mtime) {
        return "sourcechanged";
      }
      if (new Date(mtime) > new Date(compRec.compiledAt)) {
        return "sourcechanged";
      }
    }

    if (this._cargoTomlPath) {
      if (!fs.existsSync(this._cargoTomlPath)) {
        return "configchanged";
      }
      const cargoMtime = fs.statSync(this._cargoTomlPath).mtime.toISOString();
      if (compRec.cargoTomlDatetime !== cargoMtime) {
        return "configchanged";
      }
    }

    const currentCargo = this._cargoPath ?? RustCompiler.resolveCargo();
    if (compRec.cargoPath !== (currentCargo ?? "")) {
      return "compilerchanged";
    }

    const currentRustc =
      this._rustcPath ?? RustCompiler.resolveRustc(currentCargo);
    if (compRec.rustcPath && compRec.rustcPath !== (currentRustc ?? "")) {
      return "compilerchanged";
    }

    const currentCargoVer =
      this._cargoVersion ?? RustCompiler.getCargoVersion(currentCargo);
    if (
      compRec.cargoVersion &&
      currentCargoVer &&
      compRec.cargoVersion !== currentCargoVer
    ) {
      return "compilerchanged";
    }

    const currentRustcVer =
      this._rustcVersion ?? RustCompiler.getRustcVersion(currentRustc);
    if (
      compRec.rustcVersion &&
      currentRustcVer &&
      compRec.rustcVersion !== currentRustcVer
    ) {
      return "compilerchanged";
    }

    return false;
  } // fn: isStale

  /**
   * Compiles and type-checks the Rust module synchronously.
   *
   * @param updateFn Optional status updater callback
   * @returns The path to the compiled module file
   */
  public compileSync(updateFn: FuzzStatusUpdater = () => {}): string {
    updateFn({
      type: "compiling",
      file: path.basename(this._moduleFile),
    });

    const cargo = this._cargoPath ?? RustCompiler.resolveCargo();
    const rustc = this._rustcPath ?? RustCompiler.resolveRustc(cargo);

    if (!cargo && !rustc) {
      throw new RustCompilerError(
        "No Rust compiler found. Please ensure cargo or rustc is installed on PATH or in ~/.cargo/bin.",
        {
          inputFile: this._moduleFile,
          commandCli: "cargo / rustc",
          output: ["No Rust compiler found on PATH or in ~/.cargo/bin."],
        }
      );
    }

    fs.mkdirSync(this._options.tmpDir, { recursive: true });

    let cmd: string;
    let args: string[];
    let cwd: string;
    const rustcVer = this._rustcVersion ?? RustCompiler.getRustcVersion(rustc);
    const runtimeRlib = findRuntimeRlib(this._projectPath, rustcVer);
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };

    if (this._cargoTomlPath && cargo) {
      cmd = cargo;
      args = [
        "check",
        "--manifest-path",
        this._cargoTomlPath,
        "--message-format=json",
      ];
      if (runtimeRlib) {
        const extraFlags = `-L ${path.dirname(runtimeRlib)} --extern nanofuzz_runtime=${runtimeRlib}`;
        spawnEnv.RUSTFLAGS = spawnEnv.RUSTFLAGS
          ? `${spawnEnv.RUSTFLAGS} ${extraFlags}`
          : extraFlags;
      }
      cwd = this._projectPath;
    } else if (rustc) {
      const safeCrateName = path
        .basename(this._moduleFile, ".rs")
        .replace(/[^a-zA-Z0-9_]/g, "_");
      cmd = rustc;
      args = [
        "--edition=2021",
        `--crate-name=${safeCrateName}`,
        "--error-format=json",
        "--crate-type=lib",
        "--out-dir",
        this._options.tmpDir,
      ];
      if (runtimeRlib) {
        args.push(
          "-L",
          path.dirname(runtimeRlib),
          "--extern",
          `nanofuzz_runtime=${runtimeRlib}`
        );
      }
      args.push(this._moduleFile);
      cwd = this._projectPath;
    } else {
      throw new RustCompilerError("Cargo is required for Cargo.toml projects", {
        inputFile: this._moduleFile,
        cargoTomlPath: this._cargoTomlPath,
        commandCli: "cargo",
      });
    }

    const cli = `${cmd} ${args.join(" ")}`;
    const res = ChildProcess.spawnSync(cmd, args, {
      cwd,
      env: spawnEnv,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });

    if (res.status !== 0) {
      const errorDetails = parseRustCompilerOutput(
        res.stdout ?? "",
        res.stderr ?? "",
        this._moduleFile,
        cli,
        this._cargoTomlPath
      );
      throw new RustCompilerError(
        errorDetails.output?.[0] ?? "Rust compilation failed",
        errorDetails
      );
    }

    const compRec = this._newCompilationRecord();
    fs.writeFileSync(
      this._getCompilationRecordFilename(this._moduleFile),
      JSONN.stringify(compRec)
    );

    return this._moduleFile;
  } // fn: compileSync

  /**
   * Compiles the Rust file in the background.
   */
  public async compileAsync(
    fqModulePath: string = this._moduleFile
  ): Promise<void> {
    return RustCompiler.compileAsync(fqModulePath);
  } // fn: compileAsync

  /**
   * Compiles the Rust file asynchronously.
   */
  public static async compileAsync(fqModulePath: string): Promise<void> {
    const compiler = new RustCompiler(fqModulePath);
    await new Promise<void>((resolve, reject) => {
      try {
        compiler.compileSync();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  } // fn: compileAsync

  /**
   * Cleans compilation temp files.
   */
  public static clean(
    tmpDir: string = defaultRustCompilerOptions.tmpDir
  ): void {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore parallel worker cleanup collisions
      }
    }

    const runtimeCrate = findRuntimeCrate();
    if (runtimeCrate) {
      const stamp = path.join(runtimeCrate, "target", ".nanofuzz_rustc_stamp");
      if (fs.existsSync(stamp)) {
        fs.rmSync(stamp, { force: true });
      }
    }
  } // fn: clean

  /**
   * Resolves the cargo executable location.
   */
  public static resolveCargo(
    candidate?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const configured =
      candidate ?? Config.get<string>("nanofuzz.rust.cargoPath", "cargo");

    const candidates: string[] = [];
    if (configured && configured !== "cargo") {
      candidates.push(configured);
    }

    const cargoHome = env?.CARGO_HOME ?? process.env.CARGO_HOME;
    if (cargoHome) {
      candidates.push(
        path.join(
          cargoHome,
          "bin",
          process.platform === "win32" ? "cargo.exe" : "cargo"
        )
      );
    }

    candidates.push(
      path.join(
        os.homedir(),
        ".cargo",
        "bin",
        process.platform === "win32" ? "cargo.exe" : "cargo"
      )
    );

    candidates.push(process.platform === "win32" ? "cargo.exe" : "cargo");

    for (const bin of candidates) {
      if (RustCompiler.canExecute(bin, env)) {
        return bin;
      }
    }

    return undefined;
  } // fn: resolveCargo

  /**
   * Resolves the rustc executable location.
   */
  public static resolveRustc(
    candidateOrCargo?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const candidates: string[] = [];

    if (candidateOrCargo && path.isAbsolute(candidateOrCargo)) {
      const dir = path.dirname(candidateOrCargo);
      candidates.push(
        path.join(dir, process.platform === "win32" ? "rustc.exe" : "rustc")
      );
    }

    const cargoHome = env?.CARGO_HOME ?? process.env.CARGO_HOME;
    if (cargoHome) {
      candidates.push(
        path.join(
          cargoHome,
          "bin",
          process.platform === "win32" ? "rustc.exe" : "rustc"
        )
      );
    }

    candidates.push(
      path.join(
        os.homedir(),
        ".cargo",
        "bin",
        process.platform === "win32" ? "rustc.exe" : "rustc"
      )
    );

    candidates.push(process.platform === "win32" ? "rustc.exe" : "rustc");

    for (const bin of candidates) {
      if (RustCompiler.canExecute(bin, env)) {
        return bin;
      }
    }

    return undefined;
  } // fn: resolveRustc

  /**
   * Returns the version string for cargo (e.g. from `cargo --version`).
   */
  public static getCargoVersion(
    cargoBin?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const bin = cargoBin ?? RustCompiler.resolveCargo(undefined, env);
    if (!bin) return undefined;
    const res = ChildProcess.spawnSync(bin, ["--version"], {
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    if (res.error) {
      throw res.error;
    }
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
    return undefined;
  } // fn: getCargoVersion

  /**
   * Returns the version string for rustc (e.g. from `rustc --version`).
   */
  public static getRustcVersion(
    rustcBin?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const bin = rustcBin ?? RustCompiler.resolveRustc(undefined, env);
    if (!bin) return undefined;
    const res = ChildProcess.spawnSync(bin, ["--version"], {
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    if (res.error) {
      throw res.error;
    }
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
    return undefined;
  } // fn: getRustcVersion

  /**
   * Probes whether an executable can be spawned successfully.
   */
  public static canExecute(
    bin: string,
    env?: Record<string, string | undefined>
  ): boolean {
    const pathVal = env?.PATH ?? process.env.PATH ?? "";
    const cacheKey = `${bin}:${pathVal}`;
    const cached = RustCompiler._canExecuteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    let result: boolean;
    try {
      const res = ChildProcess.spawnSync(bin, ["--version"], {
        env: env ? { ...process.env, ...env } : process.env,
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
      result = res.status === 0;
    } catch {
      result = false;
    }

    RustCompiler._canExecuteCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + 60000,
    });

    return result;
  } // fn: canExecute

  /**
   * Retrieves cargo metadata for a given Cargo.toml manifest, with caching.
   *
   * @param cargoTomlPath Absolute path to Cargo.toml
   * @returns Parsed CargoMetadata object or undefined on failure
   */
  public static getCargoMetadata(
    cargoTomlPath: string
  ): CargoMetadata | undefined {
    if (!fs.existsSync(cargoTomlPath)) {
      return undefined;
    }
    const realToml = fs.realpathSync(cargoTomlPath);
    const mtime = fs.statSync(realToml).mtimeMs;
    const cached = RustCompiler._metadataCache.get(realToml);
    if (cached && cached.mtimeMs === mtime) {
      return cached.metadata;
    }

    const cargoBin = RustCompiler.resolveCargo();
    if (!cargoBin) {
      return undefined;
    }

    try {
      const res = ChildProcess.spawnSync(
        cargoBin,
        ["metadata", "--format-version", "1", "--manifest-path", realToml],
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 10000,
        }
      );
      if (res.status === 0 && res.stdout) {
        const parsed: unknown = JSON.parse(res.stdout);
        if (isCargoMetadata(parsed)) {
          RustCompiler._metadataCache.set(realToml, {
            metadata: parsed,
            mtimeMs: mtime,
          });
          return parsed;
        }
      }
    } catch {
      // ignore metadata failure
    }
    return undefined;
  } // fn: getCargoMetadata

  protected _getCompilationRecordFilename(moduleFile: string): string {
    const hash = crypto
      .createHash("md5")
      .update(moduleFile)
      .digest("hex")
      .substring(0, 12);
    const base = path.basename(moduleFile, ".rs");
    return path.join(this._options.tmpDir, `${base}-${hash}.comp.json5`);
  } // fn: _getCompilationRecordFilename

  protected _getCompilationRecord(
    moduleFile: string
  ): RustCompilationRecord | undefined {
    const compRecFile = this._getCompilationRecordFilename(moduleFile);
    try {
      if (fs.existsSync(compRecFile)) {
        const compRecRaw = JSONN.parse(fs.readFileSync(compRecFile).toString());
        if (isRustCompilationRecord(compRecRaw)) {
          return compRecRaw;
        }
      }
    } catch {
      // ignore read/parse errors
    }
    return undefined;
  } // fn: _getCompilationRecord

  protected _newCompilationRecord(): RustCompilationRecord {
    const srcMtime = fs.statSync(this._moduleFile).mtime.toISOString();
    const cargoTomlMtime = this._cargoTomlPath
      ? fs.statSync(this._cargoTomlPath).mtime.toISOString()
      : undefined;

    return {
      fileVersion: "RustCompilationRecord-0.4.1",
      srcFile: this._moduleFile,
      srcDatetime: srcMtime,
      cargoTomlFile: this._cargoTomlPath,
      cargoTomlDatetime: cargoTomlMtime,
      cargoPath: this._cargoPath ?? "",
      cargoVersion: this._cargoVersion,
      rustcPath: this._rustcPath ?? "",
      rustcVersion: this._rustcVersion,
      compiledAt: new Date().toISOString(),
    };
  } // fn: _newCompilationRecord
} // class: RustCompiler

// ============================================================================
// Helper Functions & Types
// ============================================================================

export type RustCompilerOptions = {
  tmpDir: string;
};

const defaultRustCompilerOptions: RustCompilerOptions = {
  tmpDir: path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "rust"),
};

type RustCompilationRecord = {
  fileVersion: string;
  srcFile: string;
  srcDatetime: string;
  cargoTomlFile?: string;
  cargoTomlDatetime?: string;
  cargoPath: string;
  cargoVersion?: string;
  rustcPath: string;
  rustcVersion?: string;
  compiledAt: string;
};

function isRustCompilationRecord(obj: unknown): obj is RustCompilationRecord {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    "fileVersion" in obj &&
    (obj.fileVersion === "RustCompilationRecord-0.4.1" ||
      obj.fileVersion === "RustCompilationRecord-0.4.0") &&
    "srcFile" in obj &&
    "srcDatetime" in obj &&
    "compiledAt" in obj
  );
} // fn: isRustCompilationRecord

function parseRustCompilerOutput(
  stdout: string,
  stderr: string,
  inputFile: string,
  commandCli: string,
  cargoTomlPath?: string
): RustCompilerErrorDetails {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/);

  const diagnostics: RustCompilerErrorDetails["diagnostics"] = [];
  const renderedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      if (trimmed.length > 0 && !trimmed.startsWith("warning:")) {
        renderedLines.push(trimmed);
      }
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const diag = parsed.message ?? parsed;
      if (diag && (diag.level === "error" || parsed.level === "error")) {
        const level = diag.level ?? parsed.level ?? "error";
        const msg = diag.message ?? parsed.message ?? "Rust compilation error";
        const code = diag.code?.code ?? parsed.code?.code;
        const rendered = diag.rendered ?? parsed.rendered;

        let primarySpan: RustCompilerDiagnosticSpan | undefined = undefined;
        const spans = diag.spans ?? parsed.spans;
        if (Array.isArray(spans)) {
          const primary = spans.find((s) => s.is_primary) ?? spans[0];
          if (primary) {
            primarySpan = {
              file: primary.file_name,
              lineStart: primary.line_start,
              lineEnd: primary.line_end,
              colStart: primary.column_start,
              colEnd: primary.column_end,
            };
          }
        }

        diagnostics.push({
          message: msg,
          level,
          code,
          span: primarySpan,
          rendered,
        });

        if (rendered) {
          renderedLines.push(rendered);
        } else {
          renderedLines.push(msg);
        }
      }
    } catch {
      if (trimmed.length > 0) {
        renderedLines.push(trimmed);
      }
    }
  }

  const output =
    renderedLines.length > 0
      ? renderedLines
      : [stderr || stdout || "Rust compilation failed"];

  return {
    inputFile,
    cargoTomlPath,
    configFilename: cargoTomlPath,
    commandCli,
    cli: commandCli,
    output,
    diagnostics,
  };
} // fn: parseRustCompilerOutput

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

function findRuntimeRlib(
  userProjectPath?: string,
  rustcVer?: string
): string | undefined {
  const runtimeCrate = findRuntimeCrate();
  if (runtimeCrate && rustcVer) {
    const targetDir = path.join(runtimeCrate, "target");
    const stampFile = path.join(targetDir, ".nanofuzz_rustc_stamp");
    let needsRebuild = true;

    if (fs.existsSync(stampFile)) {
      const recordedVer = fs.readFileSync(stampFile, "utf8").trim();
      if (recordedVer === rustcVer.trim()) {
        needsRebuild = false;
      }
    }

    if (needsRebuild) {
      const cargo = RustCompiler.resolveCargo();
      if (cargo) {
        const res = ChildProcess.spawnSync(
          cargo,
          ["build", "--manifest-path", path.join(runtimeCrate, "Cargo.toml")],
          {
            cwd: runtimeCrate,
            stdio: "ignore",
            windowsHide: true,
            timeout: 60000,
          }
        );
        if (res.status === 0) {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(stampFile, rustcVer.trim(), "utf8");
        }
      }
    }
  }

  const currModuleDir = path.dirname(path.resolve(module.filename));
  const projectRoot = findInAncestor(currModuleDir, "package.json");
  const candidates: string[] = [];

  if (userProjectPath) {
    candidates.push(path.join(userProjectPath, "target", "debug", "deps"));
  }

  if (projectRoot) {
    const rootDir = path.dirname(projectRoot);
    candidates.push(
      path.join(
        rootDir,
        "packages",
        "runtime",
        "rust",
        "target",
        "debug",
        "deps"
      ),
      path.join(
        rootDir,
        "build",
        "extension",
        "nanofuzz-runtime",
        "target",
        "debug",
        "deps"
      )
    );
  }

  candidates.push(
    path.resolve("./packages/runtime/rust/target/debug/deps"),
    path.resolve("./build/extension/nanofuzz-runtime/target/debug/deps")
  );

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        const rlib = files.find(
          (f) => f.startsWith("libnanofuzz_runtime") && f.endsWith(".rlib")
        );
        if (rlib) {
          return path.join(dir, rlib);
        }
      } catch {
        // ignore read error
      }
    }
  }

  return undefined;
} // fn: findRuntimeRlib

export type CargoPackageTarget = {
  kind: string[];
  name: string;
  src_path: string;
};

export type CargoPackage = {
  name: string;
  version: string;
  manifest_path: string;
  source: string | null;
  targets: CargoPackageTarget[];
  dependencies?: Array<{ name: string; path?: string }>;
};

export type CargoMetadata = {
  packages: CargoPackage[];
  workspace_root: string;
};

function isCargoMetadata(obj: unknown): obj is CargoMetadata {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    "packages" in obj &&
    Array.isArray(obj.packages)
  );
} // fn: isCargoMetadata
