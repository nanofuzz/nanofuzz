import * as vscode from "vscode";
import * as compiler from "./Compiler";
import seedrandom from "seedrandom";
import { ArgDef } from "./analysis/typescript/ArgDef";
import { FunctionDef } from "./analysis/typescript/FunctionDef";
import { GeneratorFactory } from "./generators/GeneratorFactory";
import { Runner } from "./Runner";
import { FuzzEnv, FuzzOptions, FuzzTestResult, FuzzTestResults } from "./Types";
import { FunctionRefWeak } from "./analysis/typescript/Types";

/**
 * Builds and returns the environment required by fuzz().
 *
 * @param options fuzzer option set
 * @param extensionUri uri of the extension
 * @param fnRef weak reference to the function to be fuzzed
 * @returns a fuzz environment
 */
export const setup = async (
  options: FuzzOptions,
  extensionUri: vscode.Uri,
  fnRef: FunctionRefWeak
): Promise<FuzzEnv> => {
  // !!!
  const srcText = await vscode.workspace.fs.readFile(
    vscode.Uri.parse(fnRef.module.toString())
  );

  // Find the function definitions in the source file
  const fnMatches = FunctionDef.find(srcText.toString(), fnRef);

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(options))
    throw new Error(
      `Invalid options provided: ${JSON.stringify(options, null, 2)}`
    );

  // Ensure we found a function to fuzz
  if (!fnMatches.length)
    throw new Error(
      `Could not find function ${fnRef.name}@${fnRef.startOffset} in: ${fnRef.module})}`
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

  // Compile the module
  // !!!! This isn't right -- not following all dependencies
  const compiledCode = compiler.transpileTS(
    (
      await vscode.workspace.fs.readFile(
        vscode.Uri.parse(env.function.getRef().module.toString())
      )
    ).toString()
  );

  // Invalidate the module cache entry
  //delete require.cache[
  //  require.resolve(env.function.getRef().module.toString())
  //]; // !!!!!

  // Build a function Runner we can easily call in the testing loop
  const runner = new Runner(
    env.function.getRef(),
    env.options.fnTimeout,
    env.extensionUri,
    compiledCode
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
