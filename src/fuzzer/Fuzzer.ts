import * as fs from "fs";
import * as JSON5 from "json5";
import vm from "vm";
import { ArgDef } from "./analysis/typescript/ArgDef";
import { ArgValueType, FunctionRef } from "./analysis/typescript/Types";
import { CompositeInputGenerator } from "./generators/CompositeInputGenerator";
import * as compiler from "./Compiler";
import { ProgramDef } from "./analysis/typescript/ProgramDef";
import { FunctionDef } from "./analysis/typescript/FunctionDef";
import {
  FuzzIoElement,
  FuzzPinnedTest,
  FuzzTestResult,
  Result,
  FuzzResultCategory,
  FuzzStopReason,
  FuzzBusyStatusMessage,
} from "./Types";
import { FuzzOptions } from "./Types";
import { MeasureFactory } from "./measures/MeasureFactory";
import { RunnerFactory } from "./runners/RunnerFactory";
import { InputGeneratorFactory } from "./generators/InputGeneratorFactory";
import { Leaderboard } from "./generators/Leaderboard";
import { InputAndSource, ScoredInput } from "./generators/Types";
import { isError } from "../Util";
import { CodeCoverageMeasureStats } from "./measures/CoverageMeasure";

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
  pinnedTests: FuzzPinnedTest[] = [],
  updateFn?: (msg: FuzzBusyStatusMessage) => void
): Promise<FuzzTestResults> => {
  const update = (msg: FuzzBusyStatusMessage): void => {
    if (updateFn) {
      updateFn({ msg: msg.msg, milestone: msg.milestone });
    } else if (msg.milestone) {
      console.log(msg.msg);
    }
  };
  const fqSrcFile = fs.realpathSync(env.function.getModule()); // Help the module loader
  const results: FuzzTestResults = {
    env,
    stopReason: FuzzStopReason.CRASH, // updated later
    stats: {
      timers: {
        total: 0, // updated later
        run: 0, // updated later
        val: 0, // updated later
        gen: 0, // updated later
        measure: 0, // updated later
        compile: 0, // updated later
      },
      counters: {
        inputsGenerated: 0, // updated later
        dupesGenerated: 0, // updated later
        inputsInjected: 0, // updated later
      },
      generators: {}, // updated later
      measures: {}, // updated later
    },
    interesting: {
      inputs: [],
    },
    results: [], // filled later
  };
  let injectedCount = 0; // Number of inputs previously saved (e.g., pinned inputs)
  let currentDupeCount = 0; // Number of duplicated tests since the last non-duplicated test
  let totalDupeCount = 0; // Total number of duplicates generated in the fuzzing session
  let inputsGenerated = 0; // Number of inputs generated so far
  let failureCount = 0; // Number of failed tests encountered so far

  // Ensure we have a valid set of Fuzz options
  if (!isOptionValid(env.options)) {
    throw new Error(
      `Invalid options provided: ${JSON5.stringify(env.options, null, 2)}`
    );
  }

  if (!updateFn) console.log("\r\n\r\n");
  update({
    msg: `Target: ${env.function.getName()} of ${env.function.getModule()}`,
    milestone: true,
  });

  // Get the active measures, which will take various measurements
  // during execution that guide the composite generator
  const measures = MeasureFactory(env);

  // Setup the Composite Generator
  const argDefs = env.function.getArgDefs();
  const leaderboard = new Leaderboard<InputAndSource>();
  const compositeInputGenerator = new CompositeInputGenerator(
    argDefs, // spec of inputs to generate
    env.options.seed ?? "", // prng seed
    InputGeneratorFactory(env, leaderboard), // set of subordinate input generators
    measures, // measures
    leaderboard
  );

  // Inject pinned tests into the composite generator so that they generate
  // first: we want the composite generator to know about these inputs so that
  // any "interesting" inputs might be further mutated by other generators.
  compositeInputGenerator.inject(
    pinnedTests.map((t) =>
      t.input.map((i) => {
        return { value: i.value };
      })
    )
  );

  // The module that includes the function to fuzz will
  // be a TypeScript source file, so we first must compile
  // it to JavaScript prior to execution.  This activates the
  // TypeScript compiler that hooks into the require() function.
  const startCompTime = performance.now(); // start time: compile & instrument
  compiler.activate(measures, update);

  // The fuzz target is likely under development, so
  // invalidate the cache to get the latest copy.
  delete require.cache[require.resolve(fqSrcFile)];

  /* eslint eslint-comments/no-use: off */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(fqSrcFile);

  // Deactivate the TypeScript compiler
  compiler.deactivate();
  results.stats.timers.compile = performance.now() - startCompTime;

  // Build a test runner for executing tests
  const runner = RunnerFactory(env, mod, env.function.getName());

  // Main test loop
  // We break out of this loop when any of the following are true:
  //  (1) We have reached the maximum number of tests
  //  (2) We have reached the maximum number of duplicate tests
  //      since the last non-duplicated test
  //  (3) We have reached the time limit for the test suite to run
  //  (4) We have reached the maximum number of failed tests
  // Note: Pinned tests are not counted against the maxTests limit
  const startTime = new Date().getTime();
  const allInputs: Record<string, boolean> = {};

  update({ msg: `Target ready to test.`, milestone: true });

  // eslint-disable-next-line no-constant-condition, @typescript-eslint/no-unnecessary-condition
  while (true) {
    // Stop fuzzing when we encounter a stop condition
    const stopCondition = _checkStopCondition(
      env,
      inputsGenerated,
      currentDupeCount,
      totalDupeCount,
      failureCount,
      startTime,
      compositeInputGenerator.isAvailable()
    );
    if (stopCondition !== undefined) {
      results.stopReason = stopCondition;
      results.stats.timers.total = new Date().getTime() - startTime; // TODO: non-monotonic time breakage possible !!!!!
      results.stats.counters.inputsGenerated = inputsGenerated;
      results.stats.counters.dupesGenerated = totalDupeCount;
      results.stats.counters.inputsInjected = injectedCount;
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
      timers: {
        run: 0,
        gen: 0,
      },
      category: "ok",
      source: "injected",
      interestingReasons: [],
    };

    // Generate and store the inputs
    const startGenTime = performance.now(); // start time: input generation
    const genInput = compositeInputGenerator.next();
    result.timers.gen = performance.now() - startGenTime; // total time: input generation
    result.input = genInput.value.map((e, i) => {
      return {
        name: argDefs[i].getName(),
        offset: i,
        value: e.value,
      };
    });
    result.source = genInput.source.subgen;

    // Stats
    if (!(genInput.source.subgen in results.stats.generators)) {
      results.stats.generators[genInput.source.subgen] = {
        timers: {
          gen: 0, // updated below
          run: 0, // updated later
          val: 0, // updated later
          measure: 0, // updated later
        },
        counters: {
          dupesGenerated: 0, // updated later
          inputsGenerated: 0, // updated later
        },
      };
    }
    const genStats = results.stats.generators[genInput.source.subgen];
    genStats.timers.gen += result.timers.gen;
    results.stats.timers.gen += result.timers.gen;

    // Handle injected vs. generated tests differently, e.g.,
    // 1. injected tests do not count against the maxTests limit
    // 2. injected tests may or may not have an expected result
    // 3. pinned tests stay pinned
    if (genInput.source.subgen === CompositeInputGenerator.INJECTED) {
      // Ensure the injected inputs are in the expected order
      const expectedInput = JSON5.stringify(pinnedTests[injectedCount].input);
      const returnedInput = JSON5.stringify(result.input);
      if (expectedInput !== returnedInput) {
        throw new Error(
          `Injected inputs in unexpected order at injected input# ${injectedCount}. Expected: "${expectedInput}". Got: "${returnedInput}".` +
            JSON5.stringify(pinnedTests, null, 3) // !!!!!!!!
        );
      }

      // Map the pinned test information to the new result
      result.pinned = !!pinnedTests[injectedCount].pinned;
      if (pinnedTests[injectedCount].expectedOutput) {
        result.expectedOutput = pinnedTests[injectedCount].expectedOutput;
      }
      injectedCount++; // increment the number of pinned tests injected
    } else {
      // Increment the number of inputs generated
      inputsGenerated++;
      genStats.counters.inputsGenerated++;
    }

    // Prepare measures for next test execution
    {
      const startMeasTime = performance.now(); // start time: input generation
      measures.forEach((m) => {
        m.onBeforeNextTestExecution();
      });
      const measureTime = performance.now() - startMeasTime;
      results.stats.timers.measure += measureTime;
      genStats.timers.measure += measureTime;
    }

    // Skip tests if we previously processed the input
    const inputHash = JSON5.stringify(result.input);
    if (inputHash in allInputs) {
      currentDupeCount++; // increment the dupe counter
      totalDupeCount++; // incremement the total run dupe counter
      compositeInputGenerator.onInputFeedback([], result.timers.gen); // return empty input generator feedback
      genStats.counters.dupesGenerated++; // increment the generator's dupe counter
      continue; // skip this test
    } else {
      currentDupeCount = 0; // reset the duplicate count
      // if the function accepts inputs, add test input
      // to the list so we don't test it again,
      if (env.function.getArgDefs().length) {
        allInputs[inputHash] = true;
      }
    }

    // Front-end status update
    update({
      msg: `Testing input# ${
        results.results.length + 1
      }: ${env.function.getName()}(${result.input
        .map((i) => JSON5.stringify(i.value))
        .join(",")})`,
    });

    // Call the function via the wrapper
    const startRunTime = performance.now(); // start timer
    try {
      const [exeOutput] = await runner.run(
        JSON5.parse(JSON5.stringify(result.input.map((e) => e.value))),
        env.options.fnTimeout
      ); // <-- Runner (protect the input)
      result.output.push({
        name: "0",
        offset: 0,
        value: exeOutput as ArgValueType,
      });
      result.timers.run = performance.now() - startRunTime; // stop timer
    } catch (e: unknown) {
      result.timers.run = performance.now() - startRunTime; // stop timer
      const msg = isError(e) ? e.message : JSON.stringify(e);
      const stack = isError(e) ? e.stack : "<no stack>";
      if (isError(e) && isTimeoutError(e)) {
        result.timeout = true;
      } else {
        result.exception = true;
        result.exceptionMessage = msg;
        result.stack = stack;
      }
    }
    results.stats.timers.run += result.timers.run;
    genStats.timers.run += result.timers.run;

    const startValTime = performance.now(); // start timer
    // IMPLICIT ORACLE --------------------------------------------
    // How can it fail ... let us count the ways...
    if (env.options.useImplicit) {
      if (result.exception || result.timeout) {
        // Exceptions and timeouts fail the implicit oracle
        result.passedImplicit = false;
      } else if (env.function.isVoid()) {
        // Functions with a void return type should only return undefined
        result.passedImplicit = !result.output.some(
          (e) => e.value !== undefined
        );
      } else {
        // Non-void functions should not contain disallowed values
        result.passedImplicit = !result.output.some((e) => !implicitOracle(e));
      }
    }

    // HUMAN ORACLE -----------------------------------------------
    // If a human annotated an expected output, then check it
    if (env.options.useHuman && result.expectedOutput) {
      result.passedHuman = actualEqualsExpectedOutput(
        result,
        result.expectedOutput
      );
    }

    // CUSTOM VALIDATOR ------------------------------------------
    // If a custom validator is selected, call it to evaluate the result
    if (env.validators.length && env.options.useProperty) {
      // const fnName = env.validator;
      result.passedValidators = [];

      for (const valFn in env.validators) {
        const valFnName = env.validators[valFn].name;
        // Build the validator function wrapper
        const validatorFnWrapper = functionTimeout(
          (result: FuzzTestResult): FuzzTestResult => {
            const inParams: ArgValueType[] = []; // array of input parameters
            result.input.forEach((e) => {
              const param = e.value;
              inParams.push(param);
            });
            // Simplified data structure for validator function input
            const validatorIn: Result = {
              in: inParams,
              out:
                result.output.length === 0
                  ? "timeout or exception"
                  : result.output[0].value,
              exception: result.exception,
              timeout: result.timeout,
            };
            try {
              const validatorOut: boolean = mod[valFnName](validatorIn); // this is where it goes wrong -- the array just turns into []
              return {
                ...result,
                passedValidator: validatorOut,
                passedValidators: [],
              };
            } catch (e: unknown) {
              const msg = isError(e) ? e.message : JSON.stringify(e);
              const stack = isError(e) ? e.stack : "<no stack>";
              return {
                ...result,
                validatorException: true,
                validatorExceptionMessage: msg,
                validatorExceptionFunction: valFnName,
                validatorExceptionStack: stack,
              };
            }
          },
          env.options.fnTimeout
        );

        // Categorize the results (so it's not stale)
        result.category = categorizeResult(result);

        // Call the validator function wrapper
        const validatorResult = validatorFnWrapper(
          JSON5.parse(JSON5.stringify(result))
        ); // <-- Wrapper (protect the input)

        // Store the validator results
        result.passedValidators.push(validatorResult.passedValidator);
        result.validatorException = validatorResult.validatorException;
        result.validatorExceptionFunction =
          validatorResult.validatorExceptionFunction;
        result.validatorExceptionMessage =
          validatorResult.validatorExceptionMessage;
        result.validatorExceptionStack =
          validatorResult.validatorExceptionStack;
      } // for: valFn in env.validators

      result.passedValidator = true; // initialize
      for (const i in result.passedValidators) {
        result.passedValidator =
          result.passedValidator && result.passedValidators[i];
      }
    } // if validator

    // Validator stats
    const valTime = performance.now() - startValTime; // stop timer
    results.stats.timers.val += valTime;
    genStats.timers.val += valTime;

    // (Re-)categorize the result
    result.category = categorizeResult(result);

    // Increment the failure counter if this test had a failing result
    if (result.category !== "ok") {
      failureCount++;
    }

    // Store the result for this iteration
    results.results.push(result);

    // Take measurements for this test run
    {
      const startMeasureTime = performance.now(); // start timer
      const measurements = measures.map((e) =>
        e.measure(
          JSON5.parse(JSON5.stringify(genInput)),
          JSON5.parse(JSON5.stringify(result))
        )
      );

      // Provide measures feedback to the composite input generator
      result.interestingReasons = compositeInputGenerator.onInputFeedback(
        measurements,
        result.timers.run + result.timers.gen
      );

      // Measurement stats
      const measureTime = performance.now() - startMeasureTime;
      results.stats.timers.measure += measureTime;
      genStats.timers.measure += measureTime;
    }
  } // for: Main test loop

  update({ msg: "Testing finished.", milestone: true });

  // Update interesting inputs
  results.interesting.inputs = compositeInputGenerator.getInterestingInputs();

  // End-of-run processing for measures and input generators
  measures.forEach((e) => {
    e.onShutdown(results);
  });
  compositeInputGenerator.onShutdown(); // also handles shutdown for subgens

  console.log(
    ` - Executed ${results.results.length} tests in ${results.stats.timers.total}ms. Stopped for reason: ${results.stopReason}.`
  );
  console.log(
    ` - Injected ${injectedCount} and generated ${results.stats.counters.inputsGenerated} inputs (${results.stats.counters.dupesGenerated} were dupes)`
  );
  console.log(
    ` - Tests with exceptions: ${
      results.results.filter((e) => e.exception).length
    }, timeouts: ${results.results.filter((e) => e.timeout).length}`
  );
  console.log(
    ` - Human validator passed: ${
      results.results.filter((e) => e.passedHuman === true).length
    }, failed: ${results.results.filter((e) => e.passedHuman === false).length}`
  );
  console.log(
    ` - Property validator passed: ${
      results.results.filter((e) => e.passedValidator === true).length
    }, failed: ${
      results.results.filter((e) => e.passedValidator === false).length
    }`
  );
  console.log(
    ` - Heuristic validator passed: ${
      results.results.filter((e) => e.passedImplicit).length
    }, failed: ${results.results.filter((e) => !e.passedImplicit).length}`
  );

  // Persist to outfile, if requested
  if (env.options.outputFile) {
    fs.writeFileSync(env.options.outputFile, JSON5.stringify(results));
    update({
      msg: ` - Wrote results to: ${env.options.outputFile}`,
      milestone: true,
    });
  }

  // Return the result of the fuzzing activity
  return results;
}; // fn: fuzz()

/**
 * Checks whether the fuzzer should stop fuzzing. If so, return the reason.
 *
 * @param env fuzz environment
 * @param inputsGenerated number of inputs generated so far
 * @param currentDupeCount number of duplicate tests since the last non-duplicated test
 * @param totalDupeCount number of duplicate tests since the last non-duplicated test
 * @param failureCount number of failed tests encountered so far
 * @param startTime time the fuzzer started
 * @returns the reason the fuzzer stopped, if any
 */
const _checkStopCondition = (
  env: FuzzEnv,
  inputsGenerated: number,
  currentDupeCount: number,
  totalDupeCount: number,
  failureCount: number,
  startTime: number,
  moreInputs: boolean
): FuzzStopReason | undefined => {
  // End testing if we exceed the suite timeout
  if (new Date().getTime() - startTime >= env.options.suiteTimeout) {
    return FuzzStopReason.MAXTIME;
  }

  // End testing if we exceed the maximum number of tests
  if (inputsGenerated - totalDupeCount >= env.options.maxTests) {
    return FuzzStopReason.MAXTESTS;
  }

  // End testing if we exceed the maximum number of failures
  if (
    env.options.maxFailures !== 0 &&
    failureCount >= env.options.maxFailures
  ) {
    return FuzzStopReason.MAXFAILURES;
  }

  // End testing if we exceed the maximum number of duplicates generated
  if (currentDupeCount >= env.options.maxDupeInputs) {
    return FuzzStopReason.MAXDUPES;
  }

  // End testing if the source of inputs is exhausted
  if (!moreInputs) {
    return FuzzStopReason.NOMOREINPUTS;
  }

  // No stop condition found
  return undefined;
}; // fn: _checkStopCondition()

/**
 * Checks whether the given option set is valid.
 *
 * @param options fuzzer option set
 * @returns true if the options are valid, false otherwise
 */
const isOptionValid = (options: FuzzOptions): boolean => {
  return (
    options.maxTests >= 0 &&
    options.maxDupeInputs >= 0 &&
    options.maxFailures >= 0 &&
    ArgDef.isOptionValid(options.argDefaults) &&
    typeof options.generators === "object" &&
    "RandomInputGenerator" in options.generators &&
    "enabled" in options.generators.RandomInputGenerator &&
    typeof options.measures === "object"
  );
}; // fn: isOptionValid()

/**
 * The implicit oracle returns true only if the value contains no nulls, undefineds, NaNs,
 * or Infinity values.
 *
 * @param x any value
 * @returns true if x has no nulls, undefineds, NaNs, or Infinity values; false otherwise
 */
export const implicitOracle = (x: unknown): boolean => {
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
export function functionTimeout(function_: any, timeout: number): any {
  const script = new vm.Script("returnValue = function_()");

  const wrappedFunction = (...arguments_: ArgValueType[]) => {
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
export function isTimeoutError(error: unknown): boolean {
  return (
    isError(error) &&
    "code" in error &&
    error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  );
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
    return (
      JSON5.stringify(
        result.output.map((output) => {
          return { value: output.value };
        })
      ) ===
      JSON5.stringify(
        expectedOutput.map((output) => {
          return { value: output.value };
        })
      )
    );
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
    return "failure"; // Validator failed
  }

  // Returns the type of bad value: execption, timeout, or badvalue
  const getBadValueType = (result: FuzzTestResult): FuzzResultCategory => {
    if (result.exception) {
      return "exception"; // PUT threw exception
    } else if (result.timeout) {
      return "timeout"; // PUT timedout
    } else {
      return "badValue"; // PUT returned bad value
    }
  };
  const getBadValueTypeProperty = (
    result: FuzzTestResult
  ): FuzzResultCategory => {
    return result.passedValidator ? "ok" : "badValue"; // PUT returned bad value
  };

  // Setup the Composite Oracle -- we describe this in the TerzoN paper
  const implicit =
    "passedImplicit" in result ? (result.passedImplicit ? 1 : -1) : 0;
  const human = "passedHuman" in result ? (result.passedHuman ? 1 : -1) : 0;
  const property =
    "passedValidator" in result ? (result.passedValidator ? 1 : -1) : 0;

  if (human > 0) {
    if (property < 0) {
      return "disagree";
    } else {
      return "ok";
    }
  } else if (human < 0) {
    if (property > 0) {
      return "disagree";
    } else {
      return getBadValueType(result);
    }
  } else {
    // human === 0
    if (property > 0) {
      return "ok";
    } else if (property < 0) {
      return getBadValueTypeProperty(result);
    } else {
      // human === 0 && property === 0
      if (implicit >= 0) {
        return "ok";
      } else {
        return getBadValueType(result);
      }
    }
  }
} // fn: categorizeResult()

/**
 * Merge the results of two fuzzer runs.
 *
 * See comments below for some of the current limitations.
 *
 * @param `a` earlier FuzzTestResults to merge
 * @param `b` later FuzzTestResults to merge
 * @returns a FuzzTestResults representing a merge of `a` and `b1
 */
export function mergeTestResults(
  a: FuzzTestResults,
  b: FuzzTestResults
): FuzzTestResults {
  // Create c from a
  const c: FuzzTestResults = JSON5.parse(JSON5.stringify(a));
  c.env.function = b.env.function;
  c.stopReason = b.stopReason;
  // !!!!!!!! merge interesting inputs when we retain measure context across runs.

  // Merge results
  c.results.push(...b.results);

  // Merge statistics
  c.stats = {
    timers: {
      total: a.stats.timers.total + b.stats.timers.total,
      compile: a.stats.timers.compile + b.stats.timers.compile,
      run: a.stats.timers.run + b.stats.timers.run,
      val: a.stats.timers.val + b.stats.timers.val,
      gen: a.stats.timers.gen + b.stats.timers.gen,
      measure: a.stats.timers.measure + b.stats.timers.measure,
    },
    counters: {
      inputsGenerated:
        a.stats.counters.inputsGenerated + b.stats.counters.inputsGenerated,
      dupesGenerated:
        a.stats.counters.dupesGenerated + b.stats.counters.dupesGenerated,
      inputsInjected:
        a.stats.counters.inputsInjected + b.stats.counters.inputsInjected,
    },
    generators: a.stats.generators, // no change here: generation disabled
    measures: {},
  };

  // for measures, use one or the other (if only one is present) or merge (if both are present)
  if (
    a.stats.measures.CodeCoverageMeasure &&
    b.stats.measures.CodeCoverageMeasure
  ) {
    // !!!!!!!! This won't be correct in all cases: should merge coverage maps & re-calc
    c.stats.measures.CodeCoverageMeasure = {
      counters: {
        functionsTotal: Math.max(
          a.stats.measures.CodeCoverageMeasure.counters.functionsTotal,
          b.stats.measures.CodeCoverageMeasure.counters.functionsTotal
        ),
        functionsCovered: Math.max(
          a.stats.measures.CodeCoverageMeasure.counters.functionsCovered,
          b.stats.measures.CodeCoverageMeasure.counters.functionsCovered
        ),
        statementsTotal: Math.max(
          a.stats.measures.CodeCoverageMeasure.counters.statementsTotal,
          b.stats.measures.CodeCoverageMeasure.counters.statementsTotal
        ),
        statementsCovered: Math.max(
          a.stats.measures.CodeCoverageMeasure.counters.statementsCovered,
          b.stats.measures.CodeCoverageMeasure.counters.statementsCovered
        ),
        branchesTotal: Math.max(
          a.stats.measures.CodeCoverageMeasure.counters.branchesTotal,
          b.stats.measures.CodeCoverageMeasure.counters.branchesTotal
        ),
        branchesCovered: Math.max(
          a.stats.measures.CodeCoverageMeasure.counters.branchesCovered,
          b.stats.measures.CodeCoverageMeasure.counters.branchesCovered
        ),
      },
      files: a.stats.measures.CodeCoverageMeasure.files,
    };
    // Add any files from b that are missing in a
    c.stats.measures.CodeCoverageMeasure.files.push(
      ...b.stats.measures.CodeCoverageMeasure.files.filter(
        (fb) =>
          !a.stats.measures.CodeCoverageMeasure?.files.find((fa) => fa === fb)
      )
    );
  } else if (b.stats.measures.CodeCoverageMeasure) {
    c.stats.measures.CodeCoverageMeasure = {
      ...b.stats.measures.CodeCoverageMeasure,
    };
  }
  return c;
} // fn: mergeTestResults

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  function: FunctionDef; // the function to fuzz
  validators: FunctionRef[]; // list of the module's validator functions
};

/**
 * Fuzzer Test Result
 */
export type FuzzTestResults = {
  env: FuzzEnv; // fuzzer environment
  stopReason: FuzzStopReason; // why the fuzzer stopped
  stats: FuzzTestStats; // fuzzer statistics
  interesting: {
    inputs: ScoredInput[]; // interesting inputs
  };
  results: FuzzTestResult[]; // fuzzing test results
};

/**
 * Fuzzer Test Stats
 */
export type FuzzTestStats = {
  timers: {
    total: number; // elapsed time the fuzzer ran
    compile: number; // elapsed time to compile & instrument PUT
    run: number; // elapsed time the PUT ran
    val: number; // elapsed time to categorize outputs
    gen: number; // elapsed time to generate inputs
    measure: number; // elapsed time to measure
  };
  counters: {
    inputsGenerated: number; // number of inputs generated, including dupes
    dupesGenerated: number; // number of duplicate inputs generated
    inputsInjected: number; // number of inputs pinned
  };
  generators: {
    [k: string]: {
      timers: {
        run: number; // elapsed time the PUT ran
        val: number; // elapsed time to categorize outputs
        gen: number; // elapsed time to generate inputs
        measure: number; // elapsed time to measure
      };
      counters: {
        inputsGenerated: number; // number of inputs generated, including dupes
        dupesGenerated: number; // number of duplicate inputs generated
      };
    };
  };
  measures: {
    CodeCoverageMeasure?: CodeCoverageMeasureStats;
  };
};

export * from "./analysis/typescript/ProgramDef";
export * from "./analysis/typescript/FunctionDef";
export * from "./analysis/typescript/ArgDef";
export * from "./analysis/typescript/Types";
export * from "./Types";
