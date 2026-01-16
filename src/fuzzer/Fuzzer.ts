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
  BaseMeasureConfig,
} from "./Types";
import { InputAndSource, FuzzOptions } from "./Types";
import { MeasureFactory } from "./measures/MeasureFactory";
import { RunnerFactory } from "./runners/RunnerFactory";
import { Leaderboard } from "./generators/Leaderboard";
import { ScoredInput } from "./generators/Types";
import { isError, getErrorMessageOrJson } from "../fuzzer/Util";
import { CodeCoverageMeasureStats } from "./measures/CoverageMeasure";

// !!!!!!
export class Tester {
  protected _module: string; // !!!!!!
  protected _fnName: string; // !!!!!!
  protected _leaderboard = new Leaderboard<InputAndSource>();
  protected _measures; // !!!!!!
  protected _allInputs: Record<string, true> = {}; // !!!!!!
  protected _state: "init" | "running" | "paused" | "crashed" = "init"; // !!!!!!

  protected _options: FuzzOptions; // !!!!!!
  protected _program: ProgramDef; // !!!!!!
  protected _function: FunctionDef; // !!!!!!
  protected _compositeInputGenerator: CompositeInputGenerator; // !!!!!
  protected _validators: FunctionRef[] = []; // !!!!!!

  protected _results: FuzzTestResults; // !!!!!!

  // !!!!!!
  constructor(module: string, fnName: string, options: FuzzOptions) {
    this._module = require.resolve(module);
    this._fnName = fnName;

    // Get the program & function definitions
    this._program = ProgramDef.fromModule(this._module, options.argDefaults);
    const fnList = this._program.getExportedFunctions();
    if (!(this._fnName in fnList)) {
      throw new Error(
        `Could not find exported function ${this._fnName} in: ${this._module})}`
      );
    }
    this._function = fnList[this._fnName];

    // Get the list of validators
    this._validators = getValidators(this._program, fnList[this._fnName]);

    // Options
    if (!isOptionValid(options)) {
      throw new Error(
        `Invalid options provided: ${JSON5.stringify(options, null, 2)}`
      );
    }
    const strOptions = JSON5.stringify(options);
    this._options = JSON5.parse(strOptions);

    // Get the active measures, which will take various measurements
    // during execution that guide the composite generator
    //
    // Note: changes to measures only take effect at the start of testing,
    //       not when testing is paused.
    const optMeasures: Record<string, BaseMeasureConfig> =
      this._options.measures;
    this._measures = MeasureFactory().filter((m) =>
      m.name in optMeasures ? optMeasures[m.name].enabled : false
    );

    // Generators
    this._compositeInputGenerator = new CompositeInputGenerator(
      this._options.generators, // generator options
      this._function, // input generation target
      options.seed, // prng seed
      this._measures, // active measures
      this._leaderboard // leaderboard
    );

    // Initialize results
    this._results = this._getInitializedResults();
  }

  // !!!!!!
  protected _getInitializedResults(): FuzzTestResults {
    return {
      env: {
        options: JSON5.parse(JSON5.stringify(this._options)),
        function: this._function,
        validators: JSON5.parse(JSON5.stringify(this._validators)),
      },
      stopReason: FuzzStopReason.CRASH, // updated later
      stats: {
        timers: {
          total: 0, // updated later
          put: 0, // updated later
          val: 0, // updated later
          gen: 0, // updated later
          measure: 0, // updated later
          compile: 0, // updated later
        },
        counters: {
          testingRuns: 0, // updated later
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
      results: [], // filled later  } // fn: constructor
    };
  } // !!!!!!

  // !!!!!!
  public set options(options: FuzzOptions) {
    // Ensure we have a valid set of Fuzz options
    if (!isOptionValid(options)) {
      throw new Error(
        `Invalid options provided: ${JSON5.stringify(options, null, 2)}`
      );
    }

    // If we already have an option set and it differs
    // from the new one, handle the option changes.
    // Otherwise, just use the new option set
    const strOptions = JSON5.stringify(options);
    if (JSON5.stringify(this._options) !== strOptions) {
      this._options = JSON5.parse(strOptions);
      this._results.env.options = JSON5.parse(strOptions);
      this._compositeInputGenerator.options = this._options.generators;
    }
  } // !!!!!!

  // !!!!!!
  // For compatibility.... should probably go away !!!!!!!
  public get env(): FuzzEnv {
    return {
      options: JSON5.parse(JSON5.stringify(this._options)),
      function: this._function,
      validators: JSON5.parse(JSON5.stringify(this._validators)),
    };
  } // !!!!!!

  // !!!!!!
  public get state(): typeof this._state {
    return this._state;
    /*
    // check for validator changes; update validator results? !!!!!!!!
    // check for program changes; re-compile !!!!!!!!

    return {status: "paused"};
    */
  } // !!!!!!

  // !!!!!!
  public testSync(injectTests: FuzzPinnedTest[] = []): FuzzTestResults {
    let result: FuzzTestResults | undefined;
    try {
      const run = this._run(injectTests);
      while (!result) {
        result = run.next().value;
      }
      return result;
    } catch (e: unknown) {
      this._state = "crashed";
      throw e;
    }
  } // !!!!!!

  // !!!!!!
  public async testAsync(
    injectTests: FuzzPinnedTest[] = [],
    callbackFn: (result: FuzzTestResults | Error) => void,
    statusFn?: (payload: FuzzBusyStatusMessage) => void,
    cancelFn?: () => boolean
  ): Promise<void> {
    this.runBatchAsync(callbackFn, this._run(injectTests, statusFn, cancelFn));
  } // !!!!!!

  // !!!!!!
  protected runBatchAsync(
    callbackFn: (result: FuzzTestResults | Error) => void,
    run: ReturnType<typeof this._run>
  ): void {
    let result: FuzzTestResults | undefined;
    const timer = performance.now();

    while (!result && performance.now() - timer < 100) {
      try {
        result = run.next().value;
        if (result) {
          callbackFn(result);
          return;
        }
      } catch (e) {
        this._state = "crashed";
        callbackFn(
          isError(e)
            ? e
            : { name: "unknown error", message: JSON5.stringify(e) }
        );
        return;
      }
    }
    if (!result)
      setTimeout(() => {
        this.runBatchAsync(callbackFn, run);
      });
  } // !!!!!!

  // !!!!!!
  protected *_run(
    injectTests: FuzzPinnedTest[] = [],
    updateFn?: (payload: FuzzBusyStatusMessage) => void,
    cancelFn?: () => boolean
  ): Generator<
    FuzzTestResults | undefined,
    FuzzTestResults,
    FuzzTestResults | undefined
  > {
    const state = this.state;
    if (!(state === "init" || state === "paused")) {
      throw new Error(
        `Testing cannot be started or resumed from state ${state}`
      );
    }
    this._state = "running";
    this._results.stats.counters.testingRuns++;

    const update = (payload: FuzzBusyStatusMessage): void => {
      if (updateFn) {
        updateFn({
          msg: payload.msg,
          milestone: payload.milestone,
          pct: payload.pct,
        });
      } else if (payload.milestone) {
        console.log(payload.msg);
      }
    };
    const runStats = {
      counters: {
        inputsInjected: 0, // number of inputs injected for testing
        inputsGenerated: 0, // number of inputs generated so far
        dupesGenerated: 0, // number of duplicate inputs generated so far
        dupesSequential: 0, // current number of duplicate inputs generated in a row
        failedTests: 0, // number of failed tests encountered so far
        passedTests: 0, // number of passed tests encountered so far
      },
      timers: {
        startTime: performance.now(), // time the tester started in this run
      },
    };

    if (!updateFn) console.log("\r\n\r\n");
    update({
      msg: `Target: ${this._function.getName()} of ${this._function.getModule()}`,
      milestone: true,
    });

    const argDefs = this._function.getArgDefs();

    // Inject pinned tests into the composite generator so that they generate
    // first: we want the composite generator to know about these inputs so that
    // any "interesting" inputs might be further used by other generators.
    this._compositeInputGenerator.inject(
      injectTests.map((t): Omit<InputAndSource, "tick"> => {
        return {
          value: t.input.map((i) => {
            return {
              value: i.value,
            };
          }),
          source: t.input.length ? t.input[0].origin : { type: "unknown" },
        };
      })
    );

    // The module that includes the function to fuzz will
    // be a TypeScript source file, so we first must compile
    // it to JavaScript prior to execution.  This activates the
    // TypeScript compiler that hooks into the require() function.
    const startCompTime = performance.now(); // start time: compile & instrument
    compiler.activate(this._measures /*!!!!!!! active*/, update);

    // The fuzz target is likely under development, so
    // invalidate the cache to get the latest copy.
    const fqSrcFile = fs.realpathSync(this._function.getModule()); // Help the module loader
    delete require.cache[require.resolve(fqSrcFile)];

    /* eslint eslint-comments/no-use: off */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(fqSrcFile);

    // Deactivate the TypeScript compiler
    compiler.deactivate();
    this._results.stats.timers.compile = performance.now() - startCompTime;

    // Build a test runner for executing tests
    const runner = RunnerFactory(this.env, mod, this._function.getName());

    update({ msg: `Target ready to test.`, milestone: true });

    // Main test loop
    // We break out of this loop when any of the following are true:
    //  (1) We have reached the maximum number of tests
    //  (2) We have reached the maximum number of duplicate tests
    //      since the last non-duplicated test
    //  (3) We have reached the time limit for the test suite to run
    //  (4) We have reached the maximum number of failed tests
    // Note: Pinned tests are not counted against the maxTests limit
    // eslint-disable-next-line no-constant-condition, @typescript-eslint/no-unnecessary-condition
    while (true) {
      // End the testing run when we encounter a stop condition
      const stopCondition = _checkStopCondition(
        this._options,
        this._compositeInputGenerator.isAvailable(),
        this._compositeInputGenerator.noGenerators(),
        injectTests.length,
        !!cancelFn && cancelFn(),
        runStats
      );
      if (typeof stopCondition !== "number") {
        // Calculate final stats
        this._results.stopReason = stopCondition;
        this._results.stats.timers.total +=
          performance.now() - runStats.timers.startTime;
        this._results.stats.counters.inputsGenerated +=
          runStats.counters.inputsGenerated;
        this._results.stats.counters.dupesGenerated +=
          runStats.counters.dupesGenerated;
        this._results.stats.counters.inputsInjected +=
          runStats.counters.inputsInjected;
        update({
          msg: `Testing ${cancelFn && cancelFn() ? "paused" : "finished"}.`,
          milestone: true,
          pct: 100,
        });
        update({
          msg: `Testing ${
            cancelFn && cancelFn() ? "paused" : "finished"
          }.\r\n  Tests passed: ${
            runStats.counters.passedTests
          }\r\n  Tests failed: ${runStats.counters.failedTests}`,
          milestone: false,
          pct: 100,
        });

        // Update interesting inputs
        this._results.interesting.inputs =
          this._compositeInputGenerator.getInterestingInputs();

        // End-of-run processing for measures and input generators
        this._measures.forEach((e) => {
          e.onRunEnd(this._results);
        });
        this._compositeInputGenerator.onRunEnd(); // also handles shutdown for subgens

        console.log(
          ` - Executed ${
            runStats.counters.passedTests + runStats.counters.failedTests
          } tests in ${(performance.now() - runStats.timers.startTime).toFixed(
            0
          )} ms this run. Stopped for reason: ${this._results.stopReason}.`
        );
        console.log(
          ` - Injected ${runStats.counters.inputsInjected} and generated ${runStats.counters.inputsGenerated} inputs (${runStats.counters.dupesGenerated} were dupes) this run.`
        );
        console.log(
          ` - Total tests with exceptions: ${
            this._results.results.filter((e) => e.exception).length
          }, timeouts: ${this._results.results.filter((e) => e.timeout).length}`
        );
        console.log(
          ` - Total tests where human validator passed: ${
            this._results.results.filter((e) => e.passedHuman === true).length
          }, failed: ${
            this._results.results.filter((e) => e.passedHuman === false).length
          }`
        );
        console.log(
          ` - Total tests where property validator passed: ${
            this._results.results.filter((e) => e.passedValidator === true)
              .length
          }, failed: ${
            this._results.results.filter((e) => e.passedValidator === false)
              .length
          }`
        );
        console.log(
          ` - Total tests where heuristic validator passed: ${
            this._results.results.filter((e) => e.passedImplicit).length
          }, failed: ${
            this._results.results.filter((e) => !e.passedImplicit).length
          }`
        );

        // Persist to outfile, if requested
        if (this._options.outputFile) {
          fs.writeFileSync(
            this._options.outputFile,
            JSON5.stringify(this._results)
          );
          update({
            msg: ` - Wrote results to: ${this._options.outputFile}`,
            milestone: true,
          });
        }
        this._state = "paused";
        return this._results;
      }

      // If starting a new run, record the start time
      if (runStats.timers.startTime === 0) {
        runStats.timers.startTime = performance.now();
      }

      // Initialized test result - overwritten below
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
        interestingReasons: [],
      };

      // Generate and store the inputs
      const startGenTime = performance.now(); // start time: input generation
      const genInput = this._compositeInputGenerator.next();
      result.timers.gen = performance.now() - startGenTime; // total time: input generation
      result.input = genInput.value.map((e, i) => {
        return {
          name: argDefs[i].getName(),
          offset: i,
          value: e.value,
          origin: genInput.source,
        };
      });

      // Stats
      const statKey = genInput.injected
        ? `injected`
        : genInput.source.type === "generator"
        ? `${genInput.source.type}.${genInput.source.generator}`
        : `${genInput.source.type}`;
      if (!(statKey in this._results.stats.generators)) {
        this._results.stats.generators[statKey] = {
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
      const genStats = this._results.stats.generators[statKey];
      genStats.timers.gen += result.timers.gen;
      this._results.stats.timers.gen += result.timers.gen;

      // Handle injected vs. generated tests differently, e.g.,
      // 1. injected tests do not count against the maxTests limit
      // 2. injected tests may or may not have an expected result
      // 3. pinned tests stay pinned
      if (genInput.injected) {
        // Ensure the injected inputs are in the expected order
        const expectedInput = JSON5.stringify(
          injectTests[runStats.counters.inputsInjected].input
        );
        const returnedInput = JSON5.stringify(result.input);
        if (expectedInput !== returnedInput) {
          throw new Error(
            `Injected inputs in unexpected order at injected input# ${runStats.counters.inputsInjected}. Expected: "${expectedInput}". Got: "${returnedInput}".` +
              JSON5.stringify(injectTests, null, 3) // !!!!!!!!
          );
        }

        // Map the injected test information to the new result
        const pinnedTest = injectTests[runStats.counters.inputsInjected];
        result.pinned = !!pinnedTest.pinned;
        if (result.pinned) {
          console.debug(`pinned: ${expectedInput}`); // !!!!!!!!
        }
        if (pinnedTest.expectedOutput) {
          console.debug(`expout: ${expectedInput}`); // !!!!!!!!
          result.expectedOutput = pinnedTest.expectedOutput;
        }
        runStats.counters.inputsInjected++; // increment the number of pinned tests injected
      } else {
        // Increment the number of inputs generated
        runStats.counters.inputsGenerated++;
        genStats.counters.inputsGenerated++;
      }

      // Prepare measures for next test execution
      {
        const startMeasTime = performance.now(); // start time: input generation
        this._measures.forEach((m) => {
          m.onBeforeNextTestExecution();
        });
        const measureTime = performance.now() - startMeasTime;
        this._results.stats.timers.measure += measureTime;
        genStats.timers.measure += measureTime;
      }

      // Skip tests if we previously processed the input
      const inputHash = getIoKey(result.input);
      if (inputHash in this._allInputs) {
        runStats.counters.dupesSequential++; // increment the dupe counter
        runStats.counters.dupesGenerated++; // incremement the total run dupe counter
        this._compositeInputGenerator.onInputFeedback([], result.timers.gen); // return empty input generator feedback
        genStats.counters.dupesGenerated++; // increment the generator's dupe counter
        continue; // skip this test
      } else {
        runStats.counters.dupesSequential = 0; // reset the duplicate count
        // if the function accepts inputs, add test input
        // to the list so we don't test it again,
        if (this._function.getArgDefs().length) {
          this._allInputs[inputHash] = true;
        }
      }

      // Front-end status update
      /* !!!!!!!! Return values rather than text here. Also "failed" is unclear. */
      update({
        msg: `Testing input# ${
          runStats.counters.passedTests + runStats.counters.failedTests + 1
        }: ${this._function.getName()}(${result.input
          .map((i) => JSON5.stringify(i.value))
          .join(",")})\r\n  Tests passed: ${
          runStats.counters.passedTests
        }\r\n  Tests failed: ${runStats.counters.failedTests}`,
        pct: typeof stopCondition === "number" ? stopCondition : 100,
      });

      // Call the function via the wrapper
      const startRunTime = performance.now(); // start timer
      try {
        const [exeOutput] = runner.run(
          JSON5.parse(JSON5.stringify(result.input.map((e) => e.value))),
          this._options.fnTimeout
        ); // <-- Runner (protect the input)
        result.output.push({
          name: "0",
          offset: 0,
          value: exeOutput as ArgValueType,
          origin: { type: "put" },
        });
        result.timers.run = performance.now() - startRunTime; // stop timer
      } catch (e: unknown) {
        result.timers.run = performance.now() - startRunTime; // stop timer
        const msg = getErrorMessageOrJson(e);
        const stack = isError(e) ? e.stack : "<no stack>";
        if (isTimeoutError(e)) {
          result.timeout = true;
        } else {
          result.exception = true;
          result.exceptionMessage = msg;
          result.stack = stack;
        }
      }
      this._results.stats.timers.put += result.timers.run;
      genStats.timers.run += result.timers.run;

      const startValTime = performance.now(); // start timer
      // IMPLICIT ORACLE --------------------------------------------
      // How can it fail ... let us count the ways...
      if (this._options.useImplicit) {
        if (result.exception || result.timeout) {
          // Exceptions and timeouts fail the implicit oracle
          result.passedImplicit = false;
        } else if (this._function.isVoid()) {
          // Functions with a void return type should only return undefined
          result.passedImplicit = !result.output.some(
            (e) => e.value !== undefined
          );
        } else {
          // Non-void functions should not contain disallowed values
          result.passedImplicit = !result.output.some(
            (e) => !implicitOracle(e)
          );
        }
      }

      // HUMAN ORACLE -----------------------------------------------
      // If a human annotated an expected output, then check it
      if (this._options.useHuman && result.expectedOutput) {
        result.passedHuman = actualEqualsExpectedOutput(
          result,
          result.expectedOutput
        );
      }

      // CUSTOM VALIDATOR ------------------------------------------
      // If a custom validator is selected, call it to evaluate the result
      if (this._validators.length && this._options.useProperty) {
        // const fnName = env.validator;
        result.passedValidators = [];

        for (const valFn in this._validators) {
          const valFnName = this._validators[valFn].name;
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
            this._options.fnTimeout
          );

          // Categorize the result (so it's not stale)
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
      this._results.stats.timers.val += valTime;
      genStats.timers.val += valTime;

      // (Re-)categorize the result
      result.category = categorizeResult(result);

      // Increment the test counters
      if (result.category === "ok") {
        runStats.counters.passedTests++;
      } else {
        runStats.counters.failedTests++;
      }

      // Store the result for this iteration
      this._results.results.push(result);

      // Take measurements for this test run
      {
        const startMeasureTime = performance.now(); // start timer
        const measurements = this._measures.map((e) =>
          e.measure(
            JSON5.parse(JSON5.stringify(genInput)),
            JSON5.parse(JSON5.stringify(result))
          )
        );

        // Provide measures feedback to the composite input generator
        result.interestingReasons =
          this._compositeInputGenerator.onInputFeedback(
            measurements,
            result.timers.run + result.timers.gen
          );

        // Measurement stats
        const measureTime = performance.now() - startMeasureTime;
        this._results.stats.timers.measure += measureTime;
        genStats.timers.measure += measureTime;
      }

      yield undefined;
    } // for: Main test loop
  } // fn: _run
} // class: Tester

// !!!!!!
export type CurrentRunStats = {
  counters: {
    inputsInjected: number; // number of inputs injected for testing
    inputsGenerated: number; // number of inputs generated so far
    dupesGenerated: number; // number of duplicate inputs generated so far
    dupesSequential: number; // current number of duplicate inputs generated in a row
    failedTests: number; // number of failed tests encountered so far
    passedTests: number; // number of passed tests encountered so far
  };
  timers: {
    startTime: number; // time the tester started in this run
  };
};

/**
 * Checks whether the fuzzer should stop fuzzing. If so, return the reason.
 *
 * @param `env` fuzz environment
 * @param `moreInputs` indicates whether more inputs can be produced
 * @param `userCancel` indicates whether the user cancelled testing
 * @returns either the stop reason or percentage complete
 */
const _checkStopCondition = (
  options: FuzzOptions,
  moreInputs: boolean,
  injectOnly: boolean,
  injectCount: number,
  userCancel: boolean,
  stats: CurrentRunStats
): FuzzStopReason | number => {
  const pcts: number[] = [0];
  const now = performance.now();

  // End testing if the user cancels it exceed the suite timeou
  if (userCancel) {
    return FuzzStopReason.CANCEL;
  }

  // End testing if we exceed the suite timeout
  if (options.suiteTimeout > 0) {
    if (now - stats.timers.startTime >= options.suiteTimeout) {
      return FuzzStopReason.MAXTIME;
    }
    pcts.push((now - stats.timers.startTime) / options.suiteTimeout);
  }

  // End testing if we exceed the maximum number of generated tests
  if (
    stats.counters.inputsGenerated - stats.counters.dupesGenerated >=
    options.maxTests
  ) {
    return FuzzStopReason.MAXTESTS;
  }
  pcts.push(
    (stats.counters.inputsGenerated - stats.counters.dupesGenerated) /
      options.maxTests
  );

  // End testing if we exceed the maximum number of failures
  if (options.maxFailures > 0) {
    if (stats.counters.failedTests >= options.maxFailures) {
      return FuzzStopReason.MAXFAILURES;
    }
    pcts.push(stats.counters.failedTests / options.maxFailures);
  }

  // End testing if we exceed the maximum number of sequential duplicates generated
  if (stats.counters.dupesSequential >= options.maxDupeInputs) {
    return FuzzStopReason.MAXDUPES;
  }
  // We don't do a pct because one non-dupe resets this counter

  // End testing if the source of inputs is exhausted
  if (!moreInputs) {
    return FuzzStopReason.NOMOREINPUTS;
  }
  if (injectOnly) {
    pcts.push(stats.counters.inputsInjected / injectCount);
  }

  // No stop condition found; return pct complete
  return Math.max(0, Math.floor(Math.max(...pcts) * 100));
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
} // !!!!!!

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

// !!!!!!
export function getIoKey(io: FuzzIoElement[]): string {
  return JSON5.stringify(
    io.map((input) => {
      return { value: input.value };
    })
  );
} // fn: getIoKey

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
    put: number; // elapsed time the PUT ran
    val: number; // elapsed time to categorize outputs
    gen: number; // elapsed time to generate inputs
    measure: number; // elapsed time to measure
  };
  counters: {
    testingRuns: number; // number of test runs
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
