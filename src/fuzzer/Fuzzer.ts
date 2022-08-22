import * as vscode from "vscode";
import seedrandom from "seedrandom";
import { ArgDef } from "./analysis/typescript/ArgDef";
import { FunctionDef } from "./analysis/typescript/FunctionDef";
import { GeneratorFactory } from "./generators/GeneratorFactory";
import { Runner } from "./Runner";
import { FuzzEnv, FuzzOptions, FuzzTestResult, FuzzTestResults } from "./Types";

/**
 * Builds and returns the environment required by fuzz().
 *
 * @param options fuzzer option set
 * @param module file name of Typescript module containing the function to fuzz
 * @param fnName optional name of the function to fuzz
 * @param offset optional offset within the source file of the function to fuzz
 * @returns a fuzz environment
 */
export const setup = async (
  options: FuzzOptions,
  extensionUri: vscode.Uri,
  module: string,
  fnName?: string,
  offset?: number
): Promise<FuzzEnv> => {
  module = require.resolve(module); // !!!!
  const srcText = await vscode.workspace.fs.readFile(vscode.Uri.parse(module));

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
      `Invalid options provided: ${JSON.stringify(options, null, 2)}`
    );

  // Ensure we found a function to fuzz
  if (!fnMatches.length)
    throw new Error(
      `Could not find function ${fnName}@${offset} in: ${module})}`
    );

  return {
    options: { ...options },
    extensionUri: extensionUri,
    function: fnMatches[0],
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
  const fuzzArgGen = env.function.getArgDefs().map((e: any) => {
    return { arg: e, gen: GeneratorFactory(e, prng) };
  });

  // Build a function Runner we can easily call in the testing loop
  const runner = new Runner(
    env.function.getRef(),
    env.options.fnTimeout,
    env.extensionUri
  );

  // Main test loop
  const startTime = new Date().getTime();
  for (let i = 0; i < env.options.maxTests; i++) {
    // End testing if we exceed the suite timeout
    if (new Date().getTime() - startTime >= env.options.suiteTimeout) {
      break;
    }

    // Initial set of results - overwritten below
    const result: FuzzTestResult = {
      input: [],
      output: [],
      exception: false,
      timeout: false,
      passed: true,
    };

    // Generate and store the inputs
    // TODO: We should provide a way to filter inputs
    fuzzArgGen.forEach((e: any) => {
      result.input.push({
        name: e.arg.getName(),
        offset: e.arg.getOffset(),
        value: e.gen(),
      });
    });

    // Call the function via the wrapper & map its output
    const runOutput = await runner.run(result.input); // <-- Wrapper
    if (runOutput.timeout) {
      result.timeout = true;
    } else if (runOutput.exception !== undefined) {
      result.exception = true;
      result.exceptionMessage = runOutput.exception;
    } else {
      result.output.push({
        name: "0",
        offset: 0,
        value: runOutput.output,
      });
    }
    /* !!!!
    try {
      result.output.push({
        name: "0",
        offset: 0,
        value: await runner.run(result.input), // <-- Wrapper
      });
    } catch (e: any) {
      console.log("Fuzzer: Promise reject exception"); // !!!!
    }
    console.log(`Fuzzer: timedOut: ${runner.timedOut()}`);
    console.log(`Fuzzer: exception: ${runner.threwException()}`);
    if (runner.timedOut()) {
      result.timeout = true;
    }
    if (runner.threwException()) {
      result.exception = true;
      result.exceptionMessage = runner.getException();
    }
    */

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

  // !!!
  runner.close();

  // Persist to outfile, if requested
  //if (env.options.outputFile) {
  //  fs.writeFileSync(env.options.outputFile, JSON.stringify(results));
  //}

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
