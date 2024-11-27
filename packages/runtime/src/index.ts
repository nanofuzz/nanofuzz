import * as fuzzer from "./fuzzer/Types";
import * as build from "./build.json";

/**
 * Fuzzer Runtime version
 */
export const versions = build.versions;

/**
 * Simplified single Fuzzer Test Result.
 *
 * Structurally equivalent to fuzzer.Result with more informative geenric
 * types for in and out.
 */
export type FuzzTestResult<T extends unknown[], U> = {
  in: T; // function input
  out: U; // function output
  exception: boolean; // true if an exception was thrown
  timeout: boolean; // true if the fn call timed out
};

/**
 * Fuzzer Input/Output Element; i.e., a concrete input or output value
 */
export type FuzzIoElement = fuzzer.FuzzIoElement;
