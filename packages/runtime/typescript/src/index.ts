import * as build from "../package.json";

/**
 * Fuzzer Runtime version
 */
export const version = build.version;

/**
 * Simplified single Fuzzer Test Result
 */
export type FuzzTestResult = {
  in: any[]; // function input
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
