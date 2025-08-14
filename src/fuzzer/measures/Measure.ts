import { FuzzTestResults } from "../Fuzzer";

export abstract class Measure {
  /** Unique measure identifier. */
  static get id(): string {
    throw new Error("Must override in subclass. id");
  }

  static measure(results: FuzzTestResults): number {
    throw new Error("Must override in subclass. measure");
  }
}
