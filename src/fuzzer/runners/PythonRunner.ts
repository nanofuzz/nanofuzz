import { AbstractRunner, RunnerInput, RunnerResult } from "./AbstractRunner";
import JSON5 from "json5";
import DotEnv from "dotenv";
import vscode from "vscode";
import * as ChildProcess from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { findInAncestor, isError } from "../Util";

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

      const payload = JSON5.stringify(input);
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(Buffer.byteLength(payload), 0);

      // Send length + payload
      host.write(lengthBuffer);
      host.write(payload);

      // Get response length + payload
      const length = (await host.readStdout(4, timeout)).readUInt32BE(0);
      const result: RunnerResult = {
        result: JSON5.parse(
          (await host.readStdout(length, timeout)).toString()
        ),
        env: {},
      };
      if (result.result.seq >= 0 && result.result.seq !== thisSeq) {
        throw new Error(
          `Internal error: RunnerResult seq# does not match RunnerInput`
        );
      }
      return result;
    } catch (e: unknown) {
      this._killHost();
      if (!isError(e)) {
        throw e;
      }
      if (e.name === putTimeoutName) {
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
    const okcode = await host.readStdout(5, 1000);

    if (okcode.toString() === "READY") {
      this._host = host;
      return host;
    } else {
      const stdout = await host.readStdout();
      host.kill();
      throw new Error(
        `PythonHost not ready (okcode: ${okcode}, stdout: ${stdout})`
      );
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
} // class: PythonRunner

/**
 * Wrapper for running and interacting with running Python programs
 */
class PythonHost {
  protected _proc: ChildProcess.ChildProcessWithoutNullStreams;
  protected _isActive: boolean = true;
  protected _stdout: Buffer<ArrayBuffer>;
  protected _stderr: Buffer<ArrayBuffer>;
  protected _errors: Error[];
  protected _cli: string;
  protected _cwd: string | undefined;

  constructor(args: string[], cwd: string | undefined, pythonEnv: PythonEnv) {
    this._stdout = Buffer.alloc(0);
    this._stderr = Buffer.alloc(0);
    this._errors = [];
    this._cwd = cwd;
    this._cli = [pythonEnv.interpreter, ...args].join(" ");

    // Spawn the host
    this._proc = ChildProcess.spawn(pythonEnv.interpreter, args, {
      cwd,
      env: pythonEnv.env,
      windowsHide: true,
    });

    this._proc.stdout.on("data", this._onStdout);
    this._proc.stdout.on("error", this._onError);
    this._proc.stderr.on("data", this._onStderr);
    this._proc.stderr.on("error", this._onError);
    this._proc.once("close", this._onClose);

    this._isActive = true;
  }

  public get isActive(): boolean {
    return this._isActive;
  }

  protected _onStdout = (chunk: Buffer): void => {
    this._stdout = Buffer.concat([this._stdout, chunk]);
  };

  protected _onStderr = (chunk: Buffer): void => {
    this._stderr = Buffer.concat([this._stderr, chunk]);
  };

  protected _onError = (err: Error): void => {
    this._errors.push(new Error(`PythonHost pipe error: ${err.message}`));
    this.kill();
  };

  protected _onClose = (): void => {
    this._errors.push(
      new Error(
        `PythonHost exited unexpectedly (exit code: ${this._proc.exitCode}, stderr: ${this._proc.stderr.read()}, stdout: ${this._proc.stdout.read()}, cli: ${this._cli}, cwd: ${this._cwd})`
      )
    );
    this.kill();
  };

  public kill(): void {
    this._isActive = false;

    this._proc.stdout.removeListener("data", this._onStdout);
    this._proc.stdout.removeListener("error", this._onError);
    this._proc.stderr.removeListener("data", this._onStderr);
    this._proc.stderr.removeListener("error", this._onError);
    this._proc.removeListener("close", this._onClose);

    this._proc.kill();
  }

  public write(chunk: Parameters<typeof this._proc.stdin.write>[0]): void {
    if (!this._isActive) {
      throw new Error("Internal error: Cannot write to an inactive host");
    }
    this._proc.stdin.write(chunk);
  }

  /**
   * Reads bytes from the stdout buffer. If the bytes have not arrived yet,
   * then wait `timeout` ms.
   *
   * @param `n` number of bytes to read ("all"=return the entire current buffer)
   * @param `timeout` number of ms before giving up (0=don't wait, Infinity=no timeout)
   * @returns `n` bytes, or the entire buffer if n is 0
   */
  public async readStdout(
    n: number | "all" = "all",
    timeout: number = 0
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (!this._isActive) {
        reject(new Error("Internal error: Cannot read from an inactive host"));
        return;
      }
      const bytes = n === "all" ? this._stdout.length : n;

      if (this._stdout.length >= bytes) {
        // Return the data if it's already in the buffer
        const result = this._stdout!.subarray(0, bytes);
        this._stdout = this._stdout!.subarray(bytes);
        resolve(result);
        return;
      }

      if (timeout === 0) {
        reject(new Error(`Read past buffer end`));
        return;
      }

      const onData = (_chunk: Buffer) => {
        // Another listener writes to the buffer
        if (this._stdout.length >= bytes) {
          cleanup();
          try {
            resolve(this.readStdout(n, 0));
          } catch (e: unknown) {
            reject(e);
          }
        }
      };

      const onError = (err: Error) => {
        reject(err);
        cleanup();
      };

      const onClose = () => {
        const exitCode = this._proc.exitCode;
        reject(
          this._errors.at(-1) ??
            new Error(`Host exited unexpectedly with exit code: ${exitCode}`)
        );
        cleanup();
      };

      const timer =
        timeout > 0 && timeout !== Infinity
          ? setTimeout(() => {
              cleanup();
              const exception = new Error(
                `PythonRunnerHost did not return expected data within ${timeout} ms timeout`
              );
              exception.name = putTimeoutName;
              this.kill();
              reject(exception);
            }, timeout)
          : undefined;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this._proc.stdout.removeListener("data", onData);
        this._proc.stdout.removeListener("error", onError);
        this._proc.removeListener("close", onClose);
      };

      this._proc.stdout.on("data", onData);
      this._proc.stdout.on("error", onError);
      this._proc.once("close", onClose);
    });
  } // fn: _readBytes
} // class: PythonHost

const putTimeoutName = "PythonRunnerPutTimeout";

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

export type PythonEnv = {
  env: { [k: string]: string | undefined };
  libs: string | undefined | null;
  interpreter: string;
  paths: readonly string[];
  venv?: {
    activateCmd: string;
    path: string;
    interpreter: string;
  };
};
