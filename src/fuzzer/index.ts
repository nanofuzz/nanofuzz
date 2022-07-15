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

// !!!
export const fuzzSetup = (
  options: FuzzOptions,
  srcFile: string,
  fnName?: string,
  offset?: number
): FuzzEnv => {
  const srcText = fs.readFileSync(srcFile);
  const fnMatches = findFnInSource(srcText.toString(), fnName, offset);

  if (!fnMatches.length)
    throw new Error(
      `Could not find function ${fnName}@${offset} in: ${srcFile})}`
    );

  const [foundFnName, foundFnSrc] = fnMatches[0];
  return {
    options: options,
    inputs: getTsFnArgs(foundFnSrc, options.argOptions),
    fnName: foundFnName,
    fnSrc: foundFnSrc,
    srcFile: srcFile,
  };
};

// !!!
export const fuzz = (env: FuzzEnv): FuzzTestResults => {
  const prng = seedrandom(env.options.seed);
  const results: FuzzTestResults = {
    env,
    results: [],
  };

  // Build a generator for each argument
  const fuzzArgGen = env.inputs.map((e) => {
    return { arg: e, gen: GeneratorFactory(e, prng) };
  });

  // Build a wrapper to call the function
  const fqSrcFile = fs.realpathSync(env.srcFile); // Help the module loader
  const fnWrapper = (input: FuzzIoElement[]): any => {
    /* eslint eslint-comments/no-use: off */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(fqSrcFile);
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
    fuzzArgGen.forEach((e) => {
      const inputVal = e.gen();
      result.input.push({
        name: e.arg.getName(),
        offset: e.arg.getOffset(),
        value: inputVal,
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
    if (result.exception || !isReal(rawOutput)) result.passed = false;

    /* !!!
    console.log(
      `Called ${env.fnName}(${result.input
        .map((e) => JSON.stringify(e.value ?? "undefined"))
        .join(",")}) --> ${JSON.stringify(
        result.output.map((e) => JSON.stringify(e.value))
      )} ${
        result.exception ? "threw (" + result.exceptionMessage + ") " : ""
      }(${result.passed ? "passed" : "FAILED"})`
    );
    */

    // Store the result for this iteration
    results.results.push(result);
  } // for: Main test loop

  // Persist to outfile, if requested
  if (env.options.outFile) {
    fs.writeFileSync(env.options.outFile, JSON.stringify(results));
  }

  // Return the result of the fuzzing activity
  return results;
};

// !!!
export const getDefaultFuzzOptions = (): FuzzOptions => {
  return {
    argOptions: ArgDef.getDefaultOptions(),
    numTests: 1000, // !!!
  };
};

// !!!
export type FuzzEnv = {
  options: FuzzOptions;
  inputs: ArgDef<ArgType>[];
  fnName: string;
  fnSrc: string;
  srcFile: string;
};

// !!!
export type FuzzOptions = {
  outputFile?: string; // File to write output to
  argOptions: ArgOptions; // Default options for arguments
  seed?: string; // Variation / seed (optional)
  numTests: number; // Number of fuzzing tests to execute
  outFile?: string; // Optional JSON output file
  // !!! oracleFn: typeof isReal; // The oracle function TODO: Create type for function shape
};

// !!!
export type FuzzTestResults = {
  env: FuzzEnv;
  results: FuzzTestResult[];
};

// !!!
export type FuzzTestResult = {
  input: FuzzIoElement[];
  output: FuzzIoElement[];
  exception: boolean;
  exceptionMessage?: string;
  passed: boolean; // true if output matches oracle; false, otherwise
};

// !!!
export type FuzzIoElement = {
  name: string;
  offset: number;
  value: any;
};

// !!!
export const isReal = (x: any): boolean => {
  if (Array.isArray(x)) return !x.flat().some((e) => !isRealValue(e));
  else if (x === null || x === undefined) return false;
  else if (typeof x === "object")
    return !Object.values(x).some((e) => !isRealValue(e));
  else return isRealValue(x);
};

// !!!
export const isRealValue = (x: any): boolean => {
  if (typeof x !== "number") return false;
  else return !(isNaN(x) || x === Infinity || x === -Infinity);
};
