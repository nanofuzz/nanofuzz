import fs from "node:fs";
import {
  AbstractRunner,
  RunnerOverrides,
  RunnerResult,
  ValidatorResult,
} from "../AbstractRunner";
import { CoverageMapData } from "istanbul-lib-coverage";
import { FuzzEnv } from "../../Types";
import { normalizePathForKey } from "../../Util";
import * as Config from "../../../Config";
import * as JSONN from "../../../Jsonn";
import { VirgilHost } from "./VirgilHost";
import { buildVirgilHarness } from "./VirgilHarness";

export type VirgilHostResponse = {
  tag: "value" | "skip" | "error" | "timeout";
  value?: unknown;
  message?: string;
  name?: string;
  stack?: string;
  source?: "put" | "host";
  seq?: number;
  validators?: Record<string, ValidatorResult>;
  coverageData?: Record<string, unknown>;
};

/**
 * Test runner for compiled Virgil targets.
 */
export class VirgilRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _env: FuzzEnv | undefined;
  protected _overrides: RunnerOverrides;
  protected _host: VirgilHost | undefined = undefined;
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

  public override async onRunStart(): Promise<void> {
    await super.onRunStart();
    this.killHost();
    this._staticCoverage = undefined;

    if (this._env?.options?.measures?.CoverageMeasure?.enabled !== undefined) {
      this._coverageEnabled =
        this._env.options.measures.CoverageMeasure.enabled;
    }

    const { binaryPath, harnessDir, staticCov, staticCovMap } =
      buildVirgilHarness(this._filename, this._fn, this._env);

    this._harnessBinary = binaryPath;
    this._harnessDir = harnessDir;

    const realFile = fs.existsSync(this._filename)
      ? fs.realpathSync(this._filename)
      : this._filename;
    const allStaticCov = staticCovMap ?? { [realFile]: staticCov };
    this._coverageInfo = { ...allStaticCov };
    this._coverageInfo[this._filename] = staticCov;
    this._coverageInfo[this._filename.replace(/\\/g, "/")] = staticCov;
    this._coverageInfo[realFile] = staticCov;
    this._coverageInfo[realFile.replace(/\\/g, "/")] = staticCov;

    for (const [fPath, sCov] of Object.entries(allStaticCov)) {
      const normKey = normalizePathForKey(fPath);
      if (normKey !== fPath) {
        this._coverageInfo[normKey] = sCov;
      }
    }
    this._staticCoverage = structuredClone(this._coverageInfo);
    this._pgmFiles = Object.keys(allStaticCov);

    if (fs.existsSync(this._harnessBinary)) {
      await this._getHost();
    }
  } // fn: onRunStart

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
      const hostPayload: VirgilHostResponse = JSONN.unpack(rawResBuf);

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
      if (e instanceof Error) {
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
      throw e;
    }
  } // fn: run

  protected override async _getHost(): Promise<VirgilHost> {
    if (this._host && this._host.isActive) {
      return this._host;
    }

    if (!this._harnessBinary || !fs.existsSync(this._harnessBinary)) {
      const { binaryPath, harnessDir } = buildVirgilHarness(
        this._filename,
        this._fn,
        this._env
      );
      this._harnessBinary = binaryPath;
      this._harnessDir = harnessDir;
    }

    const host = new VirgilHost(this._harnessBinary, [], this._harnessDir);
    const hostStartupTimeout = Config.get<number>(
      "nanofuzz.fuzzer.hostStartupTimeout",
      20000
    );

    const rawOkBuf = await host.getResponseBuffer(hostStartupTimeout);
    const okcode = JSONN.unpack<string>(rawOkBuf);
    if (okcode === "READY") {
      this._host = host;
      return host;
    }

    host.kill();
    throw new Error(`Virgil runner host failed to start: ${okcode}`);
  } // fn: _getHost

  public override get filename(): string {
    return this._filename;
  } // get: filename

  public override get coverageInfo(): CoverageMapData | undefined {
    return this._coverageInfo;
  } // get: coverageInfo

  public override get lastRunCoverage(): CoverageMapData | undefined {
    return this._lastRunCoverage ?? this._coverageInfo;
  } // get: lastRunCoverage

  public override onCoverage(callback: (covData: unknown) => void): void {
    this._coverageCallback = callback;
  } // fn: onCoverage

  public killHost(): void {
    if (this._host) {
      this._host.kill();
      this._host = undefined;
    }
  } // fn: killHost

  public override async onRunEnd(): Promise<void> {
    await super.onRunEnd();
    this.killHost();
  } // fn: onRunEnd
} // class: VirgilRunner
