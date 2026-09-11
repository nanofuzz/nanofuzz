import { version } from "./version";

/**
 * Fuzzer Runtime version
 */
export { version };

/**
 * Simplified single Fuzzer Test Result
 */
export type FuzzTestResult = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  in: any[]; // function input
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  out: any; // function output
  exception: boolean; // true if an exception was thrown
  timeout: boolean; // true if the fn call timed out
};

/**
 * Throw to skip a test input due to an unsatisfied assumption.
 */
export class UnsatisfiedAssumption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsatisfiedAssumption";
  }
}

/**
 * Evaluates condition for truthiness. If condition is truthy, returns true.
 * If condition is falsy, throws UnsatisfiedAssumption to skip the test input.
 *
 * Optional message parameter provides an explanation for why the condition failed.
 */
export function assume(condition: unknown, message?: string): true {
  if (!condition) {
    throw new UnsatisfiedAssumption(message ?? "Unsatisfied assumption");
  }
  return true;
}
