import * as fs from "fs";
import vm from "vm";
import seedrandom from "seedrandom";
import {
  ArgDef,
  ArgOptions,
  ArgType,
  findFnInSource,
  getTsFnArgs,
} from "./analysis/Typescript";
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
 * @param srcFile file name of Typescript module containing the function to fuzz
 * @param fnName optional name of the function to fuzz
 * @param offset optional offset within the source file of the function to fuzz
 * @returns a fuzz environment
 */
export const setup = (
  options: FuzzOptions,
  srcFile: string,
  fnName?: string,
  offset?: number
): FuzzEnv => {
  const srcText = fs.readFileSync(srcFile);
  const fnMatches = findFnInSource(srcText.toString(), fnName, offset);

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(options))
    throw new Error(
      `Invalid options provided: ${JSON.stringify(options, null, 2)}`
    );

  // Ensure we found a function to fuzz
  if (!fnMatches.length)
    throw new Error(
      `Could not find function ${fnName}@${offset} in: ${srcFile})}`
    );

  const [foundFnName, foundFnSrc] = fnMatches[0];
  return {
    options: { ...options },
    inputs: getTsFnArgs(foundFnSrc, options.argOptions),
    fnName: foundFnName,
    fnSrc: foundFnSrc,
    srcFile: srcFile,
  };
}; // setup()

/**
 * Fuzzes the function specified in the fuzz environment and returns the test results.
 *
 * @param env fuzz environment (created by calling setup())
 * @returns Promise containing the fuzz test results
 *
 * Throws an exception if the fuzz options are invalid
 */
export const fuzz = async (env: FuzzEnv): Promise<FuzzTestResults> => {
  const prng = seedrandom(env.options.seed);
  const fqSrcFile = fs.realpathSync(env.srcFile); // Help the module loader
  const results: FuzzTestResults = {
    env,
    results: [],
  };

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(env.options))
    throw new Error(
      `Invalid options provided: ${JSON.stringify(env.options, null, 2)}`
    );

  // Build a generator for each argument
  const fuzzArgGen = env.inputs.map((e) => {
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
  if (!(env.fnName in mod))
    throw new Error(
      `Could not find exported function ${env.fnName} in ${env.srcFile} to fuzz`
    );
  else if (typeof mod[env.fnName] !== "function")
    throw new Error(
      `Cannot fuzz exported member '${env.fnName} in ${env.srcFile} because it is not a function`
    );

  // Build a wrapper around the function to be fuzzed that we can
  // easily call in the testing loop.
  const fnWrapper = functionTimeout((input: FuzzIoElement[]): any => {
    return mod[env.fnName](...input.map((e) => e.value));
  }, env.options.fnTimeout);

  // Main test loop
  const startTime = new Date().getTime();
  for (let i = 0; i < env.options.maxTests; i++) {
    // End testing if we exceed the suite timeout
    if (new Date().getTime() - startTime >= env.options.suiteTimeout) {
      break;
    }

    const result: FuzzTestResult = {
      input: [],
      output: [],
      exception: false,
      timeout: false,
      passed: true,
    };

    // Generate and store the inputs
    // TODO: We should provide a way to filter inputs
    fuzzArgGen.forEach((e) => {
      result.input.push({
        name: e.arg.getName(),
        offset: e.arg.getOffset(),
        value: e.gen(),
      });
    });

    // Call the function via the wrapper
    try {
      result.output.push({
        name: "0",
        offset: 0,
        value: fnWrapper(result.input),
      });
    } catch (e: any) {
      if (isTimeoutError(e)) {
        result.timeout = true;
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
    fs.writeFileSync(env.options.outputFile, JSON.stringify(results));
  }

  // Return the result of the fuzzing activity
  return results;
}; // fuzz()

/**
 * Checks whether the given option set is valid.
 *
 * @param options fuzzer option set
 * @returns true if the options are valid, false otherwise
 */
const isOptionValid = (options: FuzzOptions): boolean => {
  return !(options.maxTests < 0 || !ArgDef.isOptionValid(options.argOptions));
}; // isOptionValid()

/**
 * Returns a default set of fuzzer options.
 *
 * @returns default set of fuzzer options
 */
export const getDefaultFuzzOptions = (): FuzzOptions => {
  return {
    argOptions: ArgDef.getDefaultOptions(),
    maxTests: 1000,
    fnTimeout: 100,
    suiteTimeout: 3000,
  };
}; // getDefaultFuzzOptions()

/**
 * The implicit oracle returns true only if the value contains no nulls, undefineds, NaNs,
 * or Infinity values.
 *
 * @param x any value
 * @returns true if x has no nulls, undefineds, NaNs, or Infinity values; false otherwise
 */
export const implicitOracle = (x: any): boolean => {
  if (Array.isArray(x)) return !x.flat().some((e) => !implicitOracleValue(e));
  else if (x === null || x === undefined) return false;
  else if (typeof x === "object")
    return !Object.values(x).some((e) => !implicitOracleValue(e));
  else return implicitOracleValue(x);
};

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
}

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
}

/**
 * Helped function for implicitOracle() that checks individual values
 */
const implicitOracleValue = (x: any): boolean => {
  if (typeof x === "number")
    return !(isNaN(x) || x === Infinity || x === -Infinity);
  return true; // string, boolean
};

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  srcFile: string; // source file path
  fnName: string; // function name
  fnSrc: string; // typescript source code of the function
  inputs: ArgDef<ArgType>[]; // input argument definitions
};

/**
 * Fuzzer Options that specify the fuzzing behavior
 */
export type FuzzOptions = {
  outputFile?: string; // optional file to receive the fuzzing output (JSON format)
  argOptions: ArgOptions; // default options for arguments
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

/**
 * Fuzzer Input/Output Element; i.e., a concrete input or output value
 */
export type FuzzIoElement = {
  name: string; // name of element
  offset: number; // offset of element (0-based)
  value: any; // value of element
};

export * from "./analysis/Typescript";
