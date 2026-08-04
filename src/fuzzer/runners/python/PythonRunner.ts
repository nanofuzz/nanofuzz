import {
  AbstractRunner,
  Arc,
  RunnerInput,
  RunnerResult,
} from "../AbstractRunner";
import JSON5 from "json5";
import DotEnv from "dotenv";
import vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { findInAncestor, isError } from "../../Util";
import { PutTimeoutName } from "../AbstractHost";
import { PythonHost, PythonEnv } from "./PythonHost";
import * as ChildProcess from "node:child_process";

/**
 * Python runner
 */
export class PythonRunner extends AbstractRunner {
  protected _filename: string;
  protected _timeout: number;
  protected _runDepth = 0;
  protected _fn: string;
  protected _host: PythonHost | undefined = undefined;
  protected _seq = 0;
  protected _coverageInfo?: CoverageInfo = undefined;
  protected _pythonEnv: PythonEnv | undefined;
  protected static _envs: {
    [file: string]: PythonEnv;
  } = {};
  protected static _paths: {
    [path: string]: readonly string[];
  } = {};

  /**
   * Create a new Python runner
   *
   * @param `filename` path and filename of Python program module
   * @param `fn` exported Python function within `module` to call
   */
  constructor(filename: string, fn: string, timeout: number = 0) {
    super(fn);
    this._filename = filename;
    this._timeout = timeout;
    this._fn = fn;
  } // fn: constructor

  /**
   * Prepares the runner for the start of the test run
   *
   * @returns void
   */
  public async onRunStart(): Promise<void> {
    await super.onRunStart();
    this._killHost();
    this._pythonEnv = PythonRunner.envFor(this._filename);
    await this._getHost();
  } // fn: onRunStart

  /**
   * Run `fn` in `module` with `inputs`
   *
   * @param `inputs` inputs to function
   * @param `timeout` stop and fail after `timeout` ms
   * @returns Runner result
   */
  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;
    if (this._runDepth++ > 0) {
      throw new Error(
        "Internal error: PythonRunner.run calls cannot be interleaved."
      );
    }
    if (!this._pythonEnv) {
      throw new Error("Internal error: cannot 'run' prior to 'runStart'");
    }

    try {
      const host = await this._getHost();
      const input: RunnerInput = {
        args: inputs,
        seq: thisSeq,
      };

      host.sendMessage(JSON5.stringify(input));
      const result: RunnerResult = {
        result: JSON5.parse(await host.getResponse(timeout)),
        env: {},
      };

      if (result.result.seq >= 0 && result.result.seq !== thisSeq) {
        throw new Error(
          `Internal error: RunnerResult seq# does not match RunnerInput`
        );
      }

      // Refresh the dynamic coverage with what this call executed. A timeout
      // is killed mid-run, so the host never reports coverage for it.
      if (this._coverageInfo) {
        if (result.result.tag === "timeout") {
          this._coverageInfo.lines = undefined;
          this._coverageInfo.arcs = undefined;
        } else {
          this._coverageInfo.lines = result.result.coverageData;
          this._coverageInfo.arcs = result.result.coverageArcs;
        }
      }
      return result;
    } catch (e: unknown) {
      this._killHost();
      if (!isError(e)) {
        throw e;
      }
      if (e.name === PutTimeoutName) {
        return { result: { tag: "timeout", seq: thisSeq }, env: {} };
      } else {
        return {
          result: {
            tag: "error",
            name: e.name,
            message: e.message,
            stack: e.stack,
            seq: thisSeq,
          },
          env: {},
        };
      }
    } finally {
      this._runDepth--;
    }
  }

  /**
   * Tears down the runner host at the end of the test run
   *
   * @returns void
   */
  public async onRunEnd(): Promise<void> {
    await super.onRunEnd();
    this._killHost();
    this._pythonEnv = undefined;
  }

  /**
   * Returns the python environment for a file
   *
   * @param `filename` Python source file in a workspace
   * @returns a python environment
   */
  public static envFor(filename: string): PythonEnv {
    if (filename in PythonRunner._envs) {
      return PythonRunner._envs[filename];
    }

    const pythonEnv: PythonEnv = {
      env: { ...process.env },
      libs: findPythonLibDir(path.dirname(module.filename), "json5"),
      paths: [],
      interpreter: vscode.workspace
        .getConfiguration("python")
        .get("defaultInterpreterPath", "python3"),
    };

    // Load .env file if configured
    if (
      vscode.workspace
        .getConfiguration("python.terminal")
        .get("useEnvFile", false)
    ) {
      const envFile = vscode.workspace
        .getConfiguration("python")
        .get("envFile", undefined);
      if (envFile && fs.existsSync(envFile)) {
        DotEnv.config({ processEnv: pythonEnv.env, path: envFile });
      }
    }

    // Append own own modules to PYTHONPATH if needed
    if (pythonEnv.libs && !pythonEnv.env.PYTHONPATH?.includes(pythonEnv.libs)) {
      pythonEnv.env.PYTHONPATH =
        (pythonEnv.env.PYTHONPATH ?? "") +
        (process.platform === "win32" ? ";" : ":") +
        pythonEnv.libs;
    }

    // Use a virtual environment if specified & found
    const searchGlobs: string[] = vscode.workspace
      .getConfiguration("python-envs")
      .get<string[]>("workspaceSearchPaths", []);
    const workspace = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(filename)
    )?.uri.fsPath;
    if (
      searchGlobs.length &&
      workspace &&
      vscode.workspace
        .getConfiguration("python.terminal")
        .get<boolean>("activateEnvironment", false) &&
      vscode.workspace
        .getConfiguration("python-envs.terminal")
        .get<string>("autoActivationType", "command") ===
        "command" /* TODO shellStartup */
    ) {
      const matches = fs.globSync(searchGlobs, { cwd: workspace });
      if (matches.length) {
        const venvPath = path.resolve(path.join(workspace, matches[0]));
        const venvBins =
          process.platform === "win32"
            ? path.resolve(path.join(venvPath, "Scripts"))
            : path.resolve(path.join(venvPath, "bin"));
        const venvActivateCmd =
          process.platform === "win32"
            ? path.resolve(path.join(venvBins, "activate"))
            : `source ${path.resolve(path.join(venvBins, "activate"))}`;

        pythonEnv.venv = {
          path: venvPath,
          activateCmd: venvActivateCmd,
          interpreter: path.resolve(path.join(venvBins, "python3")),
        };
        pythonEnv.interpreter = pythonEnv.venv.interpreter;
      }
    }
    pythonEnv.paths = PythonRunner._pathsFor(pythonEnv);

    PythonRunner._envs[filename] = Object.freeze(pythonEnv);
    setTimeout(() => {
      delete PythonRunner._envs[filename];
    }, 10000);

    return pythonEnv;
  }

  /**
   * Returns the syspaths used by the interpreter
   *
   * @param `interpreter` path to python interpreter
   * @returns array of paths
   */
  protected static _pathsFor(pythonEnv: PythonEnv): readonly string[] {
    const interpreter = pythonEnv.interpreter;
    if (!(interpreter in PythonRunner._paths)) {
      try {
        const output = ChildProcess.execFileSync(
          interpreter,
          ["-c", "import sys, json; print(json.dumps(sys.path))"],
          { encoding: "utf8", env: pythonEnv.env }
        );
        const entries: unknown = JSON.parse(output);
        PythonRunner._paths[interpreter] = Array.isArray(entries)
          ? Object.freeze(
              entries.filter((e) => typeof e === "string" && e !== "")
            )
          : [];
      } catch (_e: unknown) {
        // No interpreter on PATH, or it failed to run
        PythonRunner._paths[interpreter] = Object.freeze([]);
      }
      setTimeout(() => {
        delete PythonRunner._paths[interpreter];
      }, 15000);
    }
    return PythonRunner._paths[interpreter];
  } //fn: _pathsFor

  /**
   * Get the current Python host process (creates a new one if needed)
   */
  protected async _getHost(): Promise<PythonHost> {
    if (this._host !== undefined) {
      if (this._host.isActive) {
        return this._host;
      } else {
        this._host.kill();
        this._host = undefined;
      }
    }

    if (!this._pythonEnv) {
      throw new Error("Internal error: cannot '_getHost' prior to 'runStart'");
    }

    const filenameBase = path.basename(this._filename);
    const args = [
      path.resolve(
        path.join(
          path.dirname(path.resolve(module.filename)),
          "PythonRunnerHost.py"
        )
      ),
      this._filename,
      filenameBase.substring(
        0,
        filenameBase.length - path.extname(filenameBase).length
      ),
      this._fn,
    ];

    const host = new PythonHost(
      args,
      path.dirname(module.filename),
      this._pythonEnv
    );

    // a longer timeout tolerance for the host to pre-warm the coverage
    const okcode = await host.getResponse(10000);
    if (okcode === `"READY"`) {
      this._host = host;

      // Get the static coverage structure, which the host sends once. The
      // dynamic `lines`/`arcs` are filled in by each `run`.
      const data = JSON5.parse<CoverageInfo>(await host.getResponse(10000));
      this._coverageInfo = {
        file: data.file,
        executable: data.executable ?? [],
        functions: data.functions ?? [],
        branches: data.branches ?? [],
      };
      return host;
    } else {
      host.kill();
      throw new Error(`PythonHost not ready (okcode: ${okcode})`);
    }
  } // get: host

  /**
   * Kill the current Python host
   */
  protected _killHost(): void {
    if (this._host !== undefined) {
      this._host.kill();
      this._host = undefined;
    }
  }

  /**
   * Get coverage info
   * Needs to be a shallow copy since the covered lines changes every run
   */
  public get coverageInfo(): CoverageInfo | undefined {
    return this._coverageInfo ? { ...this._coverageInfo } : undefined;
  }
} // class: PythonRunner

function findPythonLibDir(dir: string, item: string): string | null {
  // Co-located with this module (e.g., as built)
  if (fs.existsSync(path.resolve(path.join(dir, item)))) {
    return dir;
  }

  // Find build folder (e.g., during development)
  const buildFolder = findInAncestor(module.filename, "build");
  if (buildFolder) {
    return path.resolve(path.join(buildFolder, "extension"));
  }

  return null;
}

/**
 * Coverage reported by the Python host for the program under test.
 *
 * The static fields describe what the program *can* execute and are sent once
 * at startup; the dynamic fields describe what a single call *did* execute and
 * are refreshed on every `run`.
 */
export type CoverageInfo = {
  file: string;
  executable: number[]; // static: all executable lines
  functions: FunctionInfo[]; // static: all functions
  branches: BranchInfo[]; // static: all branch points
  lines?: number[]; // dynamic: lines executed by this one call
  arcs?: Arc[]; // dynamic: arcs taken by this one call
};

/**
 * A function in the program under test. `lines` holds only the function's own
 * executable lines: coverage.py attributes lines per function, so lines inside
 * a nested function are not charged to its parent.
 */
export type FunctionInfo = {
  name: string; // e.g. "fn" or "Class.method"
  declLine: number; // the `def` line
  startLine: number; // first executable line of the body
  endLine: number; // last executable line of the body
  lines: number[]; // the function's own executable lines
};

/**
 * A branch point: a line with more than one possible exit.
 */
export type BranchInfo = {
  line: number; // the branching line
  exits: BranchExit[]; // every destination it can reach
};

/**
 * One possible exit from a branch. `dest` is the raw arc target, used to match
 * against the arcs actually taken. coverage.py uses non-positive `dest` values
 * to mean "left the enclosing scope"; those have no line of their own, so
 * `line` reports where to display them (the branch line itself).
 */
export type BranchExit = {
  dest: number; // arc target, for matching against `Arc`s
  line: number; // where to display this exit
};

export { Arc } from "../AbstractRunner";
