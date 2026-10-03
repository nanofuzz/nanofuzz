import * as Config from "../Config";
import { CompilerStaleness } from "./compilers/Types";
import {
  FuzzEnv,
  FuzzMode,
  FuzzTestResults,
  Tester as FuzzerV1,
} from "./Fuzzer";
import { FuzzerV2 } from "./FuzzerV2";
import {
  FuzzOptions,
  FuzzPinnedTest,
  FuzzResultCallback,
  FuzzStatusUpdater,
} from "./Types";

/**
 * Common public interface implemented by both Fuzzer (V1) and FuzzerV2 (V2).
 */
export interface IFuzzer {
  readonly state: "init" | "ready" | "running" | "paused" | "crashed";
  readonly env: FuzzEnv;
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

export type FuzzerEngineVersion = "v1" | "v2";

/**
 * Factory that instantiates either the classic Fuzzer (V1) or the modernized FuzzerV2 (V2)
 * based on parameter or configuration.
 *
 * Priority:
 *  1. `mode.engine` ("v1" | "v2")
 *  2. Configuration setting `nanofuzz.fuzzer.engine` (default: "v2")
 */
export function FuzzerFactory(
  module: string,
  fnName: string,
  options: FuzzOptions,
  mode: { precompile?: true; engine?: FuzzerEngineVersion } = {}
): IFuzzer {
  const engine =
    mode.engine ?? Config.get<string>("nanofuzz.fuzzer.engine", "v2");

  return engine === "v1"
    ? new FuzzerV1(module, fnName, options, mode)
    : new FuzzerV2(module, fnName, options, mode);
}

export { FuzzerV1, FuzzerV2 };
export { FuzzExecutor } from "./FuzzExecutor";
export { FuzzStats } from "./FuzzStats";
