import { FuzzEnv } from "fuzzer/Fuzzer";
import { FuzzIoElement, FuzzTestResult } from "fuzzer/Types";
import { CoverageSummary } from "istanbul-lib-coverage";

export interface InputGenerator {
  /** Name for logging/debugging. */
  readonly name: string;

  /** Produce the next test-case inputs. */
  next(): FuzzIoElement[];

  /** (optional) If the generator is available for use. */
  isAvailable?(): boolean;
}
