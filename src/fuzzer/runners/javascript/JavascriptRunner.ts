import {
  AbstractRunner,
  RunnerInput,
  RunnerResult,
  TypeHint,
} from "../AbstractRunner";
import { ArgDef } from "../../analysis/ArgDef";
import { ArgTag } from "../../analysis/Types";
import { NodeHost } from "./NodeHost";
import { FuzzEnv } from "../../Fuzzer";
import { findInAncestor, isError, normalizePathForKey } from "../../Util";
import { PutTimeoutName } from "../AbstractHost";
import * as CompilerFactory from "../../compilers/CompilerFactory";
import * as JSONN from "../../../Jsonn";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Javascript runner
 */
export class JavascriptRunner extends AbstractRunner {
  protected _filename: string;
  protected _jsFn: string;
  protected _env: FuzzEnv | undefined;
  protected _host: NodeHost | undefined = undefined;
  protected _seq = 0;
  protected _coverageInfo: unknown = undefined;

  /**
   * Create a new Javascript function runner
   *
   * @param `module` loaded program module or file path
   * @param `jsFn` exported function within `module` to call
   * @param `env` optional fuzzer environment
   */
  public constructor(
    module: NodeJS.Module | string,
    jsFn: string,
    env?: FuzzEnv
  ) {
    super(jsFn);

    this._jsFn = jsFn;
    this._env = env;

    let targetPath = getModuleFilename(module, env);

    if (targetPath) {
      const compiler = CompilerFactory.fromSourcefile(targetPath);
      if (compiler) {
        const compiledJs = compiler.getJsFilename(targetPath);
        if (fs.existsSync(compiledJs)) {
          targetPath = compiledJs;
        }
      }
    }

    this._filename = targetPath;
  } // fn: constructor

  /**
   * Prepares the runner for the start of the test run
   */
  public async onRunStart(): Promise<void> {
    await super.onRunStart();
    this._killHost();
    await this._getHost();
  } // fn: onRunStart

  /**
   * Run `jsFn` in `module` with `inputs`
   *
   * @param `inputs` inputs to function
   * @param `timeout` stop and fail after `timeout` ms
   * @returns Promise<RunnerResult>
   */
  public async run(
    inputs: unknown[],
    timeout: number | undefined = 0
  ): Promise<RunnerResult> {
    const thisSeq = this._seq++;
    try {
      const host = await this._getHost();
      const typeHints = this._env?.function.getArgDefs().map(getTypeHint) ?? [];

      const input: RunnerInput = {
        args: inputs,
        seq: thisSeq,
        typeHints,
        timeout: timeout ?? 0,
        fnName: this._jsFn,
        filename: this._filename,
      };

      const payload = JSONN.stringify(input, (_key, val) => {
        if (val instanceof Uint8Array || val instanceof Set) {
          return Array.from(val);
        }
        if (val instanceof Map) {
          return Object.fromEntries(val);
        }
        return val;
      });

      host.sendMessage(payload);
      const hostTimeout = timeout && timeout > 0 ? timeout + 200 : Infinity;
      const rawRes = await host.getResponse(hostTimeout);
      const parsedRes = JSONN.parse(rawRes);

      if (isParsedHostResponse(parsedRes) && parsedRes.coverageData) {
        const globalCov = getGlobalCoverageMap();
        for (const fileKey of Object.keys(parsedRes.coverageData)) {
          const normKey = normalizeCoveragePath(fileKey);
          const fileCov = parsedRes.coverageData[fileKey];
          if (fileCov) {
            const targetObj = globalCov[normKey];
            if (!targetObj) {
              const newCov: FileCoverageData = structuredClone(fileCov);
              newCov.path = normKey;
              globalCov[normKey] = newCov;
            } else {
              if (fileCov.s && targetObj.s) {
                for (const sKey of Object.keys(fileCov.s)) {
                  targetObj.s[sKey] =
                    (targetObj.s[sKey] ?? 0) + (fileCov.s[sKey] ?? 0);
                }
              }
              if (fileCov.f && targetObj.f) {
                for (const fKey of Object.keys(fileCov.f)) {
                  targetObj.f[fKey] =
                    (targetObj.f[fKey] ?? 0) + (fileCov.f[fKey] ?? 0);
                }
              }
              if (fileCov.b && targetObj.b) {
                for (const bKey of Object.keys(fileCov.b)) {
                  if (!targetObj.b[bKey]) {
                    targetObj.b[bKey] = [...(fileCov.b[bKey] ?? [])];
                  } else if (Array.isArray(fileCov.b[bKey])) {
                    for (let i = 0; i < fileCov.b[bKey].length; i++) {
                      targetObj.b[bKey][i] =
                        (targetObj.b[bKey][i] ?? 0) + (fileCov.b[bKey][i] ?? 0);
                    }
                  }
                }
              }
            }
          }
        }
      }

      let resultInner: RunnerResult["result"];
      if (isParsedHostResponse(parsedRes)) {
        const seq = typeof parsedRes.seq === "number" ? parsedRes.seq : thisSeq;
        if (parsedRes.tag === "timeout") {
          resultInner = { tag: "timeout", seq };
        } else if (parsedRes.tag === "skip") {
          resultInner = {
            tag: "skip",
            message: parsedRes.message ?? "",
            seq,
          };
        } else if (parsedRes.tag === "error") {
          resultInner = {
            tag: "error",
            name: parsedRes.name ?? "Error",
            message: parsedRes.message ?? "",
            stack: parsedRes.stack,
            source: parsedRes.source,
            seq,
          };
        } else {
          resultInner = {
            tag: "value",
            value: parsedRes.value,
            seq,
          };
        }
      } else {
        resultInner = {
          tag: "error",
          name: "UnknownJavascriptRunnerError",
          message: "Invalid response from host",
          seq: thisSeq,
        };
      }

      const result: RunnerResult = {
        result: resultInner,
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
   * Tears down the runner host at the end of the test run
   */
  public async onRunEnd(): Promise<void> {
    await super.onRunEnd();
    this._killHost();
  } // fn: onRunEnd

  /**
   * Get the current Node host process (creates a new one if needed)
   */
  protected async _getHost(): Promise<NodeHost> {
    if (this._host !== undefined) {
      if (this._host.isActive) {
        return this._host;
      } else {
        this._host.kill();
        this._host = undefined;
      }
    }

    const currModuleDir = path.dirname(path.resolve(module.filename));
    const projectRoot = findInAncestor(currModuleDir, "package.json");
    if (projectRoot === undefined) {
      throw new Error(`Unable to find project root from: ${currModuleDir}`);
    }
    const runnerHost = path.resolve(
      path.join(
        path.dirname(projectRoot),
        "build",
        "extension",
        "JavascriptRunnerHost.js"
      )
    );

    const args = [runnerHost, this._filename, this._jsFn];
    const host = new NodeHost(args, path.dirname(this._filename));

    const okcode = await host.getResponse(10000);
    if (JSONN.parse(okcode) === "READY") {
      this._host = host;
      const initialCoverage = JSONN.parse(await host.getResponse(10000));
      this._coverageInfo = initialCoverage;

      // Populate main process global.__coverage__ with static map structures
      if (isCoverageMap(initialCoverage)) {
        const globalCov = getGlobalCoverageMap();
        for (const rawKey of Object.keys(initialCoverage)) {
          const normKey = normalizeCoveragePath(rawKey);
          const fileCov = initialCoverage[rawKey];
          if (fileCov && !globalCov[normKey]) {
            const newCov: FileCoverageData = structuredClone(fileCov);
            newCov.path = normKey;
            globalCov[normKey] = newCov;
          }
        }
      }

      return host;
    } else {
      host.kill();
      throw new Error(`NodeHost not ready (okcode: ${okcode})`);
    }
  } // fn: _getHost

  /**
   * Kill the current Node host
   */
  protected _killHost(): void {
    if (this._host !== undefined) {
      this._host.kill();
      this._host = undefined;
    }
  } // fn: _killHost
} // class: JavascriptRunner

type FileCoverageData = {
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
  path?: string;
};

type ParsedHostResponse = {
  seq?: number;
  tag?: "value" | "timeout" | "skip" | "error";
  value?: unknown;
  message?: string;
  name?: string;
  stack?: string;
  source?: "put" | "host";
  coverageData?: Record<string, FileCoverageData>;
};

function isParsedHostResponse(val: unknown): val is ParsedHostResponse {
  return typeof val === "object" && val !== null;
}

function isCoverageMap(
  val: unknown
): val is Record<string, FileCoverageData | undefined> {
  return typeof val === "object" && val !== null;
}

function getGlobalCoverageMap(): Record<string, FileCoverageData | undefined> {
  let cov = Reflect.get(globalThis, "__coverage__");
  if (!isCoverageMap(cov)) {
    cov = {};
    Reflect.set(globalThis, "__coverage__", cov);
  }
  return cov;
}

function normalizeCoveragePath(p: string): string {
  return normalizePathForKey(p);
}

function getModuleFilename(
  module: NodeJS.Module | string,
  env?: FuzzEnv
): string {
  if (typeof module === "string") {
    return module;
  }
  if (
    typeof module === "object" &&
    module !== null &&
    "filename" in module &&
    typeof module.filename === "string"
  ) {
    return module.filename;
  }
  if (env?.function) {
    return env.function.getModule();
  }
  return "";
}

function isUuidArg(arg: ArgDef): boolean {
  return arg.getTypeRef() === "UUID" && arg.getType() === ArgTag.STRING;
}

function getBaseTypeHint(arg: ArgDef): TypeHint {
  if (isUuidArg(arg)) {
    return "uuid";
  }
  if (
    arg.getType() === ArgTag.BYTES ||
    arg.getTypeRef() === "bytes" ||
    arg.getTypeRef() === "bytearray" ||
    arg.getTypeRef() === "Uint8Array"
  ) {
    return "bytes";
  }

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
    case ArgTag.UNION:
      return {
        kind: "union",
        arms: arg.getChildren().map(getTypeHint),
      };
    case ArgTag.BYTES:
      return "bytes";
    case ArgTag.NUMBER:
      return "number";
    case ArgTag.DICTIONARY: {
      const children = arg.getChildren();
      const keyHint = children[0] ? getTypeHint(children[0]) : "default";
      const valHint = children[1] ? getTypeHint(children[1]) : "default";
      return { kind: "dictionary", key: keyHint, value: valHint };
    }
    case ArgTag.STRING:
    case ArgTag.BOOLEAN:
    case ArgTag.LITERAL:
    case ArgTag.UNRESOLVED:
    default:
      return "default";
  }
}

function getTypeHint(arg: ArgDef): TypeHint {
  const dims = arg.getDim();
  let hint: TypeHint = getBaseTypeHint(arg);
  for (let i = 0; i < dims; i++) {
    hint = { kind: "array", element: hint };
  }
  return hint;
}
