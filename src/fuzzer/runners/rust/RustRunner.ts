import fs from "node:fs";
import {
  AbstractRunner,
  RunnerOverrides,
  RunnerResult,
  ValidatorResult,
} from "../AbstractRunner";
import { CoverageMapData } from "istanbul-lib-coverage";
import { isRecordOfFileCoverageData } from "../../measures/CoverageMeasure";
import { FuzzEnv } from "../../Types";
import { isError, normalizePathForKey } from "../../Util";
import * as Config from "../../../Config";
import * as JSONN from "../../../Jsonn";
import { PutTimeoutName } from "../AbstractHost";
import { RustHost } from "./RustHost";
import { buildRustHarness } from "./RustHarness";
import { getSanitizerAdapter } from "./sanitizers/Registry";

/**
 * Test runner for compiled Rust targets.
 */
export class RustRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _env: FuzzEnv | undefined;
  protected _overrides: RunnerOverrides;
  protected _host: RustHost | undefined = undefined;
  protected _sanitizerName: string = "none";
  protected _seq = 0;
  protected _harnessBinary: string | undefined = undefined;
  protected _harnessDir: string | undefined = undefined;
  protected _coverageInfo?: CoverageMapData = undefined;
  protected _staticCoverage?: CoverageMapData = undefined;
  protected _lastRunCoverage?: CoverageMapData = undefined;
  protected _pgmFiles: string[] = [];
  protected _coverageEnabled = true;
  protected _coverageCallback?: (covData: unknown) => void;

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
    this._staticCoverage = undefined;
    if (this._env?.options?.measures?.CoverageMeasure?.enabled !== undefined) {
      this._coverageEnabled =
        this._env.options.measures.CoverageMeasure.enabled;
    }
    this._sanitizerName = Config.get<string>("nanofuzz.rust.sanitizer", "none");
    const { binaryPath, harnessDir, staticCov, staticCovMap } =
      buildRustHarness(
        this._filename,
        this._fn,
        this._env,
        undefined,
        this._sanitizerName
      );
    this._harnessBinary = binaryPath;
    this._harnessDir = harnessDir;
    const realFile = fs.existsSync(this._filename)
      ? fs.realpathSync(this._filename)
      : this._filename;
    const allStaticCov = staticCovMap ?? { [realFile]: staticCov };
    this._coverageInfo = { ...allStaticCov };
    for (const [fPath, sCov] of Object.entries(allStaticCov)) {
      const normKey = normalizePathForKey(fPath);
      if (normKey !== fPath) {
        this._coverageInfo[normKey] = sCov;
      }
    }
    this._staticCoverage = structuredClone(this._coverageInfo);
    this._pgmFiles = Object.keys(allStaticCov);

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
        ...(validators.length > 0 ? { validators } : {}),
      };

      const encoded = JSONN.pack(input);
      host.sendMessage(
        Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength)
      );

      const numFunctions = 1 + (validators?.length ?? 0);
      const hostTimeout =
        timeout && timeout > 0 ? timeout * numFunctions + 500 : Infinity;
      const rawResBuf = await host.getResponseBuffer(hostTimeout);
      const hostPayload: RustHostResponse = JSONN.unpack(rawResBuf);

      // Ingest dynamic coverage data
      if (this._coverageEnabled && this._coverageInfo) {
        const rawCovData = hostPayload.coverageData;
        if (rawCovData && isRecordOfFileCoverageData(rawCovData)) {
          this._lastRunCoverage = rawCovData;
          for (const fileKey of Object.keys(rawCovData)) {
            const fileCov = rawCovData[fileKey];
            const normKey = normalizePathForKey(fileKey);
            const target =
              this._coverageInfo[normKey] ?? this._coverageInfo[fileKey];
            if (target) {
              if (fileCov.s && target.s) {
                for (const sk of Object.keys(fileCov.s)) {
                  target.s[sk] = (target.s[sk] ?? 0) + (fileCov.s[sk] ?? 0);
                }
              }
              if (fileCov.f && target.f) {
                for (const fk of Object.keys(fileCov.f)) {
                  target.f[fk] = (target.f[fk] ?? 0) + (fileCov.f[fk] ?? 0);
                }
              }
              if (fileCov.b && target.b) {
                for (const bk of Object.keys(fileCov.b)) {
                  if (!target.b[bk]) {
                    target.b[bk] = [...(fileCov.b[bk] ?? [])];
                  } else if (Array.isArray(fileCov.b[bk])) {
                    for (let i = 0; i < fileCov.b[bk].length; i++) {
                      target.b[bk][i] =
                        (target.b[bk][i] ?? 0) + (fileCov.b[bk][i] ?? 0);
                    }
                  }
                }
              }
            }
          }
          this._coverageCallback?.(rawCovData);
        }
      }

      const seq =
        typeof hostPayload.seq === "number" ? hostPayload.seq : thisSeq;
      const hostValidators = hostPayload.validators;
      let resultInner: RunnerResult["result"];

      if (hostPayload.tag === "timeout") {
        resultInner = {
          tag: "timeout",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else if (hostPayload.tag === "skip") {
        resultInner = {
          tag: "skip",
          message: hostPayload.message ?? "",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else if (hostPayload.tag === "error") {
        resultInner = {
          tag: "error",
          name: hostPayload.name ?? "Panic",
          message: hostPayload.message ?? "",
          stack: hostPayload.stack,
          source: hostPayload.source ?? "put",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else {
        resultInner = {
          tag: "value",
          value: hostPayload.value,
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      }

      return {
        result: resultInner,
        env: {},
      };
    } catch (e: unknown) {
      const hostStderr = this._host ? this._host.stderr : "";
      const hostExitCode = this._host ? this._host.exitCode : null;
      this.killHost();
      if (!isError(e)) {
        throw e;
      }
      if (e.name === PutTimeoutName) {
        return { result: { tag: "timeout", seq: thisSeq }, env: {} };
      } else {
        const sanitizerAdapter = getSanitizerAdapter(this._sanitizerName);
        const diag = sanitizerAdapter.parseAbort(hostStderr, hostExitCode);
        if (diag) {
          return {
            result: {
              tag: "error",
              name: diag.name,
              message: diag.summary,
              stack: diag.stack ?? diag.rawReport,
              source: "put",
              seq: thisSeq,
            },
            env: {},
          };
        }
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
      this._sanitizerName = Config.get<string>(
        "nanofuzz.rust.sanitizer",
        "none"
      );
      const { binaryPath, harnessDir, staticCov, staticCovMap } =
        buildRustHarness(
          this._filename,
          this._fn,
          this._env,
          undefined,
          this._sanitizerName
        );
      this._harnessBinary = binaryPath;
      this._harnessDir = harnessDir;
      const realFile = fs.existsSync(this._filename)
        ? fs.realpathSync(this._filename)
        : this._filename;
      const allStaticCov = staticCovMap ?? { [realFile]: staticCov };
      this._coverageInfo = { ...allStaticCov };
      for (const [fPath, sCov] of Object.entries(allStaticCov)) {
        const normKey = normalizePathForKey(fPath);
        if (normKey !== fPath) {
          this._coverageInfo[normKey] = sCov;
        }
      }
      this._staticCoverage = structuredClone(this._coverageInfo);
      this._pgmFiles = Object.keys(allStaticCov);
    }

    const sanitizerAdapter = getSanitizerAdapter(this._sanitizerName);
    const hostEnv = sanitizerAdapter.configureHostEnv(process.env);
    const host = new RustHost(
      this._harnessBinary,
      [],
      this._harnessDir,
      hostEnv
    );
    const hostStartupTimeout = Config.get<number>(
      "nanofuzz.fuzzer.hostStartupTimeout",
      20000
    );

    const rawOkBuf = await host.getResponseBuffer(hostStartupTimeout);
    const okcode = JSONN.unpack<string>(rawOkBuf);
    if (okcode === "READY") {
      this._host = host;
      // Consume initial static coverage handshake message
      const rawCovBuf = await host.getResponseBuffer(hostStartupTimeout);
      try {
        const rawCov = JSONN.unpack<unknown>(rawCovBuf);
        if (
          isRecordOfFileCoverageData(rawCov) &&
          Object.keys(rawCov).length > 0
        ) {
          this._coverageInfo = rawCov;
          this._staticCoverage = structuredClone(rawCov);
          this._pgmFiles = Object.keys(rawCov);
        }
      } catch {
        // Fall back to pre-calculated static coverage
      }
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
   * Returns the current coverage information, if any.
   */
  public override get coverageInfo(): CoverageMapData | undefined {
    return this._coverageInfo;
  } // get: coverageInfo

  /**
   * Returns the single most recent execution's coverage information.
   */
  public override get lastRunCoverage(): CoverageMapData | undefined {
    return this._lastRunCoverage ?? this._coverageInfo;
  } // get: lastRunCoverage

  /**
   * Registers a callback to be invoked with coverage data.
   */
  public override onCoverage(callback: (covData: unknown) => void): void {
    this._coverageCallback = callback;
  } // fn: onCoverage

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

type RustHostResponse = {
  tag: "value" | "error" | "skip" | "timeout";
  seq?: number;
  value?: unknown;
  message?: string;
  name?: string;
  stack?: string;
  source?: "put" | "host";
  validators?: Record<string, ValidatorResult>;
  coverageData?: CoverageMapData;
};
