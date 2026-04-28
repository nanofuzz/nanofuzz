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
import { InputGeneratorStatsAi, ScoredInput } from "./generators/Types";
import { isError, getErrorMessageOrJson } from "../fuzzer/Util";
import { CodeCoverageMeasureStats } from "./measures/CoverageMeasure";
import { CompositeOracle } from "./oracles/CompositeOracle";
import { ImplicitOracle } from "./oracles/ImplicitOracle";
import { ExampleOracle } from "./oracles/ExampleOracle";

export class Tester {
  protected _module: string; // module filename
  protected _fnName: string; // function name
  protected _leaderboard = new Leaderboard<InputAndSource>(); // top test results, according to measures
  protected _measures; // set of measures for executions
  protected _allInputs: Record<string, true> = {}; // dupe check for input generation
  protected _state: "init" | "ready" | "running" | "paused" | "crashed" =
    "init"; // tester state

  protected _options: FuzzOptions; // testing options
  protected _program: ProgramDef; // program under test
  protected _function: FunctionDef; // function under test
  protected _compositeInputGenerator: CompositeInputGenerator; // composite input generator
  protected _validators: FunctionRef[] = []; // property validator functions
  protected _lastCompiler?: compiler.TypeScriptCompiler; // last compiler object used

  protected _results: FuzzTestResults; // test results

  constructor(
    module: string,
    fnName: string,
    options: FuzzOptions,
    mode: { precompile?: true } = {}
  ) {
    this._module = require.resolve(module);
    this._fnName = fnName;

    // Get the program & function definitions
    try {
      this._program = ProgramDef.fromModule(this._module, options.argDefaults);
    } catch (e: unknown) {
      throw new Error(
        `The TypeScript program could not be parsed. Please fix the errors and retest.${
          isError(e) ? ` (${e.message})` : ``
        }`,
        { cause: e }
      );
    }
    const fnList = this._program.getExportedFunctions();
    if (!(this._fnName in fnList)) {
      throw new Error(
        `Could not find exported function ${this._fnName} in: ${this._module}`
      );
    }
    this._function = fnList[this._fnName];

    // Get the list of property validators
    this._validators = getValidators(this._program, fnList[this._fnName]);

    // Options
    if (!isOptionValid(options)) {
      throw new Error(
        `Invalid options provided: ${JSON5.stringify(options, null, 2)}`
      );
    }
    this._options = JSON5.parse<typeof options>(JSON5.stringify(options));

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

    // Initialize results
    this._results = this._getInitializedResults();

    // Generators
    this._compositeInputGenerator = new CompositeInputGenerator(
      this._options.generators, // generator options
      this._function, // input generation target
      options.seed, // prng seed
      this._measures, // active measures
      this._leaderboard, // leaderboard
      this._results.stats.generators
    );

    // Start a background compilation
    if (mode.precompile) {
      compiler.TypeScriptCompiler.compileAsync(module);
    }
  }

  /**
   * Returns `true` if the tester is out-of-date or crashed
   *
   * @param options FuzzOptions
   * @returns a reason code if the tester is out-of-date or crashed and `false` otherwise.
   */
  public isStale(
    options: FuzzOptions
  ):
    | ReturnType<compiler.TypeScriptCompiler["isStale"]>
    | "optionschanged"
    | "crashed" {
    // Stale: compilation is stale
    if (this._lastCompiler) {
      const compilerIsStale = this._lastCompiler.isStale();
      if (compilerIsStale) {
        return compilerIsStale;
      }
    }
    // Helper function to select only the options that would trigger
    // a full retest
    const retestRelevantOptions = (opt: FuzzOptions): Partial<FuzzOptions> => {
      return {
        measures: opt.measures, // affects future test generation
        useProperty: opt.useProperty, // affects test results
        useImplicit: opt.useImplicit, // affects test results
        useHuman: opt.useHuman, // affects test results
      };
    };

    // Stale: options are stale
    if (
      JSON5.stringify(retestRelevantOptions(options)) !==
      JSON5.stringify(retestRelevantOptions(this._options))
    ) {
      return "optionschanged";
    }

    // Stale: tester crashed
    if (this._state === "crashed") {
      return "crashed";
    }

    // Not stale
    return false;
  } // fn: isStale

  /**
   * Creates a new, empty set of fuzzer results
   *
   * @returns initialized Fuzzer Results
   */
  protected _getInitializedResults(): FuzzTestResults {
    return {
      env: {
        options: JSON5.parse<typeof this._options>(
          JSON5.stringify(this._options)
        ),
        function: this._function,
        validators: JSON5.parse<typeof this._validators>(
          JSON5.stringify(this._validators)
        ),
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
        generators: {
          RandomInputGenerator: {
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
          },
          MutationInputGenerator: {
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
          },
          AiInputGenerator: {
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
          },
        },
        measures: {}, // updated later
      },
      interesting: {
        inputs: [],
      },
      results: [], // filled later
    };
  } // fn: _getInitializedResults

  /**
   * Sets the tester options
   * (can we eliminate this? !!!!!!)
   */
  public set options(options: FuzzOptions) {
    // Ensure we have a valid set of Fuzz options
    if (!isOptionValid(options)) {
      throw new Error(
        `Invalid options provided: ${JSON5.stringify(options, null, 2)}`
      );
    }

    // If we already have an option set and it differs
    // from the new one, use the new options.
    const strOptions = JSON5.stringify(options);
    if (JSON5.stringify(this._options) !== strOptions) {
      this._options = JSON5.parse<typeof options>(strOptions);
      this._results.env.options = JSON5.parse<typeof options>(strOptions);
      this._compositeInputGenerator.options = this._options.generators;
    }
  } // property: set options

  /**
   * Returns the current `FuzzEnv`
   * (Retained for prior compatibility.... should probably go away !!!!!!!)
   */
  public get env(): FuzzEnv {
    return {
      options: JSON5.parse<typeof this._options>(
        JSON5.stringify(this._options)
      ),
      function: this._function,
      validators: JSON5.parse<typeof this._validators>(
        JSON5.stringify(this._validators)
      ),
    };
  } // property: get env

  /**
   * Returns the current state
   */
  public get state(): typeof this._state {
    return this._state;
  } // property: get state

  /**
   * Runs the tester in sync mode and returns its results.
   *
   * @param `injectTests` tests to inject
   * @param `mode` testing mode
   * @returns `FuzzTestResults`
   */
  public testSync(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true }
  ): FuzzTestResults {
    let result: FuzzTestResults | undefined;
    try {
      const run = this._run(injectTests, mode);
      while (!result) {
        result = run.next().value;
      }
      return result;
    } catch (e: unknown) {
      if (this._state === "running") {
        this._state = "crashed";
      }
      throw e;
    }
  } // fn: testSync

  /**
   * Runs the tester in async mode and returns its results
   * via `callbackFn`.
   *
   * @param `injectTests` tests to inject
   * @param `mode` testing mode
   * @param `callbackFn` called when testing completes
   * @param `statusFn` called to report status updates
   * @param `cancelFn` called to check cancel status
   */
  public async testAsync(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
    callbackFn: (result: FuzzTestResults | Error) => void,
    statusFn?: (payload: FuzzBusyStatusMessage) => void,
    cancelFn?: () => boolean
  ): Promise<void> {
    this._runBatchAsync(
      callbackFn,
      this._run(injectTests, mode, statusFn, cancelFn)
    );
  } // fn: testAsync

  /**
   * Runs the tester in batch async mode
   *
   * @param `callbackFn` called when testing completes
   * @param `run` generator function
   */
  protected _runBatchAsync(
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
        if (this._state === "running") {
          this._state = "crashed";
        }
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
        this._runBatchAsync(callbackFn, run);
      });
  } // fn: _runBatchAsync

  /**
   * Generates and returns new test results
   *
   * @param `injectTests` tests to inject
   * @param `mode` tester mode
   * @param `updateFn` called to report status updates
   * @param `cancelFn` called to check cancel status
   * @returns test results
   */
  protected *_run(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
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
        startGenTime: 0, // time the tester started generating inputs in this run
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
              tag: "ArgValueTypeWrapped",
              value: i.value,
            };
          }),
          source: t.input.length ? t.input[0].origin : { type: "unknown" },
        };
      })
    );

    // Only generate new inputs if running in input generation mode
    if (mode.gen) {
      this._compositeInputGenerator.permitGenerators();
    } else {
      this._compositeInputGenerator.suppressGenerators();
    }

    // Indicate the start of the run
    this._compositeInputGenerator.onRunStart(!!mode.gen);

    // The target will be a TypeScript function, so we must compile
    // it to JavaScript (and possibly instrument it) prior to execution.
    const fqSrcFile = fs.realpathSync(this._function.getModule()); // Help the module loader
    const startCompTime = performance.now(); // start time: compile & instrument
    this._lastCompiler = new compiler.TypeScriptCompiler(fqSrcFile);
    const mod = this._lastCompiler.compileSync(this._measures, update);
    this._results.stats.timers.compile = performance.now() - startCompTime;

    // Build a test runner for executing tests
    const runner = RunnerFactory(this.env, mod, this._function.getName());

    // Are we currently injecting inputs?
    let stillInjecting = !!injectTests.length;

    update({ msg: `Target ready to test.`, milestone: true, pct: 0.01 });
    this._state = "ready";

    // Main test loop
    while (true) {
      this._state = "running";
      // End the testing run when we encounter a stop condition
      const stopCondition = _checkStopCondition(
        this._options,
        this._compositeInputGenerator.nextable(),
        stillInjecting,
        injectTests.length,
        !!cancelFn && cancelFn(),
        runStats,
        !!mode.gen
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
            msg: `Wrote results to: ${this._options.outputFile}`,
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

      // Pointer to generator stats for this input, if not injected
      let genStats:
        | FuzzTestStats["generators"]["RandomInputGenerator"]
        | undefined = undefined;

      // Handle injected and generated tests differently, e.g.,
      // we need to retain any saved details for injected tests.
      if (genInput.injected) {
        // Ensure the injected inputs are in the expected order
        const expectedInput = JSON5.stringify(
          injectTests[runStats.counters.inputsInjected].input
        );
        const returnedInput = JSON5.stringify(result.input);
        if (expectedInput !== returnedInput) {
          throw new Error(
            `Injected inputs in unexpected order at injected input# ${runStats.counters.inputsInjected}. Expected: "${expectedInput}". Got: "${returnedInput}".` +
              JSON5.stringify(injectTests, null, 3)
          );
        }

        // Map the injected test information to the new result
        const pinnedTest = injectTests[runStats.counters.inputsInjected];
        result.pinned = !!pinnedTest.pinned;
        if (pinnedTest.expectedOutput) {
          result.expectedOutput = pinnedTest.expectedOutput;
        }
        runStats.counters.inputsInjected++; // increment the number of pinned tests injected
      } else {
        // Update generator stats
        if (genInput.source.type === "generator") {
          // Add generation times to the generator stats
          genStats = this._results.stats.generators[genInput.source.generator];
          genStats.timers.gen += result.timers.gen;
          this._results.stats.timers.gen += result.timers.gen;

          // Increment the number of inputs generated
          runStats.counters.inputsGenerated++;
          genStats.counters.inputsGenerated++;

          // Log the generation start time
          if (runStats.timers.startGenTime === 0) {
            runStats.timers.startGenTime = startGenTime;
          }
        }
        // Indicate that we are no longer injecting inputs
        stillInjecting = false;
      }

      // Prepare measures for next test execution
      {
        const startMeasTime = performance.now(); // start time: input generation
        this._measures.forEach((m) => {
          m.onBeforeNextTestExecution();
        });
        const measureTime = performance.now() - startMeasTime;
        this._results.stats.timers.measure += measureTime;
        if (genStats) {
          genStats.timers.measure += measureTime;
        }
      }

      // Skip tests if we previously processed the input
      const inputHash = getIoKey(result.input);
      if (inputHash in this._allInputs) {
        runStats.counters.dupesSequential++; // increment the dupe counter
        runStats.counters.dupesGenerated++; // incremement the total run dupe counter
        this._compositeInputGenerator.onInputFeedback([], result.timers.gen); // return empty input generator feedback
        if (genStats) {
          genStats.counters.dupesGenerated++; // increment the generator's dupe counter
        }

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
      update({
        msg: `${cancelFn && cancelFn() && stillInjecting ? "Pause pending retest of prior inputs.\r\n" : ""}${stillInjecting ? "Retesting prior" : "Generating new test"} input# ${
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
        const inputValues = result.input.map((e) => e.value);
        const [exeOutput] = runner.run(
          JSON5.parse<typeof inputValues>(JSON5.stringify(inputValues)),
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
      if (genStats) {
        genStats.timers.run += result.timers.run;
      }

      const startValTime = performance.now(); // start timer
      // IMPLICIT ORACLE --------------------------------------------
      if (this._options.useImplicit) {
        result.passedImplicit =
          ImplicitOracle.judge(
            result.timeout,
            result.exception,
            this._function.isVoid(),
            result.output
          ) === "pass";
      }

      // EXAMPLE ORACLE ---------------------------------------------
      // If a human annotated an expected output, then check it
      if (this._options.useHuman && result.expectedOutput) {
        result.passedHuman =
          ExampleOracle.judge(
            result.timeout,
            result.exception,
            result.expectedOutput,
            result.output
          ) === "pass";
      }

      // PROPERTY VALIDATOR ------------------------------------------
      // If a property validator is selected, call it to evaluate the result
      // TODO: Get this out of the fuzzer similar to the other oracles
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
                const validatorOut: boolean | undefined =
                  mod[valFnName](validatorIn);
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
          const validatorResult: typeof result = validatorFnWrapper(
            JSON5.parse<typeof result>(JSON5.stringify(result))
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

        result.passedValidator = undefined; // initialize
        for (const i in result.passedValidators) {
          const thisJudgment: boolean | undefined = result.passedValidators[i];
          if (thisJudgment === true || thisJudgment === false) {
            result.passedValidator =
              result.passedValidator === undefined
                ? !!thisJudgment
                : result.passedValidator && !!thisJudgment;
          }
        }
      } // if validator

      // Validator stats
      const valTime = performance.now() - startValTime; // stop timer
      this._results.stats.timers.val += valTime;
      if (genStats) {
        genStats.timers.val += valTime;
      }

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
            JSON5.parse<typeof genInput>(JSON5.stringify(genInput)),
            JSON5.parse<typeof result>(JSON5.stringify(result))
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
        if (genStats) {
          genStats.timers.measure += measureTime;
        }
      }

      yield undefined;
    } // for: Main test loop
  } // fn: _run
} // class: Tester

/**
 * Returns either a readon for the fuzzer to stop fuzzing or a percentage
 * representing progress toward the nearest stop condition.
 *
 * Reasons to stop:
 *  - We have reached the maximum number of tests
 *  - We have reached the maximum number of duplicate tests
 *    since the last non-duplicated test
 *  - We have reached the time limit for the test suite to run
 *  - We have reached the maximum number of failed tests
 * Note: Injected tests are not counted against many limits
 *
 * @param `options` fuzzer options
 * @param `moreInputs` indicates whether more inputs can be produced
 * @param `injecting` indicates whether still injecting inputs
 * @param `injectCount` number of inputs injected
 * @param `userCancel` indicates whether the user cancelled testing
 * @param `stats` fuzzer stats
 * @returns either the stop reason or percentage complete
 */
const _checkStopCondition = (
  options: FuzzOptions,
  moreInputs: boolean,
  injecting: boolean,
  injectCount: number,
  userCancel: boolean,
  stats: CurrentRunStats,
  gen: boolean
): FuzzStopReason | number => {
  const pcts: number[] = [0];
  const now = performance.now();

  // End testing if the user cancels but not yet if still injecting
  // inputs because if we stop we lose those.
  if (userCancel && !injecting) {
    return FuzzStopReason.PAUSE;
  }

  // End testing if we exceed the suite timeout, which here we measure
  // from the time of the first input generation.
  if (options.suiteTimeout > 0 && stats.timers.startGenTime > 0) {
    if (now - stats.timers.startGenTime >= options.suiteTimeout) {
      return FuzzStopReason.MAXTIME;
    }
    pcts.push((now - stats.timers.startGenTime) / options.suiteTimeout);
  }

  // End testing if we exceed the maximum number of tests
  if (
    stats.counters.inputsInjected +
      (gen
        ? stats.counters.inputsGenerated - stats.counters.dupesGenerated
        : 0) >=
    injectCount + (gen ? options.maxTests : 0)
  ) {
    return FuzzStopReason.MAXTESTS;
  }
  pcts.push(
    (stats.counters.inputsInjected +
      (gen
        ? stats.counters.inputsGenerated - stats.counters.dupesGenerated
        : 0)) /
      (injectCount + (gen ? options.maxTests : 0))
  );

  // End testing if we exceed the maximum number of failures
  /*
  if (options.maxFailures > 0) {
    if (stats.counters.failedTests >= options.maxFailures) {
      return FuzzStopReason.MAXFAILURES;
    }
    pcts.push(stats.counters.failedTests / options.maxFailures);
  }
  */

  // End testing if we exceed the maximum number of sequential duplicates generated
  if (stats.counters.dupesSequential >= options.maxDupeInputs) {
    return FuzzStopReason.MAXDUPES;
  }
  // We don't do a pct because one non-dupe resets this counter

  // End testing if all sources of inputs are exhausted
  if (!moreInputs) {
    return FuzzStopReason.NOMOREINPUTS;
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
 * Returns a list of validator FunctionRefs found within the ProgramDef
 * associated with a FunctionDef
 *
 * @param program the ProgramDef to search
 * @returns an array of validator FunctionRefs
 */
export function getValidators(
  program: ProgramDef,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  const fnUnderTestName = fnUnderTest.getName();
  return Object.values(program.getExportedFunctions())
    .filter(
      (fn) =>
        fn.isValidator() && fn.getValidatorTargetName() === fnUnderTestName
    )
    .map((fn) => fn.getRef());
} // fn: getValidators()

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

  // Setup the Composite Oracle -- we describe this in the TerzoN paper:
  //
  // TerzoN: Human-in-the-Loop Software Testing with a Composite Oracle
  // https://doi.org/10.1145/3580446
  const implicit =
    "passedImplicit" in result
      ? result.passedImplicit
        ? "pass"
        : "fail"
      : "unknown";
  const human =
    "passedHuman" in result
      ? result.passedHuman
        ? "pass"
        : "fail"
      : "unknown";
  const property =
    "passedValidator" in result && result.passedValidator !== undefined
      ? result.passedValidator
        ? "pass"
        : "fail"
      : "unknown";

  switch (CompositeOracle.judge([[property, human], [implicit]])) {
    case "pass":
      return "ok";
    case "fail":
      return getBadValueType(result);
    case "unknown":
      return "disagree";
  }
} // fn: categorizeResult()

/**
 * Gets the input key as a string from an array of `FuzzIoElement`s
 *
 * @param `io` array of `FuzzIoElements`
 * @returns string representation of input key
 */
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
export type FuzzGeneratorStatsBase = {
  counters: {
    inputsGenerated: number; // number of inputs generated, including dupes
    dupesGenerated: number; // number of duplicate inputs generated
  };
  timers: {
    run: number; // elapsed time the PUT ran
    val: number; // elapsed time to categorize outputs
    gen: number; // elapsed time to generate inputs
    measure: number; // elapsed time to measure
  };
};
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
    RandomInputGenerator: FuzzGeneratorStatsBase;
    MutationInputGenerator: FuzzGeneratorStatsBase;
    AiInputGenerator: FuzzGeneratorStatsBase & { gen?: InputGeneratorStatsAi };
  };
  measures: {
    CodeCoverageMeasure?: () => Promise<CodeCoverageMeasureStats>;
  };
};

/**
 * Current run statistics
 */
type CurrentRunStats = {
  counters: {
    inputsInjected: number; // number of inputs injected for testing
    inputsGenerated: number; // number of inputs generated so far
    dupesGenerated: number; // number of duplicate inputs generated so far
    dupesSequential: number; // current number of duplicate inputs generated in a row
    failedTests: number; // number of failed tests so far
    passedTests: number; // number of passed tests so far
  };
  timers: {
    startTime: number; // time the tester started in this run
    startGenTime: number; // time the tester started generating new inputs
  };
};

/**
 * Fuzzer mode
 */
export type FuzzMode = {
  gen?: true;
};

export * from "./analysis/typescript/ProgramDef";
export * from "./analysis/typescript/FunctionDef";
export * from "./analysis/typescript/ArgDef";
export * from "./analysis/typescript/Types";
export * from "./Types";
