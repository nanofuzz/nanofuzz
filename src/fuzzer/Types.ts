import {
  ArgOptions,
  ArgValueType,
  ArgValueTypeWrapped,
  FunctionRef,
  ProgramLanguage,
} from "./analysis/Types";
import { FunctionDef } from "./analysis/FunctionDef";
import { Judgment as _Judgment } from "./oracles/Types";
import { RunnerResult } from "./runners/AbstractRunner";
import {
  ScoredInput,
  NextableStatus,
  InputGeneratorStatsAi,
} from "./generators/Types";
import { InputSchedulerType } from "./schedulers/Types";
import { CodeCoverageMeasureStats } from "./measures/AbstractCoverageMeasure";

/**
 * Error occurring in test harness (property validator or input transformer)
 */
export type HarnessError =
  | {
      kind: "exception";
      stage: "transformer" | "validator";
      fnName: string;
      message: string;
      display?: string;
      stack: string;
    }
  | {
      kind: "timeout";
      stage: "transformer" | "validator";
      fnName: string;
      message: string;
      display?: string;
    };

/**
 * Single Fuzzer Test Result
 */
export type FuzzTestResult = {
  pinned: boolean; // true if the test was pinned (not randomly generated)
  inputGenerated: InputAndSource; // Raw generated input
  input: FuzzIoElement[]; // function input (may be transformed from inputGenerated)
  output: FuzzIoElement[]; // function output
  exception: boolean; // true if an exception was thrown
  exceptionMessage?: string; // exception message if an exception was thrown
  exceptionDisplay?: string; // exception display message if an exception was thrown
  stack?: string; // stack trace if an exception was thrown
  timeout: boolean; // true if the fn call timed out
  passedImplicit: Judgment; // "pass" if output passed implicit oracle
  passedHuman: Judgment; // "pass" if actual output matches human-expected output
  passedValidator: Judgment; // "pass" if passed all property oracles
  passedValidators: Judgment[]; // "pass" if passed all property oracles
  harnessErrors: HarnessError[]; // errors occurring in test harness (transformers/validators)
  timers: {
    gen: number; // time to generate the input in ms
    transform: number; // time to transform the input in ms
    run: number; // elapsed time of test in ms
  };
  expectedOutput?: FuzzIoElement[]; // the expected output, if any
  category: FuzzResultCategory; // the ResultCategory of the test result
  interestingReasons: string[]; // reasons (measures) this input may be "interesting"
  skipped?: boolean; // true if the test was skipped
  skipReason?: string; // skip reason message
  shrinkStep?: number; // number of shrink steps taken if the input was shrunk
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
  userGenerators?: string[]; // user generator functions
  tests: Record<string, FuzzPinnedTest>; // pinned tests
  isVoid: boolean; // is the function return type void?
  isAsync?: true; // is the function async?
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
 * Transformed input values and their source, including transformer runner result if any
 */
export type TransformedInputAndSource = InputAndSource & {
  transformerResult?: RunnerResult;
};

export type MutationMode = "mutate" | "shrink" | "boot";

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
      steps: {
        taken: number;
        max: number;
        mode: MutationMode;
        mutators: string[];
      };
    }
  | {
      type: "generator";
      generator: "AiInputGenerator";
      model: string;
    }
  | {
      type: "generator";
      generator: "UserInputGenerator";
      fnName: string;
    }
  | {
      type: "transformer";
      transformer: string;
      basis: {
        value: ArgValueTypeWrapped[];
        source: FuzzValueOrigin;
      };
    };

/**
 * Category of a test result
 */
export const FuzzResultCategoryValues = [
  "ok", // Judgment: passed
  "badValue", // Judgment: failed (not timeout or exception)
  "timeout", // Judgment: failed (timeout)
  "exception", // Judgment: failed (exception)
  "skip", // Judgment: skipped due to filter / assume
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
export type FuzzOutputResults = "all" | "failures" | "none";

export type FuzzOptions = {
  outputFile?: string; // optional file to receive the fuzzing output (JSON format)
  outputResults?: FuzzOutputResults; // test results retention mode
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
  useTransformer: boolean; // use input transformer
  workers: number | "auto"; // number of concurrent worker processes ("auto" or >= 1)
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
  bigInt?: {
    min: bigint;
    max: bigint;
  };
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
    strRegex?: string;
  };
  bytes?: {
    minByteLen: number;
    maxByteLen: number;
  };
  dictionary?: {
    minDictLen: number;
    maxDictLen: number;
  };
  set?: {
    minSetLen: number;
    maxSetLen: number;
  };
  array?: {
    dimLength: { min: number; max: number }[];
    dimsUnique: boolean;
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
  | "AiInputGenerator"
  | "UserInputGenerator";

/**
 * List of supported input generators
 */
export type SupportedMeasures = "CoverageMeasure" | "FailedTestMeasure";

/**
 * Focus mode of the fuzzer (generation vs. shrinking)
 */
export type FuzzerFocus =
  | { mode: "gen" }
  | { mode: "shrink"; target: InputAndSource };

export type GetFuzzerFocusFn = () => FuzzerFocus;

/**
 * Emitted when a source module is being compiled.
 */
export type FuzzCompilingMessage = {
  type: "compiling";
  file: string;
};

/**
 * Emitted when a source module is being instrumented.
 */
export type FuzzInstrumentingMessage = {
  type: "instrumenting";
  file: string;
};

/**
 * Emitted when a specific test input is being tested against the PUT.
 */
export type FuzzTestingMessage = {
  type: "testing";
  fnName: string;
  lang: ProgramLanguage;
  inputs: ArgValueType[];
  stats: CurrentRunStats;
  pct: number;
  stillInjecting: boolean;
  isCancelled: boolean;
};

/**
 * Emitted when waiting for an asynchronous generator (e.g., AI/LLM).
 */
export type FuzzWaitingForGeneratorMessage = {
  type: "waiting-for-generator";
  pendingGenerators: string[];
  stats: CurrentRunStats;
  pct: number;
};

/**
 * Emitted periodically during idle or long pauses to update progress and timers.
 */
export type FuzzProgressTickMessage = {
  type: "progress-tick";
  pct: number;
};

/**
 * Emitted when the fuzzing run finishes or is interrupted.
 */
export type FuzzTestingCompleteMessage = {
  type: "testing-complete";
  cancelled: boolean;
  pct: number;
};

/**
 * Union of all structured status messages emitted by the fuzzer.
 */
export type FuzzBusyStatusMessage =
  | FuzzCompilingMessage
  | FuzzInstrumentingMessage
  | FuzzTestingMessage
  | FuzzWaitingForGeneratorMessage
  | FuzzProgressTickMessage
  | FuzzTestingCompleteMessage;

/**
 * Fuzzer status update callback
 */
export type FuzzStatusUpdater = (payload: FuzzBusyStatusMessage) => void;

/**
 * Callback called for each test result produced during fuzzing
 */
export type FuzzResultCallback = (result: FuzzTestResult) => void;

/**
 * Exception class for TypeScript compiler errors
 */
export type TypescriptCompilerErrorDetails = {
  inputFile: string;
  outputFile: string;
  output?: string[];
  tscConfigFilename?: string;
  tscCli: string;
};
export class TypescriptCompilerError extends Error {
  public details: TypescriptCompilerErrorDetails;
  constructor(message: string, details: TypescriptCompilerErrorDetails) {
    super(message);
    this.details = details;
  }
}

/**
 * Throw to skip a test input due to an unsatisfied assumption.
 */
export class UnsatisfiedAssumption extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsatisfiedAssumption";
  }
}

export type Judgment = _Judgment;

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  function: FunctionDef; // the function to fuzz
  validators: FunctionRef[]; // list of the module's validator functions
  transformers: FunctionRef[]; // list of the module's input transformer functions
  userGenerators: FunctionRef[]; // list of the module's user-provided input generator functions
};

/**
 * Fuzzer mode
 */
export type FuzzMode = {
  gen?: true;
};

/**
 * Fuzzer Test Result collection
 */
export type FuzzTestResults = {
  toolVersion: string; // NaNofuzz name and version that generated the results
  env: FuzzEnv; // fuzzer environment
  stopReason: FuzzStopReason; // why the fuzzer stopped
  stats: FuzzTestStats; // fuzzer statistics
  interesting: {
    inputs: ScoredInput[]; // interesting inputs
  };
  results: FuzzTestResult[]; // fuzzing test results
};

export type FuzzGeneratorStatsBase = {
  counters: {
    inputsGenerated: number; // number of inputs generated, including dupes
    dupesGenerated: number; // number of duplicate inputs generated
    dupeTicks: number[]; // ticks in which the generator produced a duplicate input
  };
  timers: {
    run: number; // elapsed time the PUT ran
    val: number; // elapsed time to categorize outputs
    gen: number; // elapsed time to generate inputs
    measure: number; // elapsed time to measure
    transform: number; // elapsed time to transform inputs
  };
};

export type FuzzOutcomeStats = {
  total: number; // number of tests actually executed (pass + fail + error, excluding skipped)
  exceptions: number; // total tests that encountered exceptions
  timeouts: number; // total tests that timed out
  categories: Record<FuzzResultCategory, number>; // total counts per category
  oracles: {
    heuristic: Record<Judgment, number>;
    human: Record<Judgment, number>;
    property: Record<Judgment, number>;
  };
  firstFailure?: FuzzTestResult;
};

export type FuzzTestStats = {
  timers: {
    total: number; // elapsed time the fuzzer ran
    compile: number; // elapsed time to compile & instrument PUT
    instrument: number; // elapsed time to instrument PUT
    put: number; // elapsed time the PUT ran
    val: number; // elapsed time to categorize outputs
    gen: number; // elapsed time to generate inputs
    transform: number; // elapsed time to transform inputs
    measure: number; // elapsed time to measure
  };
  counters: {
    testingRuns: number; // number of test runs
    inputsGenerated: number; // number of inputs generated, including dupes
    dupesGenerated: number; // number of duplicate inputs generated
    inputsInjected: number; // number of inputs pinned
    erroredTests: number; // number of tests with internal errors
    passedTests: number; // number of passed tests
    inputsSkipped: number; // number of skipped tests
    failedTests: number; // number of failed tests
  };
  outcomes: FuzzOutcomeStats;
  generators: {
    RandomInputGenerator: FuzzGeneratorStatsBase;
    MutationInputGenerator: FuzzGeneratorStatsBase;
    AiInputGenerator: FuzzGeneratorStatsBase & { gen?: InputGeneratorStatsAi };
    UserInputGenerator: FuzzGeneratorStatsBase;
    CompositeInputGenerator?: {
      config?: {
        scheduler: InputSchedulerType;
        lookbackWindow: number;
        chunkSize: number;
        explorationChance: number;
        initialFocus: number;
        focusDecay: number;
      };
      checkpoints: {
        tick: number; // tick of the checkpoint
        gens: Record<
          string,
          {
            active: boolean; // subgen is active
            nextable: NextableStatus; // subgen is active and nextable
            productivity: number; // current productivity[g] for this input generator
            cost: number; // current cost[g] for this input generator
            selected?: true; // subgen was selected for this chunk
          }
        >;
        scheduler: InputSchedulerType;
      }[];
    };
  };
  measures: {
    CodeCoverageMeasure?: () => Promise<CodeCoverageMeasureStats>;
  };
};

/**
 * Current run statistics
 */
export type CurrentRunStats = {
  counters: {
    inputsInjected: number; // number of inputs injected for testing
    inputsGenerated: number; // number of inputs generated so far
    dupesGenerated: number; // number of duplicate inputs generated so far
    dupesSequential: number; // current number of duplicate inputs generated in a row
    erroredTests: number; // number of tests with internal errors so far
    failedTests: number; // number of failed tests so far
    passedTests: number; // number of passed tests so far
    inputsSkipped: number; // number of skipped tests so far
  };
  outcomes: FuzzOutcomeStats;
  timers: {
    startTime: number; // time the tester started in this run
    startGenTime: number; // time the tester started generating new inputs
  };
};
