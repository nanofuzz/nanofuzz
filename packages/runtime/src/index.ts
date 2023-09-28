import * as fuzzer from "./fuzzer/Types";
import * as build from "./build.json";

/**
 * Fuzzer Runtime version
 */
export const versions = build.versions;

/**
 * Single Fuzzer Test Result
 */
export type FuzzTestResult = fuzzer.FuzzTestResult;

/**
 * Fuzzer Input/Output Element; i.e., a concrete input or output value
 */
export type FuzzIoElement = fuzzer.FuzzIoElement;
