import * as fs from "fs";
import seedrandom from "seedrandom";
import {
  ArgDef,
  ArgOptions,
  ArgType,
  findFnInSource,
  getTsFnArgs,
} from "./analysis/Typescript";
import { GeneratorFactory } from "./generators/GeneratorFactory";
require("typescript-require");

/**
 * WARNING: To embed this module into a VS Code web extension, at a minimu, the following
 * changes are required:
 *  1. Remove module `fs`: it requires direct fs access)
 *  2. Remove module `typescript-require`: it shells out to execute `tsc
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

  // Build a wrapper around the function to be fuzzed that we can
  // easily call in the testing loop.  The code we need to fuzz is
  // likely to be raw TS that our JS VM can't compile. Here we use
  // typescript-require, which hooks into *.ts requires via (the
  // deprecated) require.extensions property.
  //
  /* eslint eslint-comments/no-use: off */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(fqSrcFile);
  const fnWrapper = (input: FuzzIoElement[]): any => {
    return mod[env.fnName](...input.map((e) => e.value));
  };

  // Main test loop
  for (let i = 0; i < env.options.numTests; i++) {
    const result: FuzzTestResult = {
      input: [],
      output: [],
      exception: false,
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
    let rawOutput: any;
    try {
      rawOutput = fnWrapper(result.input);
      result.output.push({
        name: "0",
        offset: 0,
        value: rawOutput,
      });
    } catch (e: any) {
      result.exception = true;
      result.exceptionMessage = e.message;
    }

    // How can it fail ... let us count the ways...
    // TODO Add suppport for multiple validators !!!
    if (
      result.exception ||
      (typeof rawOutput !== "string" && !implicitOracle(rawOutput))
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
  return !(options.numTests < 0 || !ArgDef.isOptionValid(options.argOptions));
}; // isOptionValid()

/**
 * Returns a default set of fuzzer options.
 *
 * @returns default set of fuzzer options
 */
export const getDefaultFuzzOptions = (): FuzzOptions => {
  return {
    argOptions: ArgDef.getDefaultOptions(),
    numTests: 1000,
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
  numTests: number; // number of fuzzing tests to execute (>= 0)
  // !!! oracleFn: typeof isReal; // TODO The oracle function !!!
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
