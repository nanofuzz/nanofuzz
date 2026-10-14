import * as Config from "../Config";
import { CompilerStaleness } from "./compilers/Types";
import { Tester as FuzzerV1 } from "./Fuzzer";
import { FuzzerV2 } from "./FuzzerV2";
import { FuzzerV3 } from "./FuzzerV3";
import {
  FuzzEnv,
  FuzzExecutionOptions,
  FuzzerEngineVersion,
  FuzzMode,
  FuzzOptions,
  FuzzPinnedTest,
  FuzzResultCallback,
  FuzzStatusObserver,
  FuzzTestResults,
} from "./Types";

/**
 * Factory that instantiates Fuzzer (V1), FuzzerV2 (V2), or FuzzerV3 (V3)
 * based on parameter or configuration.
 *
 * Priority:
 *  1. `executionOptions.engine` ("v1" | "v2" | "v3" | "auto")
 *  2. Configuration setting `nanofuzz.fuzzer.engine` (default: "auto")
 *
 * When engine is "auto":
 *  - If `executionOptions.workers === 1`, use engine "v2"
 *  - If `executionOptions.workers !== 1`, use engine "v3"
 */
export function FuzzerFactory(
  module: string,
  fnName: string,
  options: FuzzOptions,
  executionOptions?: Partial<FuzzExecutionOptions>
): IFuzzer {
  const normExec = normalizeFuzzExecutionOptions(executionOptions);

  let effectiveEngine = normExec.engine;
  if (normExec.engine === "auto") {
    effectiveEngine = normExec.workers === 1 ? "v2" : "v3";
  }

  const finalExec: FuzzExecutionOptions = {
    ...normExec,
    engine: effectiveEngine,
  };

  switch (effectiveEngine) {
    case "v1":
      return new FuzzerV1(module, fnName, options, finalExec);
    case "v2":
      return new FuzzerV2(module, fnName, options, finalExec);
    case "v3":
    case "auto":
    default:
      return new FuzzerV3(module, fnName, options, finalExec);
  }
} // fn: FuzzerFactory

/**
 * Common public interface implemented by Fuzzer (V1), FuzzerV2 (V2), and FuzzerV3 (V3).
 */
export interface IFuzzer {
  readonly state: "init" | "ready" | "running" | "paused" | "crashed";
  readonly env: FuzzEnv;
  readonly workerCount: number;
  readonly engine: "v1" | "v2" | "v3";
  readonly executionOptions: FuzzExecutionOptions;
  options: FuzzOptions;

  isStale(
    options: FuzzOptions
  ): CompilerStaleness | "optionschanged" | "crashed";

  test(
    injectTests?: FuzzPinnedTest[],
    mode?: FuzzMode,
    observer?: FuzzStatusObserver,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<FuzzTestResults>;

  getInputGeneratorDiagnostics(): string[];
}

export { FuzzerEngineVersion };

/**
 * Returns default execution options for running a fuzzer.
 *
 * @returns complete default FuzzExecutionOptions
 */
export function getDefaultFuzzExecutionOptions(): FuzzExecutionOptions {
  return {
    engine: Config.get<FuzzerEngineVersion>("nanofuzz.fuzzer.engine", "auto"),
    workers: Config.get<number | "auto">("nanofuzz.fuzzer.workers", "auto"),
    outputResults: "all",
    precompile: false,
  };
} // fn: getDefaultFuzzExecutionOptions

/**
 * Normalizes a partial FuzzExecutionOptions into a complete FuzzExecutionOptions.
 *
 * @param options partial execution options
 * @returns complete FuzzExecutionOptions
 */
export function normalizeFuzzExecutionOptions(
  options?: Partial<FuzzExecutionOptions>
): FuzzExecutionOptions {
  const dft = getDefaultFuzzExecutionOptions();
  return {
    engine: options?.engine ?? dft.engine,
    workers: options?.workers ?? dft.workers,
    outputResults: options?.outputResults ?? dft.outputResults,
    precompile: options?.precompile ?? dft.precompile,
  };
} // fn: normalizeFuzzExecutionOptions
