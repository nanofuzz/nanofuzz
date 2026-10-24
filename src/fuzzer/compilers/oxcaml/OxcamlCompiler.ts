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
  OxcamlCompilerError,
  OxcamlCompilerErrorDetails,
} from "../Types";

/**
 * An OCaml / OxCaml compiler wrapper for Dune and ocamlopt.
 */
export class OxcamlCompiler {
  protected _moduleFile: string;
  protected _projectPath: string;
  protected _duneProjectPath?: string;
  protected _dunePath?: string;
  protected _ocamloptPath?: string;
  protected _options: OxcamlCompilerOptions;
  protected static _canExecuteCache: Map<
    string,
    { result: boolean; expiresAt: number }
  > = new Map();

  /**
   * Constructs an OxcamlCompiler for the given module file.
   *
   * @param fqModulePath Absolute path to the source file to compile
   */
  constructor(fqModulePath: string) {
    this._moduleFile = fqModulePath;

    if (!fs.existsSync(fqModulePath)) {
      throw new Error(`Cannot find module to compile: ${fqModulePath}`);
    }

    const duneProject = findInAncestor(
      path.dirname(this._moduleFile),
      "dune-project"
    );
    const duneFile = findInAncestor(path.dirname(this._moduleFile), "dune");
    this._duneProjectPath = duneProject ?? duneFile;
    this._projectPath = this._duneProjectPath
      ? path.dirname(this._duneProjectPath)
      : path.dirname(this._moduleFile);

    this._dunePath = OxcamlCompiler.resolveDune();
    this._ocamloptPath = OxcamlCompiler.resolveOcamlopt();
    this._options = structuredClone(defaultOxcamlCompilerOptions);
  } // constructor

  /**
   * Gets the current compiler options.
   */
  get options(): OxcamlCompilerOptions {
    return structuredClone(this._options);
  } // get: options

  /**
   * Gets the path to the module file under compilation.
   */
  get moduleFile(): string {
    return this._moduleFile;
  } // get: moduleFile

  /**
   * Gets the path to the ancestor dune-project or dune file if within a Dune project.
   */
  get duneProjectPath(): string | undefined {
    return this._duneProjectPath;
  } // get: duneProjectPath

  /**
   * Gets the project directory path.
   */
  get projectPath(): string {
    return this._projectPath;
  } // get: projectPath

  /**
   * Gets the resolved dune executable path.
   */
  get dunePath(): string | undefined {
    return this._dunePath;
  } // get: dunePath

  /**
   * Gets the resolved ocamlopt executable path.
   */
  get ocamloptPath(): string | undefined {
    return this._ocamloptPath;
  } // get: ocamloptPath

  /**
   * Returns clean source file paths for all dependencies required during compilation.
   *
   * @returns Array of source file paths
   */
  public getCompiledDependencies(): string[] {
    const deps = [this._moduleFile];

    // Companion interface file
    if (this._moduleFile.endsWith(".ml")) {
      const mli = `${this._moduleFile.slice(0, -3)}.mli`;
      if (fs.existsSync(mli)) {
        deps.push(mli);
      }
    }

    if (this._duneProjectPath) {
      const searchDirs = [
        path.join(this._projectPath, "src"),
        path.join(this._projectPath, "lib"),
        this._projectPath,
      ];
      for (const dir of searchDirs) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir, { recursive: true });
            for (const f of files) {
              if (
                typeof f === "string" &&
                (f.endsWith(".ml") || f.endsWith(".mli"))
              ) {
                const full = path.join(dir, f);
                if (!deps.includes(full) && fs.existsSync(full)) {
                  deps.push(full);
                }
              }
            }
          } catch {
            // ignore directory read errors
          }
        }
      }
    }

    return deps;
  } // fn: getCompiledDependencies

  /**
   * Returns true if any of the source files or configurations have been modified
   * since the most-recent compilation or if no prior compilation has occurred.
   *
   * @param inSrcFile Optional specific source file to check
   * @returns A staleness reason code if re-compilation is needed, or false otherwise
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

    if (this._duneProjectPath) {
      if (!fs.existsSync(this._duneProjectPath)) {
        return "configchanged";
      }
      const duneMtime = fs.statSync(this._duneProjectPath).mtime.toISOString();
      if (compRec.duneProjectDatetime !== duneMtime) {
        return "configchanged";
      }
    }

    const currentDune = this._dunePath ?? OxcamlCompiler.resolveDune();
    if (compRec.dunePath !== (currentDune ?? "")) {
      return "compilerchanged";
    }

    return false;
  } // fn: isStale

  /**
   * Compiles and type-checks the OCaml module synchronously.
   *
   * @param updateFn Optional status updater callback
   * @returns The path to the compiled module file
   */
  public compileSync(updateFn: FuzzStatusUpdater = () => {}): string {
    updateFn({
      type: "compiling",
      file: path.basename(this._moduleFile),
    });

    const dune = this._dunePath ?? OxcamlCompiler.resolveDune();
    const ocamlopt = this._ocamloptPath ?? OxcamlCompiler.resolveOcamlopt();

    if (!dune && !ocamlopt) {
      throw new OxcamlCompilerError(
        "No OCaml/OxCaml compiler found. Please ensure dune or ocamlopt is installed on PATH or in an active opam switch.",
        {
          inputFile: this._moduleFile,
          commandCli: "dune / ocamlopt",
          output: ["No OCaml compiler found on PATH or in ~/.opam/*/bin."],
        }
      );
    }

    fs.mkdirSync(this._options.tmpDir, { recursive: true });

    let cmd: string;
    let args: string[];
    let cwd: string;
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };

    const binDir = dune
      ? path.dirname(dune)
      : ocamlopt
        ? path.dirname(ocamlopt)
        : "";
    if (binDir) {
      const pathKey =
        Object.keys(process.env).find((k) => k.toLowerCase() === "path") ||
        "PATH";
      spawnEnv[pathKey] =
        `${binDir}${path.delimiter}${process.env[pathKey] || ""}`;
    }

    if (this._duneProjectPath && dune) {
      cmd = dune;
      args = ["build", "@check"];
      cwd = this._projectPath;
    } else if (ocamlopt) {
      cmd = ocamlopt;
      args = ["-c", "-w", "-33-26-27-32-34-37-39"];
      const incDirs = findRuntimeIncludeDirs();
      for (const inc of incDirs) {
        args.push("-I", inc);
      }
      args.push(this._moduleFile);
      cwd = this._projectPath;
    } else if (dune) {
      cmd = dune;
      args = ["build", "@check"];
      cwd = this._projectPath;
    } else {
      throw new OxcamlCompilerError("Failed to determine compiler command", {
        inputFile: this._moduleFile,
        commandCli: "dune / ocamlopt",
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
      const errorDetails = parseOxcamlCompilerOutput(
        res.stdout ?? "",
        res.stderr ?? "",
        this._moduleFile,
        cli,
        this._duneProjectPath
      );
      throw new OxcamlCompilerError(
        errorDetails.output?.[0] ?? "OCaml compilation failed",
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
   * Compiles the OCaml file in the background.
   *
   * @param fqModulePath Optional module path override
   */
  public async compileAsync(
    fqModulePath: string = this._moduleFile
  ): Promise<void> {
    return OxcamlCompiler.compileAsync(fqModulePath);
  } // fn: compileAsync

  /**
   * Compiles the OCaml file asynchronously.
   *
   * @param fqModulePath Absolute path to source file to compile
   */
  public static async compileAsync(fqModulePath: string): Promise<void> {
    const compiler = new OxcamlCompiler(fqModulePath);
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
   *
   * @param tmpDir Directory path to clean
   */
  public static clean(
    tmpDir: string = defaultOxcamlCompilerOptions.tmpDir
  ): void {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore parallel cleanup collisions
      }
    }
  } // fn: clean

  /**
   * Resolves the dune executable location.
   *
   * @param candidate Optional explicit candidate path
   * @param env Optional environment map
   * @returns Path to dune executable or undefined
   */
  public static resolveDune(
    candidate?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const configured =
      candidate ?? Config.get<string>("nanofuzz.oxcaml.dunePath", "dune");

    const candidates: string[] = [];
    if (configured && configured !== "dune") {
      candidates.push(configured);
    }

    const switchPrefix =
      env?.OPAM_SWITCH_PREFIX ?? process.env.OPAM_SWITCH_PREFIX;
    const duneBinName = process.platform === "win32" ? "dune.exe" : "dune";

    if (switchPrefix) {
      candidates.push(path.join(switchPrefix, "bin", duneBinName));
    }

    const home = os.homedir();
    if (home) {
      const opamDir = path.join(home, ".opam");
      if (fs.existsSync(opamDir)) {
        try {
          const switches = fs.readdirSync(opamDir);
          for (const sw of switches) {
            candidates.push(path.join(opamDir, sw, "bin", duneBinName));
          }
        } catch {
          // ignore directory read errors
        }
      }
    }

    candidates.push(duneBinName);

    for (const c of candidates) {
      if (OxcamlCompiler.canExecute(c)) {
        return c;
      }
    }

    return undefined;
  } // fn: resolveDune

  /**
   * Resolves the ocamlopt executable location.
   *
   * @param candidate Optional explicit candidate path
   * @param env Optional environment map
   * @returns Path to ocamlopt executable or undefined
   */
  public static resolveOcamlopt(
    candidate?: string,
    env?: Record<string, string | undefined>
  ): string | undefined {
    const configured =
      candidate ??
      Config.get<string>("nanofuzz.oxcaml.ocamloptPath", "ocamlopt");

    const candidates: string[] = [];
    if (configured && configured !== "ocamlopt") {
      candidates.push(configured);
    }

    const switchPrefix =
      env?.OPAM_SWITCH_PREFIX ?? process.env.OPAM_SWITCH_PREFIX;
    const ocamloptBinName =
      process.platform === "win32" ? "ocamlopt.exe" : "ocamlopt";

    if (switchPrefix) {
      candidates.push(path.join(switchPrefix, "bin", ocamloptBinName));
    }

    const home = os.homedir();
    if (home) {
      const opamDir = path.join(home, ".opam");
      if (fs.existsSync(opamDir)) {
        try {
          const switches = fs.readdirSync(opamDir);
          for (const sw of switches) {
            candidates.push(path.join(opamDir, sw, "bin", ocamloptBinName));
          }
        } catch {
          // ignore directory read errors
        }
      }
    }

    candidates.push(ocamloptBinName);

    for (const c of candidates) {
      if (OxcamlCompiler.canExecute(c)) {
        return c;
      }
    }

    return undefined;
  } // fn: resolveOcamlopt

  /**
   * Returns true if the binary exists and can be executed.
   *
   * @param binPath Binary path or command name to test
   * @returns True if runnable
   */
  public static canExecute(binPath: string): boolean {
    const now = Date.now();
    const cached = OxcamlCompiler._canExecuteCache.get(binPath);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    let result: boolean;
    try {
      const res = ChildProcess.spawnSync(binPath, ["--version"], {
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
      });
      result = res.status === 0;
    } catch {
      result = false;
    }

    OxcamlCompiler._canExecuteCache.set(binPath, {
      result,
      expiresAt: now + 60_000,
    });
    return result;
  } // fn: canExecute

  protected _getCompilationRecord(
    srcFile: string
  ): OxcamlCompilationRecord | undefined {
    const recordFile = this._getCompilationRecordFilename(srcFile);
    if (!fs.existsSync(recordFile)) {
      return undefined;
    }
    try {
      return JSONN.parse<OxcamlCompilationRecord>(
        fs.readFileSync(recordFile, "utf8")
      );
    } catch {
      return undefined;
    }
  } // fn: _getCompilationRecord

  protected _getCompilationRecordFilename(srcFile: string): string {
    const hash = crypto.createHash("sha256").update(srcFile).digest("hex");
    const recordsDir = path.join(this._options.tmpDir, "compilation_records");
    fs.mkdirSync(recordsDir, { recursive: true });
    return path.join(recordsDir, `${hash}.json`);
  } // fn: _getCompilationRecordFilename

  protected _newCompilationRecord(): OxcamlCompilationRecord {
    return {
      srcFile: this._moduleFile,
      srcDatetime: fs.existsSync(this._moduleFile)
        ? fs.statSync(this._moduleFile).mtime.toISOString()
        : "",
      duneProjectPath: this._duneProjectPath,
      duneProjectDatetime:
        this._duneProjectPath && fs.existsSync(this._duneProjectPath)
          ? fs.statSync(this._duneProjectPath).mtime.toISOString()
          : undefined,
      dunePath: this._dunePath ?? "",
      ocamloptPath: this._ocamloptPath ?? "",
      compiledAt: new Date().toISOString(),
    };
  } // fn: _newCompilationRecord
} // class: OxcamlCompiler

/**
 * Parses compiler error output from Dune or ocamlopt.
 */
function parseOxcamlCompilerOutput(
  stdout: string,
  stderr: string,
  inputFile: string,
  commandCli: string,
  duneProjectPath?: string
): OxcamlCompilerErrorDetails {
  const combined = `${stderr}\n${stdout}`.trim();
  const lines = combined.split("\n").filter((l) => l.trim().length > 0);
  const diagnostics: NonNullable<OxcamlCompilerErrorDetails["diagnostics"]> =
    [];

  const fileLocRegex =
    /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+characters\s+(\d+)-(\d+))?:/g;
  let match: RegExpExecArray | null;

  while ((match = fileLocRegex.exec(combined)) !== null) {
    const file = match[1];
    const line = parseInt(match[2], 10);
    const colStart = match[3] ? parseInt(match[3], 10) : 0;
    const colEnd = match[4] ? parseInt(match[4], 10) : 0;

    const afterLoc = combined.slice(match.index + match[0].length).trim();
    const msgLine = afterLoc.split("\n")[0].trim();

    diagnostics.push({
      message: msgLine,
      level: msgLine.toLowerCase().startsWith("warning") ? "warning" : "error",
      span: {
        file,
        lineStart: line,
        lineEnd: line,
        colStart,
        colEnd,
      },
      rendered: `${match[0]} ${msgLine}`,
    });
  }

  return {
    inputFile,
    duneProjectPath,
    commandCli,
    output: lines.length > 0 ? lines : ["Compilation failed"],
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };
} // fn: parseOxcamlCompilerOutput

/**
 * Searches for the local nanofuzz_runtime build output and opam library include directories.
 */
function findRuntimeIncludeDirs(): string[] {
  const dirs: string[] = [];
  const candidates = [
    path.resolve(
      "./packages/runtime/oxcaml/_build/install/default/lib/nanofuzz_runtime"
    ),
    path.resolve(
      "./build/extension/nanofuzz_runtime_oxcaml/_build/install/default/lib/nanofuzz_runtime"
    ),
    path.resolve(
      "./packages/runtime/oxcaml/_build/default/src/.nanofuzz_runtime.objs/byte"
    ),
    path.resolve(
      "./packages/runtime/oxcaml/_build/default/src/.nanofuzz_runtime.objs/native"
    ),
    path.resolve("./packages/runtime/oxcaml/_build/default/src"),
    path.resolve(
      "./build/extension/nanofuzz_runtime_oxcaml/_build/default/src"
    ),
    path.resolve("./packages/runtime/oxcaml/src"),
    path.resolve("./build/extension/nanofuzz_runtime_oxcaml/src"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      dirs.push(c);
    }
  }

  // Include opam switch libraries like yojson if available
  const switchPrefix = process.env.OPAM_SWITCH_PREFIX;
  if (switchPrefix) {
    const opamLib = path.join(switchPrefix, "lib");
    const subLibs = ["yojson", "biniou", "easy-format", "csexp"];
    for (const sub of subLibs) {
      const p = path.join(opamLib, sub);
      if (fs.existsSync(p)) {
        dirs.push(p);
      }
    }
  } else {
    const home = os.homedir();
    if (home) {
      const opamDir = path.join(home, ".opam");
      if (fs.existsSync(opamDir)) {
        try {
          const switches = fs.readdirSync(opamDir);
          for (const sw of switches) {
            const opamLib = path.join(opamDir, sw, "lib");
            if (fs.existsSync(path.join(opamLib, "yojson"))) {
              dirs.push(path.join(opamLib, "yojson"));
              if (fs.existsSync(path.join(opamLib, "biniou"))) {
                dirs.push(path.join(opamLib, "biniou"));
              }
              if (fs.existsSync(path.join(opamLib, "easy-format"))) {
                dirs.push(path.join(opamLib, "easy-format"));
              }
              break;
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return dirs;
} // fn: findRuntimeIncludeDirs

export type OxcamlCompilerOptions = {
  tmpDir: string;
};

export type OxcamlCompilationRecord = {
  srcFile: string;
  srcDatetime: string;
  duneProjectPath?: string;
  duneProjectDatetime?: string;
  dunePath: string;
  ocamloptPath: string;
  compiledAt: string;
};

const defaultOxcamlCompilerOptions: OxcamlCompilerOptions = {
  tmpDir: path.join(fs.realpathSync(os.tmpdir()), "nanofuzz", "oxcaml"),
};
