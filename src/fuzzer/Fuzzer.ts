import * as fs from "fs";
import * as vscode from "vscode";
import * as JSON5 from "json5";
import vm from "vm";
import seedrandom from "seedrandom";
import { ArgDef, ArgOptions } from "./analysis/typescript/ArgDef";
import { FunctionDef } from "./analysis/typescript/FunctionDef";
import { GeneratorFactory } from "./generators/GeneratorFactory";
import * as compiler from "./Compiler";

/**
 * WARNING: To embed this module into a VS Code web extension, at a minimu,
 * the following issues need to be resolved:
 *  1. Module `fs` requires direct fs access)
 *  2. Module `Compiler` uses `fs` and shells out to `tsc`
 */

/**
 * Builds and returns the environment required by fuzz().
 *
 * @param options fuzzer option set
 * @param module file name of Typescript module containing the function to fuzz
 * @param fnName optional name of the function to fuzz
 * @param offset optional offset within the source file of the function to fuzz
 * @returns a fuzz environment
 */
export const setup = (
  options: FuzzOptions,
  module: string,
  fnName?: string,
  offset?: number
): FuzzEnv => {
  module = require.resolve(module);
  const srcText = fs.readFileSync(module);

  // Find the function definitions in the source file
  const fnMatches = FunctionDef.find(
    srcText.toString(),
    module,
    fnName,
    offset
  );

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(options))
    throw new Error(
      `Invalid options provided: ${JSON5.stringify(options, null, 2)}`
    );

  // Ensure we found a function to fuzz
  if (!fnMatches.length)
    throw new Error(
      `Could not find function ${fnName}@${offset} in: ${module})}`
    );

  return {
    options: { ...options },
    function: fnMatches[0],
  };
}; // fn: setup()

/**
 * Fuzzes the function specified in the fuzz environment and returns the test results.
 *
 * @param env fuzz environment (created by calling setup())
 * @returns Promise containing the fuzz test results
 *
 * Throws an exception if the fuzz options are invalid
 */
export const fuzz = async (
  env: FuzzEnv,
  pinnedTests: FuzzPinnedTest[] = []
): Promise<FuzzTestResults> => {
  const prng = seedrandom(env.options.seed);
  const fqSrcFile = fs.realpathSync(env.function.getModule()); // Help the module loader
  const results: FuzzTestResults = {
    env,
    results: [],
  };
  let dupeCount = 0; // Number of duplicated tests since the last non-duplicated test

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(env.options))
    throw new Error(
      `Invalid options provided: ${JSON5.stringify(env.options, null, 2)}`
    );

  // Build a generator for each argument
  const fuzzArgGen = env.function.getArgDefs().map((e) => {
    return { arg: e, gen: GeneratorFactory(e, prng) };
  });

  // The module that includes the function to fuzz will
  // be a TypeScript source file, so we first must compile
  // it to JavaScript prior to execution.  This activates the
  // TypeScript compiler that hooks into the require() function.
  compiler.activate();

  // The fuzz target is likely under development, so
  // invalidate the cache to get the latest copy.
  delete require.cache[require.resolve(fqSrcFile)];

  /* eslint eslint-comments/no-use: off */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(fqSrcFile);
  compiler.deactivate(); // Deactivate the TypeScript compiler

  // Ensure what we found is a function
  if (!(env.function.getName() in mod))
    throw new Error(
      `Could not find exported function ${env.function.getName()} in ${env.function.getModule()} to fuzz`
    );
  else if (typeof mod[env.function.getName()] !== "function")
    throw new Error(
      `Cannot fuzz exported member '${env.function.getName()} in ${env.function.getModule()} because it is not a function`
    );

  // Build a wrapper around the function to be fuzzed that we can
  // easily call in the testing loop.
  const fnWrapper = functionTimeout((input: FuzzIoElement[]): any => {
    return mod[env.function.getName()](...input.map((e) => e.value));
  }, env.options.fnTimeout);

  // Main test loop
  // We break out of this loop when any of the following are true:
  //  (1) We have reached the maximum number of tests
  //  (2) We have reached the maximum number of duplicate tests
  //      since the last non-duplicated test
  //  (3) We have reached the time limit for the test suite to run
  // Note: Pinned tests are not counted against the maxTests limit
  const startTime = new Date().getTime();
  const allInputs: Record<string, boolean> = {};
  for (
    let i = 0;
    i < env.options.maxTests &&
    dupeCount < Math.max(env.options.maxTests, 1000);
    i++
  ) {
    // End testing if we exceed the suite timeout
    if (new Date().getTime() - startTime >= env.options.suiteTimeout) {
      break;
    }

    // Initial set of results - overwritten below
    const result: FuzzTestResult = {
      pinned: false,
      input: [],
      output: [],
      exception: false,
      timeout: false,
      passed: true,
      elapsedTime: 0,
      correct: "none",
    };

    // Before searching, consume the pool of pinned tests
    // Note: Do not count pinned tests against the maxTests limit
    const pinnedTest = pinnedTests.pop();
    if (pinnedTest) {
      result.input = pinnedTest.input;
      result.pinned = pinnedTest.pinned;
      result.correct = pinnedTest.correct;
      if (pinnedTest.expectedOutput) {
        result.expectedOutput = pinnedTest.expectedOutput;
      }
      --i; // don't count pinned tests
    } else {
      // Generate and store the inputs
      // TODO: We should provide a way to filter inputs
      fuzzArgGen.forEach((e) => {
        result.input.push({
          name: e.arg.getName(),
          offset: e.arg.getOffset(),
          value: e.gen(),
        });
      });
    }

    // Skip tests if we previously processed the input
    const inputHash = JSON5.stringify(result.input);
    if (inputHash in allInputs) {
      i--; // don't count this test
      dupeCount++; // but count the duplicate
      continue; // skip this test
    } else {
      dupeCount = 0; // reset the duplicate count
      // if the function accepts inputs, add test input
      // to the list so we don't test it again,
      if (env.function.getArgDefs().length) {
        allInputs[inputHash] = true;
      }
    }

    // Call the function via the wrapper
    try {
      const startElapsedTime = performance.now(); // start timer
      result.elapsedTime = startElapsedTime;
      result.output.push({
        name: "0",
        offset: 0,
        value: fnWrapper(result.input), // <-- Wrapper
      });
      result.elapsedTime = performance.now() - startElapsedTime; // stop timer
    } catch (e: any) {
      if (isTimeoutError(e)) {
        result.timeout = true;
        result.elapsedTime = performance.now() - result.elapsedTime;
      } else {
        result.exception = true;
        result.exceptionMessage = e.message;
        result.stack = e.stack;
      }
    }

    // How can it fail ... let us count the ways...
    // TODO Add suppport for multiple validators !!!
    if (
      result.exception ||
      result.timeout ||
      result.output.some((e) => !implicitOracle(e))
    )
      result.passed = false;

    // Store the result for this iteration
    results.results.push(result);
  } // for: Main test loop

  // Persist to outfile, if requested
  if (env.options.outputFile) {
    fs.writeFileSync(env.options.outputFile, JSON5.stringify(results));
  }

  // Return the result of the fuzzing activity
  return results;
}; // fn: fuzz()

/**
 * Checks whether the given option set is valid.
 *
 * @param options fuzzer option set
 * @returns true if the options are valid, false otherwise
 */
const isOptionValid = (options: FuzzOptions): boolean => {
  return !(options.maxTests < 0 || !ArgDef.isOptionValid(options.argDefaults));
}; // fn: isOptionValid()

/**
 * Returns a default set of fuzzer options.
 *
 * @returns default set of fuzzer options
 */
export const getDefaultFuzzOptions = (): FuzzOptions => {
  return {
    argDefaults: ArgDef.getDefaultOptions(),
    maxTests: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("maxTests", 1000),
    fnTimeout: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("fnTimeout", 100),
    suiteTimeout: vscode.workspace
      .getConfiguration("nanofuzz.fuzzer")
      .get("suiteTimeout", 3000),
  };
}; // fn: getDefaultFuzzOptions()

/**
 * The implicit oracle returns true only if the value contains no nulls, undefineds, NaNs,
 * or Infinity values.
 *
 * @param x any value
 * @returns true if x has no nulls, undefineds, NaNs, or Infinity values; false otherwise
 */
export const implicitOracle = (x: any): boolean => {
  if (Array.isArray(x)) return !x.flat().some((e) => !implicitOracle(e));
  if (typeof x === "number")
    return !(isNaN(x) || x === Infinity || x === -Infinity);
  else if (x === null || x === undefined) return false;
  else if (typeof x === "object")
    return !Object.values(x).some((e) => !implicitOracle(e));
  else return true; //implicitOracleValue(x);
}; // fn: implicitOracle()

/**
 * Adapted from: https://github.com/sindresorhus/function-timeout/blob/main/index.js
 *
 * The original function-timeout is an ES module; incorporating it here
 * avoids adding Babel to the dev toolchain solely for the benefit of Jest,
 * for which ESM support without Babel remains buggy / experimental. Maybe
 * we can remove this in the future or just add Babel for Jest.
 *
 * This function accepts a function and a timeout as input.  It then returns
 * a wrapper function that will throw an exception if the function does not
 * complete within, roughly, the timeout.
 *
 * @param function_ function to be executed with the timeout
 * @param param1
 * @returns
 */
export default function functionTimeout(function_: any, timeout: number): any {
  const script = new vm.Script("returnValue = function_()");

  const wrappedFunction = (...arguments_: any[]) => {
    const context = {
      returnValue: undefined,
      function_: () => function_(...arguments_),
    };

    script.runInNewContext(context, { timeout: timeout });

    return context.returnValue;
  };

  Object.defineProperty(wrappedFunction, "name", {
    value: `functionTimeout(${function_.name || "<anonymous>"})`,
    configurable: true,
  });

  return wrappedFunction;
} // fn: functionTimeout()

/**
 * Adapted from: https://github.com/sindresorhus/function-timeout/blob/main/index.js
 *
 * Returns true if the exception is a timeout.
 *
 * @param error exception
 * @returns true if the exeception is a timeout exception, false otherwise
 */
export function isTimeoutError(error: { code?: string }): boolean {
  return "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
} // fn: isTimeoutError()

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  function: FunctionDef; // the function to fuzz
};

/**
 * Fuzzer Options that specify the fuzzing behavior
 */
export type FuzzOptions = {
  outputFile?: string; // optional file to receive the fuzzing output (JSON format)
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
  pinned: boolean; // true if the test was pinned (not randomly generated)
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  exception: boolean; // true if an exception was thrown
  exceptionMessage?: string; // exception message if an exception was thrown
  stack?: string; // stack trace if an exception was thrown
  timeout: boolean; // true if the fn call timed out
  passed: boolean; // true if output matches oracle; false, otherwise
  elapsedTime: number; // elapsed time of test
  correct: string; // check, error, question, or none
  expectedOutput?: any; // the correct output if correct icon; an incorrect output if error icon
};

/**
 * Pinned Fuzzer Tests
 */
export type FuzzPinnedTest = {
  input: FuzzIoElement[]; // function input
  output: FuzzIoElement[]; // function output
  pinned: boolean; // is the test pinned?
  correct: string; // check, error, question, or none
  expectedOutput?: any; // the correct output if correct icon; an incorrect output if error icon
};

/**
 * Fuzzer Input/Output Element; i.e., a concrete input or output value
 */
export type FuzzIoElement = {
  name: string; // name of element
  offset: number; // offset of element (0-based)
  value: any; // value of element
};

export * from "./analysis/typescript/FunctionDef";
export * from "./analysis/typescript/ArgDef";
