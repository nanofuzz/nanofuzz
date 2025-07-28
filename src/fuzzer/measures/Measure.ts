import { FuzzTestResults } from "fuzzer/Fuzzer";

// export interface Measure {
//   /** Name for logging/debugging. */
//   readonly name: string;

//   /** How important this measure is relative to others. Dynamically changes. */
//   weight: number;

//   // measure(result: FuzzTestResult): number;

//   // measure function

//   // progress
// }

export abstract class Measure {
  /** Unique measure identifier. */
  static get id(): string {
    throw new Error("Must override in subclass. id");
  }

  static measure(results: FuzzTestResults): number {
    throw new Error("Must override in subclass. measure");
  }
}
