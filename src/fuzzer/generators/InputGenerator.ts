import { FuzzEnv } from "fuzzer/Fuzzer";
import { FuzzIoElement, FuzzTestResult } from "fuzzer/Types";
import { CoverageSummary } from "istanbul-lib-coverage";

export interface InputGenerator {
  init(env: FuzzEnv): void;
  next(): FuzzIoElement[];
  onResult?(result: FuzzTestResult, coverageSummary?: CoverageSummary): void;
}
