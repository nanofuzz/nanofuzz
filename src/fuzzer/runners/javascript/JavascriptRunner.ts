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
import { isCoverageMapData } from "../../measures/TypescriptCoverageMeasure";
import { CoverageMapData } from "istanbul-lib-coverage";
import { findInAncestor, isError } from "../../Util";
import { PutTimeoutName } from "../AbstractHost";
import * as CompilerFactory from "../../compilers/CompilerFactory";
import * as Config from "../../../Config";
import { serialize, deserialize } from "node:v8";
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
  protected _coverageInfo: CoverageMapData | undefined = undefined;
  protected _coverageEnabled = true;
  protected _coverageCallback?: (covData: unknown) => void;

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
    if (this._env?.options?.measures?.CoverageMeasure?.enabled !== undefined) {
      this._coverageEnabled =
        this._env.options.measures.CoverageMeasure.enabled;
    }
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

      const debugEnabled = Config.get<boolean>("nanofuzz.debug.runners", false);
      const input: RunnerInput = {
        args: inputs,
        seq: thisSeq,
        typeHints,
        timeout: timeout ?? 0,
        fnName: this._jsFn,
        filename: this._filename,
        collect: {
          coverageData: this._coverageEnabled ? true : undefined,
          debugData: debugEnabled ? true : undefined,
        },
      };

      const payload = serialize(input);

      host.sendMessage(payload);
      const hostTimeout = timeout && timeout > 0 ? timeout + 200 : Infinity;
      const rawResBuf = await host.getResponseBuffer(hostTimeout);
      const parsedRes = deserialize(rawResBuf);

      if (isParsedHostResponse(parsedRes) && parsedRes.coverageData) {
        if (isCoverageMapData(parsedRes.coverageData)) {
          this._coverageInfo = parsedRes.coverageData;
        }
        this._coverageCallback?.(parsedRes.coverageData);
      }

      let resultInner: RunnerResult["result"];
      if (isParsedHostResponse(parsedRes)) {
        const seq = typeof parsedRes.seq === "number" ? parsedRes.seq : thisSeq;
        if (parsedRes.tag === "timeout") {
          resultInner = {
            tag: "timeout",
            seq,
          };
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
   * Gets the current code coverage information.
   *
   * @returns the current code coverage information, or `undefined` if not available
   */
  public override get coverageInfo(): CoverageMapData | undefined {
    return this._coverageInfo;
  } // property: get coverageInfo

  /**
   * Registers a callback to be invoked when coverage data is available.
   *
   * @param callback a function to be called with coverage data
   */
  public override onCoverage(callback: (covData: unknown) => void): void {
    this._coverageCallback = callback;
  } // fn: onCoverage

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

    const hostStartupTimeout = Config.get<number>(
      "nanofuzz.fuzzer.hostStartupTimeout",
      10000
    );
    const okcodeBuf = await host.getResponseBuffer(hostStartupTimeout);
    const okcode = deserialize(okcodeBuf);
    if (okcode === "READY") {
      this._host = host;
      const initialCoverage = deserialize(
        await host.getResponseBuffer(hostStartupTimeout)
      );
      if (isCoverageMapData(initialCoverage)) {
        this._coverageInfo = initialCoverage;
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
