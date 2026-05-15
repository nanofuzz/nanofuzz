import {
  ArgOptions,
  ArgValueType,
  ArgValueTypeWrapped,
} from "./analysis/typescript/Types";
import { Judgment as _Judgment } from "./oracles/Types";

/**
 * Single Fuzzer Test Result
 */
export type FuzzTestResult = {
  testId: number; // id of test (unique within a runId)
  pinned: boolean; // true if the test was pinned (not randomly generated)
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  exception: boolean; // true if an exception was thrown
  exceptionMessage?: string; // exception message if an exception was thrown
  stack?: string; // stack trace if an exception was thrown
  timeout: boolean; // true if the fn call timed out
  passedImplicit: Judgment; // "pass" if output passed implicit oracle
  passedHuman: Judgment; // "pass" if actual output matches human-expected output
  passedValidator: Judgment; // "pass" if passed all property oracles
  passedValidators: Judgment[]; // "pass" if passed all property oracles
  validatorException: boolean; // true if validator threw an exception
  validatorExceptionMessage?: string; // validator exception message
  validatorExceptionFunction?: string; // name of validator throwing exception
  validatorExceptionStack?: string; // validator stack trace if exception was thrown
  timers: {
    gen: number; // time to generate the input in ms
    run: number; // elapsed time of test in ms
  };
  expectedOutput?: FuzzIoElement[]; // the expected output, if any
  category: FuzzResultCategory; // the ResultCategory of the test result
  interestingReasons: string[]; // reasons (measures) this input may be "interesting"
};

/**
 * Simplified single test result for writing custom validator
 */
export type Result = {
  in: ArgValueType[]; // function input
  out: unknown; // function output
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
  value: ArgValueType; // value of element
  origin: FuzzValueOrigin; // origin of value
};

/**
 * Concrete input values and their source
 */
export type InputAndSource = {
  tick: number;
  value: ArgValueTypeWrapped[];
  source: FuzzValueOrigin;
  injected?: true;
};

/**
 * Provenance of a test value (e.g., an input)
 */
export type FuzzValueOrigin =
  | {
      type: "user" | "put" | "unknown";
    }
  | {
      type: "generator";
      generator: "RandomInputGenerator";
    }
  | {
      type: "generator";
      generator: "MutationInputGenerator";
      tick?: number;
    }
  | {
      type: "generator";
      generator: "AiInputGenerator";
      model: string;
    };

/**
 * Category of a test result
 */
export const FuzzResultCategoryValues = [
  "ok", // Judgment: passed
  "badValue", // Judgment: failed (not timeout or exception)
  "timeout", // Judgment: failed (timeout)
  "exception", // Judgment: failed (exception)
  "disagree", // Judgment: unknown
  "failure", // Validator failure (e.g., threw an exception)
] as const;
export type FuzzResultCategory = (typeof FuzzResultCategoryValues)[number];

/**
 * Type guard that returns true if the input object is a
 * FuzzResultCategory.
 *
 * @param obj the object to check
 * @returns `true` if `obj` is a `FuzzResultCategory`, `false` otherwise
 */
const fuzzResultCategoryValues: string[] = [...FuzzResultCategoryValues];
export function isFuzzResultCategory(obj: unknown): obj is FuzzResultCategory {
  return typeof obj === "string" && fuzzResultCategoryValues.includes(obj);
} // fn: isFuzzResultCategory

/**
 * Result Tabs
 */
export const FuzzResultTabValues = [
  ...FuzzResultCategoryValues,
  "runInfo",
] as const;
export type FuzzResultTab = (typeof FuzzResultTabValues)[number];

/**
 * Type guard that returns true if the input object is a FuzzResultTab.
 *
 * @param obj the object to check
 * @returns `true` if `obj` is a `FuzzResultTab`, `false` otherwise
 */
const fuzzResultTabValues: string[] = [...FuzzResultTabValues];
export function isFuzzResultTab(obj: unknown): obj is FuzzResultTab {
  return typeof obj === "string" && fuzzResultTabValues.includes(obj);
} // fn: isFuzzResultTab

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
  fnTimeout: number; // timeout threshold in ms per test
  suiteTimeout: number; // timeout for the entire test suite
  useImplicit: boolean; // use implicit oracle
  useHuman: boolean; // use human oracle
  useProperty: boolean; // use property validator oracle
  measures: { [k in SupportedMeasures]: BaseMeasureConfig }; // measure config
  generators: { [k in SupportedInputGenerators]: BaseGeneratorConfig }; // generator config
};

/**
 * Basic measurement configuration: on/off, weight
 */
export type BaseMeasureConfig = { enabled: boolean; weight: number };

/**
 * Basic measurement configuration: on/off
 */
export type BaseGeneratorConfig = { enabled: boolean };

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
  PAUSE = "pause",
  CRASH = "crash",
  MAXTESTS = "maxTests",
  MAXFAILURES = "maxFailures",
  MAXTIME = "maxTime",
  MAXDUPES = "maxDupes",
  NOMOREINPUTS = "noMoreInputs",
}

/**
 * Global execution environment
 */
export type VmGlobals = Record<string, unknown>;

/**
 * List of supported input generators
 */
export type SupportedInputGenerators =
  | "RandomInputGenerator"
  | "MutationInputGenerator"
  | "AiInputGenerator";

/**
 * List of supported input generators
 */
export type SupportedMeasures = "CoverageMeasure" | "FailedTestMeasure";

/**
 * Message about how busy the fuzzer is
 */
export type FuzzBusyStatusMessage = {
  msg: string;
  milestone?: boolean;
  pct?: number;
};

/**
 * Exception class for TypeScript compiler errors
 */
export type TscCompilerErrorDetails = {
  inputFile: string;
  outputFile: string;
  output?: string[];
  tscConfigFilename?: string;
  tscCli: string;
};
export class TscCompilerError extends Error {
  public details: TscCompilerErrorDetails;
  constructor(message: string, details: TscCompilerErrorDetails) {
    super(message);
    this.details = details;
  }
}

export type Judgment = _Judgment;
