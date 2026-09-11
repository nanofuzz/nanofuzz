import * as ChildProcess from "node:child_process";

/**
 * Abstract representation of a host process
 */
export abstract class AbstractHost {
  protected readonly _proc;
  protected _isActive: boolean = false;
  protected _stdout;
  protected _stderr;
  protected _errors: Error[];
  protected _env;
  protected _cwd;
  protected _cmd;
  protected _args;
  protected _cli;
  protected _onExit;
  protected _onExitSent = false;

  constructor(
    env: { [k: string]: string | undefined },
    cwd: string | undefined,
    cmd: string,
    args: string[],
    onExit?: HostExitHandler | undefined
  ) {
    this._stdout = Buffer.alloc(0);
    this._stderr = Buffer.alloc(0);
    this._errors = [];
    this._env = env;
    this._cwd = cwd;
    this._cmd = cmd;
    this._args = args;
    this._cli = [cmd, ...args].join(" ");
    this._onExit = onExit;

    this._proc = this._spawn();

    this._proc.on("error", this._onError);
    this._proc.stdout.on("data", this._onStdout);
    this._proc.stdout.on("error", this._onError);
    this._proc.stderr.on("data", this._onStderr);
    this._proc.stderr.on("error", this._onError);
    this._proc.once("close", this._onClose);

    this._isActive = true;
  } // constructor

  protected abstract _spawn(): ChildProcess.ChildProcessWithoutNullStreams;

  /**
   * Sends a message to the host process.
   *
   * @param payload The message payload, either a string or a Buffer.
   */
  public sendMessage(payload: string | Buffer): void {
    if (!this._isActive) {
      throw new Error("Internal error: Cannot write to an inactive host");
    }

    const payloadBuffer =
      typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
    const lengthBuffer = Buffer.alloc(PayloadSizeBytes);
    lengthBuffer.writeUInt32BE(payloadBuffer.length, 0);

    this._proc.stdin.write(lengthBuffer);
    this._proc.stdin.write(payloadBuffer);
  } // fn: sendMessage

  /**
   * Gets the response from the host as a buffer.
   *
   * @param timeout The maximum time to wait for a response, in milliseconds.
   * @returns A promise that resolves with the response buffer.
   */
  public async getResponseBuffer(timeout: number = Infinity): Promise<Buffer> {
    const MAX_HEARTBEATS = 60;
    let heartbeats = 0;

    return new Promise<Buffer>((resolve, reject) => {
      let isDone = false;
      let timer: NodeJS.Timeout | undefined;

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        if (timeout > 0 && timeout !== Infinity) {
          timer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            const exception = new Error(
              `Host did not respond within ${timeout} ms timeout`
            );
            exception.name = PutTimeoutName;
            reject(exception);
            this.kill();
          }, timeout);
        }
      };

      const cleanup = () => {
        isDone = true;
        if (timer) clearTimeout(timer);
      };

      resetTimer();

      const readNext = async (): Promise<void> => {
        try {
          const header = await this._readStdout(PayloadSizeBytes);
          if (isDone) return;
          const length = header.readUInt32BE(0);
          const payload = await this._readStdout(length);
          if (isDone) return;

          if (this._isHeartbeatPayload(payload)) {
            heartbeats++;
            if (heartbeats > MAX_HEARTBEATS) {
              cleanup();
              const exception = new Error(
                `Host exceeded maximum allowed startup heartbeats limit (${MAX_HEARTBEATS} heartbeats / 1 minute)`
              );
              exception.name = PutTimeoutName;
              reject(exception);
              this.kill();
              return;
            }
            resetTimer();
            readNext();
            return;
          }

          cleanup();
          resolve(payload);
        } catch (reason) {
          if (!isDone) {
            cleanup();
            reject(reason);
          }
        }
      };

      readNext();
    });
  } // fn: getResponseBuffer

  protected _isHeartbeatPayload(buf: Buffer): boolean {
    return !!buf && buf.includes("HEART");
  }

  public async getResponse(timeout: number = Infinity): Promise<string> {
    const buf = await this.getResponseBuffer(timeout);
    return buf.toString("utf-8");
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
    this._errors.push(new Error(`Host pipe error: ${err.message}`));
    this.kill();
  };

  protected _onClose = (): void => {
    this._errors.push(
      new Error(
        `Host exited unexpectedly (exit code: ${this._proc.exitCode}, stderr: ${this._proc.stderr.read()}, stdout: ${this._proc.stdout.read()}, cli: ${this._cli}, cwd: ${this._cwd})`
      )
    );
    this.kill();
  };

  /**
   * Kills the host process and cleans up resources. If the
   * host has already exited, this is a no-op.
   */
  public kill(): void {
    this._isActive = false;

    this._proc.stdout.removeListener("data", this._onStdout);
    this._proc.stdout.removeListener("error", this._onError);
    this._proc.stderr.removeListener("data", this._onStderr);
    this._proc.stderr.removeListener("error", this._onError);
    this._proc.removeListener("close", this._onClose);

    this._proc.kill();
    if (!this._onExitSent) {
      if (this._onExit) {
        this._onExit(0);
        this._onExitSent = true;
      }
    }
  } // fn: kill

  /**
   * Reads bytes from the stdout buffer. If the bytes have not arrived yet,
   * then wait longer.
   *
   * @param `n` number of bytes to read
   * @returns `n` bytes
   */
  protected async _readStdout(bytes: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (!this._isActive) {
        reject(new Error("Host is not active"));
        return;
      }

      // Return the data if it's already in the buffer
      if (this._stdout.length >= bytes) {
        const result = this._stdout!.subarray(0, bytes);
        this._stdout = this._stdout!.subarray(bytes);
        resolve(result);
        return;
      }

      // Otherwise create a listener to wait for more data
      const onData = (_chunk: Buffer) => {
        // The constructor listener writes to the buffer
        if (this._stdout.length >= bytes) {
          cleanupListeners();
          try {
            resolve(this._readStdout(bytes));
          } catch (e: unknown) {
            reject(e);
          }
        }
      };

      const onError = (err: Error) => {
        reject(err);
        cleanupListeners();
      };

      const onClose = () => {
        const exitCode = this._proc.exitCode ?? -9999;
        if (!this._onExitSent) {
          if (this._onExit) {
            this._onExit(exitCode);
            this._onExitSent = true;
          }
        }
        reject(
          this._errors.at(-1) ??
            new Error(`Host exited unexpectedly with exit code: ${exitCode}`)
        );
        cleanupListeners();
      };

      const cleanupListeners = () => {
        this._proc.stdout.removeListener("data", onData);
        this._proc.stdout.removeListener("error", onError);
        this._proc.removeListener("close", onClose);
      };

      this._proc.stdout.on("data", onData);
      this._proc.stdout.on("error", onError);
      this._proc.once("close", onClose);
    });
  } // fn: _readBytes
} // class: AbstractHost

export const PutTimeoutName = "PutTimeout";

export type HostMessageHandler = (payload: string) => void;

export type HostExitHandler = (rc: number) => void;

const PayloadSizeBytes = 4;
