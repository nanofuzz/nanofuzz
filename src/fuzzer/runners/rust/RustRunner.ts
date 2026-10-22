import {
  AbstractRunner,
  RunnerOverrides,
  RunnerResult,
} from "../AbstractRunner";
import { FuzzEnv } from "../../Types";
import { isError } from "../../Util";
import * as Config from "../../../Config";
import { PutTimeoutName } from "../AbstractHost";
import { RustHost } from "./RustHost";
import { buildRustHarness } from "./RustHarness";

/**
 * Test runner for compiled Rust targets.
 */
export class RustRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _env: FuzzEnv | undefined;
  protected _overrides: RunnerOverrides;
  protected _host: RustHost | undefined = undefined;
  protected _seq = 0;
  protected _harnessBinary: string | undefined = undefined;
  protected _harnessDir: string | undefined = undefined;

  constructor(
    filename: string,
    fn: string,
    env?: FuzzEnv,
    overrides: RunnerOverrides = {}
  ) {
    super(fn);
    this._filename = filename;
    this._fn = fn;
    this._env = env;
    this._overrides = overrides;
  } // constructor

  /**
   * Prepares the runner and compiles the harness at the start of a fuzz run.
   */
  public override async onRunStart(): Promise<void> {
    await super.onRunStart();
    this.killHost();
    const { binaryPath, harnessDir } = buildRustHarness(
      this._filename,
      this._fn,
      this._env
    );
    this._harnessBinary = binaryPath;
    this._harnessDir = harnessDir;
    await this._getHost();
  } // fn: onRunStart

  /**
   * Runs the function under test with the provided inputs.
   *
   * @param inputs Array of argument values
   * @param timeout Execution timeout in ms
   * @param validators Optional list of validator function names to run in-host
   * @returns RunnerResult containing output, panic error, skip, or timeout
   */
  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0,
    validators: string[] = []
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;

    try {
      const host = await this._getHost();

      const input = {
        seq: thisSeq,
        args: inputs,
        timeout: timeout ?? 0,
        validators: validators.length > 0 ? validators : undefined,
      };

      host.sendMessage(JSON.stringify(input));

      const numFunctions = 1 + (validators?.length ?? 0);
      const hostTimeout =
        timeout && timeout > 0 ? timeout * numFunctions + 500 : Infinity;
      const rawResBuf = await host.getResponseBuffer(hostTimeout);
      const resultPayload: RunnerResult["result"] = JSON.parse(
        rawResBuf.toString("utf8")
      );

      return {
        result: resultPayload,
        env: {},
      };
    } catch (e: unknown) {
      this.killHost();
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
    }
  } // fn: run

  /**
   * Internal getter for the runner's host process.
   */
  protected override async _getHost(): Promise<RustHost> {
    if (this._host && this._host.isActive) {
      return this._host;
    }

    if (!this._harnessBinary) {
      const { binaryPath, harnessDir } = buildRustHarness(
        this._filename,
        this._fn,
        this._env
      );
      this._harnessBinary = binaryPath;
      this._harnessDir = harnessDir;
    }

    const host = new RustHost(this._harnessBinary, [], this._harnessDir);
    const hostStartupTimeout = Config.get<number>(
      "nanofuzz.fuzzer.hostStartupTimeout",
      20000
    );

    const rawOkBuf = await host.getResponseBuffer(hostStartupTimeout);
    const okcode = JSON.parse(rawOkBuf.toString("utf8"));
    if (okcode === "READY") {
      this._host = host;
      // Consume initial coverage handshake message
      await host.getResponseBuffer(hostStartupTimeout);
      return host;
    } else {
      host.kill();
      throw new Error(`Rust runner host failed to start: ${okcode}`);
    }
  } // fn: _getHost

  /**
   * Returns the module filename associated with this runner.
   */
  public override get filename(): string {
    return this._filename;
  } // get: filename

  /**
   * Kills the running host process if active.
   */
  public killHost(): void {
    if (this._host) {
      this._host.kill();
      this._host = undefined;
    }
  } // fn: killHost

  /**
   * Cleans up the host process after test execution finishes.
   */
  public override async onRunEnd(): Promise<void> {
    await super.onRunEnd();
    this.killHost();
  } // fn: onRunEnd
} // class: RustRunner
