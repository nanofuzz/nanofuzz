import * as fs from "fs";
import * as JSON5 from "json5";
import vm from "vm";
import seedrandom from "seedrandom";
import { ArgDef } from "./analysis/typescript/ArgDef";
import { FunctionRef } from "./analysis/typescript/Types";
import { GeneratorFactory } from "./generators/GeneratorFactory";
import * as compiler from "./Compiler";
import { ProgramDef } from "./analysis/typescript/ProgramDef";
import { FunctionDef } from "./analysis/typescript/FunctionDef";
import {
  FuzzIoElement,
  FuzzPinnedTest,
  FuzzTestResult,
  FuzzResultCategory,
} from "./Types";
import { FuzzOptions } from "./Types";

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
  fnName: string
): FuzzEnv => {
  module = require.resolve(module);
  const program = ProgramDef.fromModule(module, options.argDefaults);
  const fnList = program.getExportedFunctions();

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(options))
    throw new Error(
      `Invalid options provided: ${JSON5.stringify(options, null, 2)}`
    );

  // Ensure we found a function to fuzz
  if (!(fnName in fnList))
    throw new Error(`Could not find function ${fnName} in: ${module})}`);

  return {
    options: { ...options },
    function: fnList[fnName],
    //validator: ... FuzzPanel loads this and adds it to FuzzEnv later
    validators: getValidators(program, fnList[fnName]),
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
  let failureCount = 0; // Number of failed tests encountered so far

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
    (env.options.maxFailures === 0 || failureCount < env.options.maxFailures) &&
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
      validatorException: false,
      timeout: false,
      passedImplicit: true,
      elapsedTime: 0,
      category: FuzzResultCategory.OK,
    };

    // Before searching, consume the pool of pinned tests
    // Note: Do not count pinned tests against the maxTests limit
    const pinnedTest = pinnedTests.pop();
    if (pinnedTest) {
      result.input = pinnedTest.input;
      result.pinned = pinnedTest.pinned;
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

    // IMPLICIT ORACLE --------------------------------------------
    // How can it fail ... let us count the ways...
    // TODO Add suppport for multiple validators !!!
    if (
      result.exception ||
      result.timeout ||
      result.output.some((e) => !implicitOracle(e))
    ) {
      result.passedImplicit = false;
    }

    // HUMAN ORACLE -----------------------------------------------
    // If a human annotated an expected output, then check it
    if (result.expectedOutput) {
      result.passedHuman = actualEqualsExpectedOutput(
        result,
        result.expectedOutput
      );
    }

    // CUSTOM VALIDATOR ------------------------------------------
    // If a custom validator is selected, call it to evaluate the result
    if ("validator" in env && env.validator) {
      const fnName = env.validator;

      // Build the validator function wrapper
      const validatorFnWrapper = functionTimeout(
        (input: FuzzTestResult): FuzzTestResult => {
          try {
            const result: FuzzTestResult = mod[fnName]({ ...input });
            return {
              ...input,
              passedValidator: result.passedValidator,
            };
          } catch (e: any) {
            return {
              ...input,
              validatorException: true,
              validatorExceptionMessage: e.message,
              validatorExceptionStack: e.stack,
            };
          }
        },
        env.options.fnTimeout
      );

      // Categorize the results (so it's not stale)
      result.category = categorizeResult(result);

      // Call the validator function wrapper
      const validatorResult = validatorFnWrapper(result);

      // Store the validator results
      result.passedValidator = validatorResult.passedValidator;
      result.validatorException = validatorResult.validatorException;
      result.validatorExceptionMessage =
        validatorResult.validatorExceptionMessage;
      result.validatorExceptionStack = validatorResult.validatorExceptionStack;
    }

    // (Re-)categorize the result
    result.category = categorizeResult(result);

    // Increment the failure counter if this test had a failing result
    if (result.category !== FuzzResultCategory.OK) {
      failureCount++;
    }

    // Store the result for this iteration
    if (
      !env.options.onlyFailures ||
      result.category !== FuzzResultCategory.OK
    ) {
      results.results.push(result);
    }
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
  return !(
    options.maxTests < 0 ||
    options.maxFailures < 0 ||
    !ArgDef.isOptionValid(options.argDefaults)
  );
}; // fn: isOptionValid()

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
 * Returns a list of validator FunctionRefs found within the program
 *
 * @param program the program to search
 * @returns an array of validator FunctionRefs
 */
export function getValidators(
  program: ProgramDef,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  return Object.values(program.getExportedFunctions())
    .filter(
      (fn) => fn.isValidator() && fn.getName().startsWith(fnUnderTest.getName())
    )
    .map((fn) => fn.getRef());
} // fn: getValidators()

/**
 * Compares the actual output to the expected output.
 *
 * @param fuzz testing result
 * @param expected output
 * @returns true if actualOut equals expectedOut
 */
function actualEqualsExpectedOutput(
  result: FuzzTestResult,
  expectedOutput: FuzzIoElement[]
): boolean {
  if (result.timeout) {
    return expectedOutput.length > 0 && expectedOutput[0].isTimeout === true;
  } else if (result.exception) {
    return expectedOutput.length > 0 && expectedOutput[0].isException === true;
  } else {
    return JSON5.stringify(result.output) === JSON5.stringify(expectedOutput);
  }
}

/**
 * Categorizes the result of a fuzz test according to the available
 * categories defined in ResultType.
 * @param result of the test
 * @returns the category of the result
 */
export function categorizeResult(result: FuzzTestResult): FuzzResultCategory {
  if (result.validatorException) {
    return FuzzResultCategory.FAILURE; // Validator failed
  }

  const implicit = result.passedImplicit ? true : false;
  const validator =
    "passedValidator" in result ? result.passedValidator : undefined;
  const human =
    "passedHuman" in result ? (result.passedHuman ? true : false) : undefined;

  // Returns the type of bad value: execption, timeout, or badvalue
  const getBadValueType = (result: FuzzTestResult): FuzzResultCategory => {
    if (result.exception) {
      return FuzzResultCategory.EXCEPTION; // PUT threw exception
    } else if (result.timeout) {
      return FuzzResultCategory.TIMEOUT; // PUT timedout
    } else {
      return FuzzResultCategory.BADVALUE; // PUT returned bad value
    }
  };

  // Either the human oracle or the validator may take precedence
  // over the implicit oracle if they exist. However, if both the
  // validator and the human oracle are present, then they must
  // agree. If the human and validator are present yet disagree,
  // then the disagreement is another error.
  if (human === true) {
    if (validator === false) {
      return FuzzResultCategory.DISAGREE;
    } else {
      return FuzzResultCategory.OK;
    }
  } else if (human === false) {
    if (validator === true) {
      return FuzzResultCategory.DISAGREE;
    } else {
      return getBadValueType(result);
    }
  } else {
    if (validator === true) {
      return FuzzResultCategory.OK;
    } else if (validator === false) {
      return getBadValueType(result);
    } else {
      if (implicit) {
        return FuzzResultCategory.OK;
      } else {
        return getBadValueType(result);
      }
    }
  }
} // fn: categorizeResult()

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  function: FunctionDef; // the function to fuzz
  validator?: string; // name of the current validator function (if any)
  validators: FunctionRef[]; // list of the module's functions
};

/**
 * Fuzzer Test Result
 */
export type FuzzTestResults = {
  env: FuzzEnv; // fuzzer environment
  results: FuzzTestResult[]; // fuzzing test results
};

export * from "./analysis/typescript/ProgramDef";
export * from "./analysis/typescript/FunctionDef";
export * from "./analysis/typescript/ArgDef";
export * from "./analysis/typescript/Types";
export * from "./Types";
