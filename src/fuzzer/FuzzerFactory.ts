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

  testSync(
    injectTests?: FuzzPinnedTest[],
    mode?: FuzzMode,
    updateFn?: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<FuzzTestResults>;

  testAsync(
    injectTests?: FuzzPinnedTest[],
    mode?: FuzzMode,
    callbackFn?: (result: FuzzTestResults | Error) => void,
    statusFn?: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<void>;

  getInputGeneratorDiagnostics(): string[];
}

export type FuzzerEngineVersion = "v1" | "v2";

/**
 * Factory that instantiates either the classic Fuzzer (V1) or the modernized FuzzerV2 (V2)
 * based on parameter, configuration, or environment variable.
 *
 * Priority:
 *  1. `mode.engine` ("v1" | "v2")
 *  2. `process.env.NANOFUZZ_ENGINE` ("v1" | "v2")
 *  3. Configuration setting `nanofuzz.fuzzer.engine` (default: "v1")
 */
export function FuzzerFactory(
  module: string,
  fnName: string,
  options: FuzzOptions,
  mode: { precompile?: true; engine?: FuzzerEngineVersion } = {}
): IFuzzer {
  const envEngine =
    process.env.NANOFUZZ_ENGINE === "v2"
      ? "v2"
      : process.env.NANOFUZZ_ENGINE === "v1"
        ? "v1"
        : undefined;

  const engine: FuzzerEngineVersion =
    mode.engine ??
    envEngine ??
    Config.get<FuzzerEngineVersion>("nanofuzz.fuzzer.engine", "v1");

  if (engine === "v2") {
    return new FuzzerV2(module, fnName, options, mode);
  }
  return new FuzzerV1(module, fnName, options, mode);
}

export { FuzzerV1, FuzzerV2 };
export { FuzzExecutor } from "./FuzzExecutor";
export { FuzzStats } from "./FuzzStats";
