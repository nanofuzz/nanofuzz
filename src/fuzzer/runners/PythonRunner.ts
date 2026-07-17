import { AbstractRunner, RunnerResult } from "./AbstractRunner";
import JSON5 from "json5";
import * as ChildProcess from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Python runner
 */
export class PythonRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _proc: ChildProcess.ChildProcessWithoutNullStreams | undefined;

  /**
   * Create a new Python runner
   *
   * @param `filename` path and filename of Python program module
   * @param `fn` exported Python function within `module` to call
   */
  constructor(filename: string, fn: string) {
    super(fn);
    this._filename = filename;
    this._fn = fn;

    this._proc = this.newHost();
  } // fn: constructor

  /**
   * Creates and returns a new child host Python process
   *
   * @returns host process reference
   */
  protected newHost(): ChildProcess.ChildProcessWithoutNullStreams {
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
    ];
    return ChildProcess.spawn("python3", args, {
      cwd: path.dirname(module.filename),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Handle case where this doesn't work? (syntax error) !!!!!!!!!!!!
  } // fn: newHost

  /**
   * Get the current Python host process (creates a new one if needed)
   */
  protected get _host(): ChildProcess.ChildProcessWithoutNullStreams {
    if (this._proc === undefined) {
      this._proc = this.newHost();
    }
    return this._proc;
  } // get: host

  /**
   * Kill the Python host
   */
  protected _killHost(): void {
    if (this._proc !== undefined) {
      this._proc.kill();
      this._proc = undefined;
    }
  }

  /**
   * Run `fn` in `module` with `inputs`
   *
   * @param `inputs` inputs to function
   * @param `timeout` stop and fail after `timeout` ms
   * @returns Runner result
   */
  public run(inputs: unknown[]): RunnerResult {
    const host = this._host;

    const payload = JSON5.stringify(inputs);
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(Buffer.byteLength(payload), 0);

    // Send length + payload
    host.stdin.write(lengthBuffer);
    host.stdin.write(payload);

    // Read response: first 6 bytes for length, then the rest
    const length = this._readBytes(4).readUInt32BE(0);
    const response = JSON5.parse(this._readBytes(length).toString());

    return { result: { tag: "value", value: response.output }, env: {} };
  }

  /**
   * Reads bytes from the buffer
   *
   * @param n number of bytes to read
   * @returns n bytes
   */
  protected _readBytes(n: number): Buffer {
    const buff = Buffer.alloc(n);
    let bytesRead = 0;

    // We read from the file descriptor synchronously
    while (bytesRead < n) {
      const read = fs.readSync(
        (this._host.stdout as any).fd, // present but missing in type defs
        buff,
        bytesRead,
        n - bytesRead,
        null // position is null for pipes
      );

      if (read === 0) {
        throw new Error("Python process closed stdout unexpectedly.");
      }
      bytesRead += read;
    }

    return buff;
  } // fn: _readBytes
} // class: PythonRunner
