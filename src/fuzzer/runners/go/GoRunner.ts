import fs from "node:fs";
import {
  AbstractRunner,
  RunnerOverrides,
  RunnerResult,
  ValidatorResult,
} from "../AbstractRunner";
import { CoverageMapData, FileCoverageData } from "istanbul-lib-coverage";
import { isRecordOfFileCoverageData } from "../../measures/CoverageMeasure";
import { FuzzEnv } from "../../Types";
import { normalizePathForKey } from "../../Util";
import * as Config from "../../../Config";
import * as JSONN from "../../../Jsonn";
import { PutTimeoutName } from "../AbstractHost";
import { parseCoverageScope } from "../../measures/Util";
import { GoHost } from "./GoHost";
import { buildGoHarness } from "./GoHarness";

/**
 * Test runner for compiled Go targets.
 */
export class GoRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _env: FuzzEnv | undefined;
  protected _overrides: RunnerOverrides;
  protected _host: GoHost | undefined = undefined;
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

    const { binaryPath, harnessDir, staticCov, staticCovMap } = buildGoHarness(
      this._filename,
      this._fn,
      this._env
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

  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0,
    validators: string[] = []
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;
    let host: GoHost | undefined = undefined;

    try {
      host = await this._getHost();

      const input = {
        seq: thisSeq,
        args: inputs,
        validators,
      };

      const payloadBytes = Buffer.from(JSON.stringify(input), "utf-8");
      host.sendMessage(payloadBytes);

      const numFunctions = 1 + (validators?.length ?? 0);
      const hostTimeout =
        timeout && timeout > 0 ? timeout * numFunctions + 1000 : Infinity;

      const rawResBuf = await host.getResponseBuffer(hostTimeout);
      const hostPayload: GoHostResponse = JSONN.parse(
        rawResBuf.toString("utf-8")
      );

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

      let resultValidators: Record<string, ValidatorResult> | undefined;
      if (hostPayload.validators) {
        resultValidators = {};
        for (const [k, v] of Object.entries(hostPayload.validators)) {
          if (v.tag === "skip") {
            resultValidators[k] = { tag: "skip", message: v.message ?? "" };
          } else if (v.tag === "error") {
            resultValidators[k] = { tag: "error", message: v.message ?? "" };
          } else {
            resultValidators[k] = { tag: "value", value: v.value };
          }
        }
      }

      if (hostPayload.tag === "skip") {
        return {
          result: {
            tag: "skip",
            message: hostPayload.message ?? "Assumption failed",
            seq,
            ...(resultValidators ? { validators: resultValidators } : {}),
          },
          env: {},
        };
      }

      if (hostPayload.tag === "error") {
        return {
          result: {
            tag: "error",
            name: hostPayload.name ?? "Panic",
            message: hostPayload.message ?? "",
            source: hostPayload.source === "host" ? "host" : "put",
            seq,
            ...(resultValidators ? { validators: resultValidators } : {}),
          },
          env: {},
        };
      }

      return {
        result: {
          tag: "value",
          value: hostPayload.value,
          seq,
          ...(resultValidators ? { validators: resultValidators } : {}),
        },
        env: {},
      };
    } catch (e: unknown) {
      if (host) {
        this.killHost();
      }
      if (
        e instanceof Error &&
        (e.name === PutTimeoutName || e.message === "PutTimeout")
      ) {
        return {
          result: {
            tag: "timeout",
            seq: thisSeq,
          },
          env: {},
        };
      }
      const err = e instanceof Error ? e : new Error(String(e));
      return {
        result: {
          tag: "error",
          name: err.name,
          message: err.message,
          stack: err.stack,
          source: "put",
          seq: thisSeq,
        },
        env: {},
      };
    }
  } // fn: run

  protected override async _getHost(): Promise<GoHost> {
    if (this._host && this._host.isActive) {
      return this._host;
    }

    if (!this._harnessBinary) {
      const { binaryPath, harnessDir, staticCov, staticCovMap } =
        buildGoHarness(this._filename, this._fn, this._env);
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

    const host = new GoHost(this._harnessBinary, [], this._harnessDir);
    const hostStartupTimeout = Config.get<number>(
      "nanofuzz.fuzzer.hostStartupTimeout",
      20000
    );

    const rawOkBuf = await host.getResponseBuffer(hostStartupTimeout);
    const okcode = JSONN.parse<string>(rawOkBuf.toString("utf-8"));
    if (okcode !== "READY") {
      host.kill();
      throw new Error(`Go runner host failed to start: ${okcode}`);
    }

    this._host = host;

    // Consume static coverage metadata handshake
    const rawCovBuf = await host.getResponseBuffer(hostStartupTimeout);
    const rawCov = JSONN.parse<unknown>(rawCovBuf.toString("utf-8"));
    if (
      !isRecordOfFileCoverageData(rawCov) ||
      Object.keys(rawCov).length === 0
    ) {
      host.kill();
      throw new Error(
        `Go runner host sent invalid static coverage handshake: ${rawCovBuf.toString("utf-8")}`
      );
    }
    this._coverageInfo = rawCov;
    this._staticCoverage = structuredClone(rawCov);
    this._pgmFiles = Object.keys(rawCov);

    // Consume initialization coverage hits (from init() and package var initializations)
    const rawInitCovBuf = await host.getResponseBuffer(hostStartupTimeout);
    const rawInitCov = JSONN.parse<unknown>(rawInitCovBuf.toString("utf-8"));
    if (!isRecordOfFileCoverageData(rawInitCov)) {
      host.kill();
      throw new Error(
        `Go runner host sent invalid initialization coverage handshake: ${rawInitCovBuf.toString("utf-8")}`
      );
    }

    const coverageScopeRaw = Config.get<unknown>(
      "nanofuzz.fuzzer.coverageScope",
      "project static"
    );
    const scopeConfig = parseCoverageScope(coverageScopeRaw);
    const collectStaticCoverage =
      scopeConfig.collectStaticCoverage &&
      this._coverageEnabled &&
      (this._overrides.acceptsStaticCoverage ?? true);

    if (collectStaticCoverage) {
      for (const fileKey of Object.keys(rawInitCov)) {
        const fileCov = rawInitCov[fileKey];
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
      this._staticCoverage = structuredClone(this._coverageInfo);
    }

    return host;
  } // fn: _getHost

  public override get filename(): string {
    return this._filename;
  }

  public get staticCoverage(): CoverageMapData | undefined {
    return this._staticCoverage;
  }

  public get lastRunCoverage(): CoverageMapData | undefined {
    return this._lastRunCoverage;
  }

  public setCoverageCallback(callback: (covData: unknown) => void): void {
    this._coverageCallback = callback;
  }

  public override killHost(): void {
    if (this._host) {
      this._host.kill();
      this._host = undefined;
    }
  } // fn: killHost
} // class: GoRunner

type GoHostResponse = {
  tag: "value" | "error" | "skip" | "timeout";
  value?: unknown;
  message?: string;
  name?: string;
  stack?: string;
  source?: string;
  seq?: number;
  validators?: Record<
    string,
    { tag: "value" | "error" | "skip"; value?: unknown; message?: string }
  >;
  coverageData?: Record<string, FileCoverageData>;
};
