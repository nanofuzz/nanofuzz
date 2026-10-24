import fs from "node:fs";
import {
  AbstractRunner,
  RunnerOverrides,
  RunnerResult,
  ValidatorResult,
  TypeHint,
  RunnerInput,
} from "../AbstractRunner";
import { CoverageMapData } from "istanbul-lib-coverage";
import { isRecordOfFileCoverageData } from "../../measures/CoverageMeasure";
import { FuzzEnv } from "../../Types";
import { isError, normalizePathForKey } from "../../Util";
import * as Config from "../../../Config";
import { ArgDef } from "../../analysis/ArgDef";
import { ArgTag } from "../../analysis/Types";
import { PutTimeoutName } from "../AbstractHost";
import { OxcamlHost } from "./OxcamlHost";
import { buildOxcamlHarness } from "./OxcamlHarness";

/**
 * Test runner for compiled OCaml / OxCaml targets.
 */
export class OxcamlRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;
  protected _env: FuzzEnv | undefined;
  protected _overrides: RunnerOverrides;
  protected _host: OxcamlHost | undefined = undefined;
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
    const { binaryPath, harnessDir, staticCov, staticCovMap } =
      buildOxcamlHarness(this._filename, this._fn, this._env);
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
   * @returns RunnerResult containing output, exception error, skip, or timeout
   */
  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0,
    validators: string[] = []
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;

    try {
      const host = await this._getHost();

      const typeHints =
        this._env?.function?.getArgDefs().map(getTypeHint) ?? [];
      const input: RunnerInput = {
        seq: thisSeq,
        args: inputs,
        typeHints,
        timeout: timeout ?? 0,
        validators: validators.length > 0 ? validators : undefined,
      };

      const serialized = JSON.stringify(input, (_key, val) => {
        if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
          return Array.from(val);
        }
        if (val instanceof Set) {
          return { __nanofuzz_set: Array.from(val.values()) };
        }
        if (val instanceof Map) {
          return { __nanofuzz_map: Array.from(val.entries()) };
        }
        if (typeof val === "bigint") {
          return val.toString();
        }
        return val;
      });

      host.sendMessage(serialized);

      const numFunctions = 1 + (validators?.length ?? 0);
      const hostTimeout =
        timeout && timeout > 0 ? timeout * numFunctions + 500 : Infinity;
      const rawResBuf = await host.getResponseBuffer(hostTimeout);
      const hostPayload: OxcamlHostResponse = JSON.parse(
        rawResBuf.toString("utf8")
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
          name: hostPayload.name ?? "Exception",
          message: hostPayload.message ?? "",
          stack: hostPayload.stack,
          source: hostPayload.source ?? "put",
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      } else {
        let val = hostPayload.value;
        const retDef = this._env?.function?.getReturnArg();
        if (retDef) {
          val = transformHostResult(val, retDef);
        }
        resultInner = {
          tag: "value",
          value: val,
          seq,
          ...(hostValidators ? { validators: hostValidators } : {}),
        };
      }

      return {
        result: resultInner,
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
  protected override async _getHost(): Promise<OxcamlHost> {
    if (this._host && this._host.isActive) {
      return this._host;
    }

    if (!this._harnessBinary) {
      const { binaryPath, harnessDir, staticCov, staticCovMap } =
        buildOxcamlHarness(this._filename, this._fn, this._env);
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

    const host = new OxcamlHost(this._harnessBinary, [], this._harnessDir);
    const hostStartupTimeout = Config.get<number>(
      "nanofuzz.fuzzer.hostStartupTimeout",
      20000
    );

    const rawOkBuf = await host.getResponseBuffer(hostStartupTimeout);
    const okcode = JSON.parse(rawOkBuf.toString("utf8"));
    if (okcode === "READY") {
      this._host = host;
      // Consume initial static coverage handshake message
      const rawCovBuf = await host.getResponseBuffer(hostStartupTimeout);
      try {
        const rawCov = JSON.parse(rawCovBuf.toString("utf8"));
        if (rawCov && typeof rawCov === "object") {
          const covInfo = rawCov.covInfo ?? rawCov;
          const files = rawCov.files ?? Object.keys(covInfo);
          if (covInfo && Object.keys(covInfo).length > 0) {
            this._coverageInfo = covInfo;
            this._staticCoverage = structuredClone(covInfo);
            this._pgmFiles = files;
          }
        }
      } catch {
        // Fall back to pre-calculated static coverage
      }
      return host;
    } else {
      host.kill();
      throw new Error(`Oxcaml runner host failed to start: ${okcode}`);
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
} // class: OxcamlRunner

type OxcamlHostResponse = {
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

/**
 * Transforms the raw value returned from the OCaml host process back to JavaScript domain types.
 */
function transformHostResult(val: unknown, retArgDef?: ArgDef): unknown {
  if (!retArgDef || val === null || val === undefined) return val;

  const typeRef = retArgDef.getTypeRef() ?? "";
  const isSet =
    retArgDef.getType() === ArgTag.SET ||
    typeRef.endsWith("Set.t") ||
    typeRef.includes(".Set.t") ||
    typeRef === "Set.t";
  const isDict =
    retArgDef.getType() === ArgTag.DICTIONARY ||
    typeRef.includes("Map") ||
    typeRef.includes("Hashtbl");

  if (retArgDef.getType() === ArgTag.BYTES || typeRef === "bytes") {
    if (val instanceof Uint8Array) return val;
    if (Array.isArray(val)) {
      const nums: number[] = [];
      for (const item of val) {
        if (typeof item === "number") {
          nums.push(item);
        }
      }
      return new Uint8Array(nums);
    }
    if (typeof val === "string") {
      return new Uint8Array(Buffer.from(val, "binary"));
    }
  }

  if (isSet) {
    if (val instanceof Set) return val;
    if (Array.isArray(val)) {
      return new Set(val);
    }
  }

  if (isDict) {
    if (val instanceof Map) return val;
    if (Array.isArray(val)) {
      const entries: [unknown, unknown][] = [];
      for (const item of val) {
        if (Array.isArray(item) && item.length >= 2) {
          entries.push([item[0], item[1]]);
        }
      }
      return new Map(entries);
    }
    if (typeof val === "object" && val !== null) {
      return new Map(Object.entries(val));
    }
  }

  return val;
} // fn: transformHostResult

/**
 * Derives a base TypeHint for an argument definition in OCaml.
 */
function getBaseTypeHint(arg: ArgDef): TypeHint {
  if (arg.getType() === ArgTag.BYTES || arg.getTypeRef() === "bytes") {
    return "bytes";
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (arg.getType()) {
    case ArgTag.SET: {
      const [elemChild] = arg.getChildren();
      const elemHint = elemChild ? getTypeHint(elemChild) : "default";
      return { kind: "set", element: elemHint };
    }
    case ArgTag.TUPLE:
      return {
        kind: "tuple",
        elements: arg.getChildren().map(getTypeHint),
      };
    case ArgTag.OBJECT: {
      const fields: Record<string, TypeHint> = {};
      for (const child of arg.getChildren()) {
        fields[child.getName()] = getTypeHint(child);
      }
      return { kind: "object", fields };
    }
    case ArgTag.DICTIONARY: {
      const children = arg.getChildren();
      const keyHint = children[0] ? getTypeHint(children[0]) : "default";
      const valHint = children[1] ? getTypeHint(children[1]) : "default";
      return { kind: "dictionary", key: keyHint, value: valHint };
    }
    case ArgTag.BIGINT:
    case ArgTag.NUMBER:
      return arg.getOptions().numInteger ? "int" : "float";
    default:
      return "default";
  }
} // fn: getBaseTypeHint

/**
 * Gets the structural TypeHint for an argument definition including array dimensions.
 */
function getTypeHint(arg: ArgDef): TypeHint {
  const dims = arg.getDim();
  let hint: TypeHint = getBaseTypeHint(arg);
  for (let i = 0; i < dims; i++) {
    hint = { kind: "array", element: hint };
  }
  return hint;
} // fn: getTypeHint
