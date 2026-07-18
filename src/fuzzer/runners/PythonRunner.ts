import { AbstractRunner, RunnerResult } from "./AbstractRunner";
import JSON5 from "json5";
import * as ChildProcess from "node:child_process";
import * as path from "node:path";
import { isError } from "../Util";

/**
 * Python runner
 */
export class PythonRunner extends AbstractRunner {
  protected _filename: string;
  protected _runDepth = 0;
  protected _fn: string;
  protected _proc: ChildProcess.ChildProcessWithoutNullStreams | undefined;
  protected _buff: Buffer | undefined;

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

    [this._proc, this._buff] = this._newHost();
  } // fn: constructor

  /**
   * Creates and returns a new child host process
   *
   * @returns host process reference
   */
  protected _newHost(): [ChildProcess.ChildProcessWithoutNullStreams, Buffer] {
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

    return [
      ChildProcess.spawn("python3", args, {
        cwd: path.dirname(module.filename),
        windowsHide: true,
      }),
      Buffer.alloc(0),
    ];
    // Handle case where this doesn't work? (syntax error) !!!!!!!!!!!!
  } // fn: newHost

  /**
   * Get the current Python host process (creates a new one if needed)
   */
  protected get _host(): ChildProcess.ChildProcessWithoutNullStreams {
    if (this._proc === undefined || this._proc.exitCode !== null) {
      [this._proc, this._buff] = this._newHost();
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
      this._buff = undefined;
    }
    console.debug("Python host killed"); // !!!!!!!!!!
  }

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
    if (this._runDepth++ > 0) {
      throw new Error(
        "Internal error: PythonRunner.run calls cannot be interleaved."
      );
    }

    try {
      const host = this._host;

      const payload = JSON5.stringify(inputs);
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(Buffer.byteLength(payload), 0);

      // Send length + payload
      host.stdin.write(lengthBuffer);
      host.stdin.write(payload);

      // Get response length + payload
      const length = (await this._readBytes(4, timeout)).readUInt32BE(0);
      return {
        result: JSON5.parse(
          (await this._readBytes(length, timeout)).toString()
        ),
        env: {},
      };
    } catch (e: unknown) {
      this._killHost();
      if (!isError(e)) {
        throw e;
      }
      if (e.name === putTimeoutName) {
        return { result: { tag: "timeout" }, env: {} };
      } else {
        return {
          result: {
            tag: "error",
            name: e.name,
            message: e.message,
            stack: e.stack,
          },
          env: {},
        };
      }
    } finally {
      this._runDepth--;
    }
  }

  /**
   * Reads bytes from the buffer
   *
   * @param `n` number of bytes to read
   * @param `timeout` number of ms before giving up (0=no limit)
   * @returns n bytes
   */
  protected async _readBytes(n: number, timeout: number): Promise<Buffer> {
    const host = this._host;

    if (this._buff === undefined) {
      throw new Error(`Internal error: host without a buffer`);
    }

    return new Promise((resolve, reject) => {
      if (this._buff!.length >= n) {
        // Return the data if it's already in the buffer
        const result = this._buff!.subarray(0, n);
        this._buff = this._buff!.subarray(n);
        resolve(result);
      } else {
        // Otherwise, wait for the data
        const onData = (chunk: Buffer) => {
          this._buff! = Buffer.concat([this._buff!, chunk]);
          if (this._buff.length >= n) {
            cleanup();
            const result = this._buff.subarray(0, n);
            this._buff = this._buff.subarray(n);
            resolve(result);
          }
        };

        const onError = (err: Error) => {
          cleanup();
          reject(new Error(`PythonRunnerHost pipe error: ${err.message}`));
        };

        const onClose = () => {
          reject(
            new Error(
              `PythonRunnerHost exited unexpectedly (exit code: ${host.exitCode}, stderr: ${host.stderr.read()}, stdout: ${host.stdout.read()})`
            )
          );
          cleanup();
        };

        const timer =
          timeout > 0
            ? setTimeout(() => {
                cleanup();
                const exception = new Error(
                  `PythonRunnerHost run exceeded ${timeout} ms timneout`
                );
                exception.name = putTimeoutName;
                reject(exception);
              }, timeout)
            : undefined;

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
          }
          host.stdout.removeListener("data", onData);
          host.stdout.removeListener("error", onError);
          host.removeListener("close", onClose);
        };

        host.stdout.on("data", onData);
        host.stdout.on("error", onError);
        host.once("close", onClose);
      }
    });
  } // fn: _readBytes
} // class: PythonRunner

const putTimeoutName = "PythonRunnerPutTimeout";
