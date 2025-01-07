import { ArgOptions } from "./analysis/typescript/Types";

/**
 * Single Fuzzer Test Result
 */
export type FuzzTestResult = {
  pinned: boolean; // true if the test was pinned (not randomly generated)
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  exception: boolean; // true if an exception was thrown
  exceptionMessage?: string; // exception message if an exception was thrown
  stack?: string; // stack trace if an exception was thrown
  timeout: boolean; // true if the fn call timed out
  passedImplicit: boolean; // true if output matches implicit oracle; false, otherwise
  passedHuman?: boolean; // true if actual output matches human-expected output
  passedValidator?: boolean; // true if passed all custom validators; false, otherwise
  passedValidators?: boolean[]; // for each custom validator, true if passed; false, otherwise
  validatorException: boolean; // true if validator threw an exception
  validatorExceptionMessage?: string; // validator exception message
  validatorExceptionStack?: string; // validator stack trace if exception was thrown
  elapsedTime: number; // elapsed time of test
  expectedOutput?: FuzzIoElement[]; // the expected output, if any
  category: FuzzResultCategory; // the ResultCategory of the test result
};

/**
 * Simplified single test result for writing custom validator
 */
export type Result = {
  in: any[]; // function input
  out: any; // function output
  exception: boolean; // true if an exception was thrown
  timeout: boolean; // true if the fn call timed out
};

/**
 * Fuzzer Tests - intended to be persisted a fuzzer configuration and
 * its tests to the file system
 */
export type FuzzTests = {
  version: string; // version of the fuzzer writing the file
  functions: Record<string, FuzzTestsFunction>; // fuzzer functions{
};
export type FuzzTestsFunction = {
  options: FuzzOptions; // fuzzer options
  argOverrides?: FuzzArgOverride[]; // argument overrides
  sortColumns?: FuzzSortColumns; // column sort order
  validators: string[]; // validator functions
  tests: Record<string, FuzzPinnedTest>; // pinned tests
  isVoid: boolean; // is the function return type void?
};

/**
 * Pinned Fuzzer Tests
 */
export type FuzzPinnedTest = {
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  pinned: boolean; // is the test pinned?
  expectedOutput?: FuzzIoElement[]; // the expected output, if any
};

/**
 * Fuzzer Input/Output Element; i.e., a concrete input or output value
 */
export type FuzzIoElement = {
  name: string; // name of element
  offset: number; // offset of element (0-based)
  isException?: boolean; // true if element is an exception
  isTimeout?: boolean; // true if element is a timeout
  value: any; // value of element
};

/**
 * Category of a test result
 */
export type FuzzResultCategory =
  | "ok"
  | "badValue"
  | "timeout"
  | "exception"
  | "disagree"
  | "failure"; // Validator failure (e.g., threw an exception)

/**
 * Fuzzer Options that specify the fuzzing behavior
 */
export type FuzzOptions = {
  outputFile?: string; // optional file to receive the fuzzing output (JSON format)
  argDefaults: ArgOptions; // default options for arguments
  seed?: string; // optional seed for pseudo-random number generator
  maxTests: number; // number of fuzzing tests to execute (>= 0)
  maxDupeInputs: number; // maximum number of duplicate inputs before stopping (>=0)
  maxFailures: number; // maximum number of failures to report (>=0)
  onlyFailures: boolean; // only report tests that do not pass
  fnTimeout: number; // timeout threshold in ms per test
  suiteTimeout: number; // timeout for the entire test suite
  useImplicit: boolean; // use implicit oracle
  useHuman: boolean; // use human oracle
  useProperty: boolean; // use property validator oracle
};

/**
 * Column sort orders by FuzzResultCategory and column name
 */
export type FuzzSortColumns = Record<
  FuzzResultCategory,
  Record<string, FuzzSortOrder>
>;
export enum FuzzSortOrder {
  asc = "asc",
  desc = "desc",
  none = "none",
}

/**
 * Fuzzer Argument Override - passed from front-end to back-end
 * to override the default argument options (e.g., min, max, etc.)
 */
export type FuzzArgOverride = {
  number?: {
    min: number;
    max: number;
    numInteger: boolean;
  };
  boolean?: {
    min: boolean;
    max: boolean;
  };
  string?: {
    minStrLen: number;
    maxStrLen: number;
    strCharset: string;
  };
  array?: {
    dimLength: { min: number; max: number }[];
  };
  isNoInput?: boolean;
};

/**
 * Reason the fuzzer stopped
 */
export enum FuzzStopReason {
  CRASH = "crash",
  MAXTESTS = "maxTests",
  MAXFAILURES = "maxFailures",
  MAXTIME = "maxTime",
  MAXDUPES = "maxDupes",
}
