import { ArgOptions, FunctionRef } from "./analysis/typescript/Types";
import { FunctionDef } from "./analysis/typescript/FunctionDef";
import * as vscode from "vscode";

/**
 * Fuzzer Input/Output Element; i.e., a concrete input or output value
 */
export type FuzzIoElement = {
  name: string; // name of element
  offset: number; // offset of element (0-based)
  value: any; // value of element
};

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  extensionUri: vscode.Uri; // extension URI
  function: FunctionDef; // the function to fuzz
};

/**
 * Fuzzer Options that specify the fuzzing behavior
 */
export type FuzzOptions = {
  //outputFile?: string; // optional file to receive the fuzzing output (JSON format)
  argDefaults: ArgOptions; // default options for arguments
  seed?: string; // optional seed for pseudo-random number generator
  maxTests: number; // number of fuzzing tests to execute (>= 0)
  fnTimeout: number; // timeout threshold in ms per test
  suiteTimeout: number; // timeout for the entire test suite
  // !!! oracleFn: // TODO The oracle function
};

/**
 * Fuzzer Test Result
 */
export type FuzzTestResults = {
  env: FuzzEnv; // fuzzer environment
  results: FuzzTestResult[]; // fuzzing test results
};

/**
 * Single Fuzzer Test Result
 */
export type FuzzTestResult = {
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  exception: boolean; // true if an exception was thrown
  exceptionMessage?: string; // exception message if an exception was thrown
  stack?: string; // stack trace if an exception was thrown
  timeout: boolean; // true if the fn call timed out
  passed: boolean; // true if output matches oracle; false, otherwise
};

// !!!
export type FuzzWorkerInput = {
  fnRef: FunctionRef; // function reference
  inputs: FuzzIoElement[]; // function input
};

// !!!
export type FuzzWorkerOutput = {
  exception?: string;
  output: any | undefined;
  timeout: boolean;
};
