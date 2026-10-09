import * as Config from "../Config";
import { CompilerStaleness } from "./compilers/Types";
import { Tester as FuzzerV1 } from "./Fuzzer";
import { FuzzerV2 } from "./FuzzerV2";
import { FuzzerV3 } from "./FuzzerV3";
import {
  FuzzEnv,
  FuzzMode,
  FuzzOptions,
  FuzzPinnedTest,
  FuzzResultCallback,
  FuzzStatusUpdater,
  FuzzTestResults,
} from "./Types";

/**
 * Common public interface implemented by Fuzzer (V1), FuzzerV2 (V2), and FuzzerV3 (V3).
 */
export interface IFuzzer {
  readonly state: "init" | "ready" | "running" | "paused" | "crashed";
  readonly env: FuzzEnv;
  readonly workerCount: number;
  readonly engine: "v1" | "v2" | "v3";
  options: FuzzOptions;

  isStale(
    options: FuzzOptions
  ): CompilerStaleness | "optionschanged" | "crashed";

  test(
    injectTests?: FuzzPinnedTest[],
    mode?: FuzzMode,
    updateFn?: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<FuzzTestResults>;

  getInputGeneratorDiagnostics(): string[];
}

export type FuzzerEngineVersion = "v1" | "v2" | "v3" | "auto";

/**
 * Factory that instantiates Fuzzer (V1), FuzzerV2 (V2), or FuzzerV3 (V3)
 * based on parameter or configuration.
 *
 * Priority:
 *  1. `mode.engine` ("v1" | "v2" | "v3" | "auto")
 *  2. Configuration setting `nanofuzz.fuzzer.engine` (default: "auto")
 *
 * When engine is "auto":
 *  - If `options.workers === 1`, use engine "v2"
 *  - If `options.workers !== 1`, use engine "v3"
 */
export function FuzzerFactory(
  module: string,
  fnName: string,
  options: FuzzOptions,
  mode: { precompile?: true; engine?: FuzzerEngineVersion } = {}
): IFuzzer {
  const engine =
    mode.engine ?? Config.get<string>("nanofuzz.fuzzer.engine", "auto");

  let effectiveEngine = engine;
  if (engine === "auto") {
    effectiveEngine = options?.workers === 1 ? "v2" : "v3";
  }

  switch (effectiveEngine) {
    case "v1":
      return new FuzzerV1(module, fnName, options, mode);
    case "v2":
      return new FuzzerV2(module, fnName, options, mode);
    case "v3":
    default:
      return new FuzzerV3(module, fnName, options, mode);
  }
}
