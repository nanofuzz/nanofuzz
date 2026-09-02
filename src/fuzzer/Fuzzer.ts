import * as fs from "fs";
import * as JSONN from "../Jsonn";
import { ArgDef } from "./analysis/ArgDef";
import { FunctionRef, ProgramLanguage } from "./analysis/Types";
import { CompositeInputGenerator } from "./generators/CompositeInputGenerator";
import * as CompilerFactory from "./compilers/CompilerFactory";
import * as ProgramFactory from "./analysis/ProgramFactory";
import * as ValueMapper from "./mappers/ValueMapper";
import { FunctionDef } from "./analysis/FunctionDef";
import {
  FuzzIoElement,
  FuzzPinnedTest,
  FuzzTestResult,
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
import { isError } from "./Util";
import { isArgType } from "./analysis/Util";
import { CodeCoverageMeasureStats } from "./measures/AbstractCoverageMeasure";
import { CompositeOracle } from "./oracles/CompositeOracle";
import { ImplicitOracle } from "./oracles/ImplicitOracle";
import { ExampleOracle } from "./oracles/ExampleOracle";
import { PropertyOracle } from "./oracles/PropertyOracle";
import { AbstractProgram } from "./analysis/AbstractProgram";
import { RunnerResult } from "./runners/AbstractRunner";
import { CompilerStaleness } from "./compilers/Types";
import { getToolVersion } from "../ToolVersion";

export class Tester {
  protected _module: string; // module filename
  protected _fnName: string; // function name
  protected _leaderboard = new Leaderboard<InputAndSource>(); // top test results, according to measures
  protected _measures; // set of measures for executions
  protected _allInputs: Map<string, unknown> = new Map(); // language-specific dupe check for input generation
  protected _state: "init" | "ready" | "running" | "paused" | "crashed" =
    "init"; // tester state

  protected _options: FuzzOptions; // testing options
  protected _program: AbstractProgram; // program under test
  protected _function: FunctionDef; // function under test
  protected _compositeInputGenerator: CompositeInputGenerator; // composite input generator
  protected _validators: FunctionRef[] = []; // property validator functions
  protected _transformers: FunctionRef[] = []; // input transformer functions
  protected _lastCompiler?: ReturnType<
    (typeof CompilerFactory)["fromSourcefile"]
  >; // last compiler object used

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
      this._program = ProgramFactory.fromFile(
        this._module,
        undefined,
        options.argDefaults
      );
    } catch (e: unknown) {
      throw new Error(
        `The program could not be parsed. Please fix the errors and retest.${
          isError(e) ? ` (${e.message})` : ``
        }`,
        { cause: e }
      );
    }
    const fnList = this._program.functionsExported;
    if (!(this._fnName in fnList)) {
      throw new Error(
        `Could not find exported function ${this._fnName} in: ${this._module}`
      );
    }
    this._function = fnList[this._fnName];

    // Get the list of property validators
    this._validators = getValidators(this._program, fnList[this._fnName]);

    // Get the list of input transformers
    this._transformers = getTransformers(this._program, fnList[this._fnName]);

    // Options
    if (!isOptionValid(options)) {
      throw new Error(
        `Invalid options provided: ${JSONN.stringify(options, null, 2)}`
      );
    }
    this._options = structuredClone(options);

    // Get the active measures, which will take various measurements
    // during execution that guide the composite generator
    //
    // Note: changes to measures only take effect at the start of testing,
    //       not when testing is paused.
    const optMeasures: Record<string, BaseMeasureConfig> =
      this._options.measures;
    this._measures = MeasureFactory(this._program.lang).filter((m) =>
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
      this._results.stats.generators, // generator stats
      this._allInputs // running list of dupe-checked inputs
    );

    // Start a background compilation if precompile mode is active
    // and this is a compiled language.
    if (mode.precompile) {
      CompilerFactory.fromSourcefile(module)?.compileAsync(module);
    }
  } // constructor

  /**
   * Returns `true` if the tester is out-of-date or crashed
   *
   * @param options FuzzOptions
   * @returns a reason code if the tester is out-of-date or crashed and `false` otherwise.
   */
  public isStale(
    options: FuzzOptions
  ): CompilerStaleness | "optionschanged" | "crashed" {
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
      JSONN.stringify(retestRelevantOptions(options)) !==
      JSONN.stringify(retestRelevantOptions(this._options))
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
      toolVersion: getToolVersion(),
      env: {
        options: structuredClone(this._options),
        function: this._function,
        validators: structuredClone(this._validators),
        transformers: getTransformers(this._program, this._function),
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
          transform: 0, // updated later
        },
        counters: {
          testingRuns: 0, // updated later
          inputsGenerated: 0, // updated later
          dupesGenerated: 0, // updated later
          inputsInjected: 0, // updated later
          passedTests: 0, // updated later
          erroredTests: 0, // updated later
          inputsSkipped: 0, // updated later
          failedTests: 0, // updated later
        },
        generators: {
          RandomInputGenerator: {
            timers: {
              gen: 0, // updated below
              run: 0, // updated later
              val: 0, // updated later
              measure: 0, // updated later
              transform: 0, // updated later
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
              transform: 0, // updated later
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
              transform: 0, // updated later
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
        `Invalid options provided: ${JSONN.stringify(options, null, 2)}`
      );
    }

    // If we already have an option set and it differs
    // from the new one, use the new options.
    if (JSONN.stringify(this._options) !== JSONN.stringify(options)) {
      this._options = structuredClone(options);
      this._results.env.options = structuredClone(options);
      this._compositeInputGenerator.options = this._options.generators;
    }
  } // property: set options

  /**
   * Returns the current `FuzzEnv`
   * (Retained for prior compatibility.... should probably go away !!!!!!!)
   */
  public get env(): FuzzEnv {
    return {
      options: structuredClone(this._options),
      function: this._function,
      validators: structuredClone(this._validators),
      transformers: structuredClone(this._transformers),
    };
  } // property: get env

  /**
   * Returns the current state
   */
  public get state(): typeof this._state {
    return this._state;
  } // property: get state

  /**
   * Runs the tester and returns its results.
   *
   * @param `injectTests` tests to inject
   * @param `mode` testing mode
   * @returns `FuzzTestResults`
   */
  public async testSync(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
    updateFn?: (payload: FuzzBusyStatusMessage) => void,
    cancelFn?: () => boolean
  ): Promise<FuzzTestResults> {
    let result: FuzzTestResults | undefined;
    try {
      const run = this._run(injectTests, mode, updateFn, cancelFn);
      while (!result) {
        result = (await run.next()).value;
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
  protected async _runBatchAsync(
    callbackFn: (result: FuzzTestResults | Error) => void,
    run: ReturnType<typeof this._run>
  ): Promise<void> {
    let result: FuzzTestResults | undefined;
    const timer = performance.now();

    while (!result && performance.now() - timer < 100) {
      try {
        result = (await run.next()).value;
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
            : { name: "unknown error", message: JSONN.stringify(e) }
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
  protected async *_run(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
    updateFn?: (payload: FuzzBusyStatusMessage) => void,
    cancelFn?: () => boolean
  ): AsyncGenerator<
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
        updateFn({ ...payload });
      } else if (payload.channel !== "update") {
        console.log(payload.msg);
      }
    };
    const runStats: CurrentRunStats = {
      counters: {
        inputsInjected: 0, // number of inputs injected for testing
        inputsGenerated: 0, // number of inputs generated so far
        dupesGenerated: 0, // number of duplicate inputs generated so far
        dupesSequential: 0, // current number of duplicate inputs generated in a row
        erroredTests: 0, // number of tests with internal errors so far
        failedTests: 0, // number of failed tests encountered so far
        passedTests: 0, // number of passed tests encountered so far
        inputsSkipped: 0, // number of skipped tests so far
      },
      timers: {
        startTime: performance.now(), // time the tester started in this run
        startGenTime: 0, // time the tester started generating inputs in this run
      },
    };

    if (!updateFn && process.env.BUILD_TARGET !== "node-cli")
      console.log("\r\n\r\n");
    update({
      msg: `Target: ${this._function.getName()} of ${this._function.getModule()}`,
      channel: "milestone",
    });

    const argDefs = this._function.getArgDefs();
    const lang = this._function.getLang();

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
    this._lastCompiler = CompilerFactory.fromSourcefile(fqSrcFile);
    const mod = this._lastCompiler
      ? this._lastCompiler.compileSync(this._measures, update) // native ts
      : fqSrcFile; // something other than native ts
    this._results.stats.timers.compile = performance.now() - startCompTime;

    // Build a test runner for executing tests
    const runner = RunnerFactory(this.env, mod, this._function.getName());
    await runner.onRunStart();

    // Build a test runner for executing transformers, if any are present and enabled
    let transformRunner: ReturnType<typeof RunnerFactory> | undefined;
    if (this.env.options.useTransformer && this.env.transformers.length) {
      transformRunner = RunnerFactory(
        this.env,
        mod,
        this.env.transformers[0].name
      );
      await transformRunner.onRunStart();
    }

    // Connect the measures to the runner. Measures that source their data
    // from the runner (e.g., Python coverage) need it before the first test.
    this._measures.forEach((m) => {
      m.onRunStart(runner);
    });

    // Build runners for the property validators
    const propRunners = this._validators.map((vFnRef) =>
      RunnerFactory(this.env, mod, vFnRef.name)
    );
    propRunners.forEach(async (p) => await p.onRunStart());
    const propertyOracle = new PropertyOracle(propRunners);

    // Are we currently injecting inputs?
    let stillInjecting = !!injectTests.length;

    update({ msg: `Target ready to test.`, channel: "milestone" });
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
        this._results.stats.counters.erroredTests +=
          runStats.counters.erroredTests;
        this._results.stats.counters.passedTests +=
          runStats.counters.passedTests;
        this._results.stats.counters.inputsSkipped +=
          runStats.counters.inputsSkipped;
        this._results.stats.counters.failedTests +=
          runStats.counters.failedTests;

        // Update interesting inputs
        this._results.interesting.inputs =
          this._compositeInputGenerator.getInterestingInputs();

        // End-of-run processing for measures and input generators
        this._measures.forEach((e) => {
          e.onRunEnd(this._results);
        });
        await this._compositeInputGenerator.onRunEnd(this._results); // also handles shutdown for subgens

        // Shut down runners
        await Promise.all(
          [
            runner.onRunEnd(),
            transformRunner?.onRunEnd(),
            ...propRunners.map((p) => p.onRunEnd()),
          ].filter((e) => e !== undefined)
        );

        update({
          msg: `Testing ${cancelFn && cancelFn() ? "interrupted" : "finished"}.`,
          channel: "update",
          pct: 100,
        });
        update({
          msg: ` - Executed ${
            runStats.counters.passedTests +
            runStats.counters.failedTests +
            runStats.counters.erroredTests
          } and skipped ${runStats.counters.inputsSkipped} tests in ${(
            performance.now() - runStats.timers.startTime
          ).toFixed(
            0
          )} ms this run. Stopped for reason: ${this._results.stopReason}.`,
          channel: "summary",
        });
        update({
          msg: ` - Injected ${runStats.counters.inputsInjected} and generated ${runStats.counters.inputsGenerated} inputs (${runStats.counters.dupesGenerated} were dupes) this run.`,
          channel: "summary",
        });
        update({
          msg: ` - Total tests with exceptions: ${
            this._results.results.filter((e) => e.exception).length
          }, timeouts: ${this._results.results.filter((e) => e.timeout).length}, errors: ${this._results.stats.counters.erroredTests}`,
          channel: "summary",
        });
        update({
          msg: ` - Total tests where human validator passed: ${
            this._results.results.filter((e) => e.passedHuman === "pass").length
          }, failed: ${
            this._results.results.filter((e) => e.passedHuman === "fail").length
          }`,
          channel: "summary",
        });
        update({
          msg: ` - Total tests where property validator passed: ${
            this._results.results.filter((e) => e.passedValidator === "pass")
              .length
          }, failed: ${
            this._results.results.filter((e) => e.passedValidator === "fail")
              .length
          }`,
          channel: "summary",
        });
        update({
          msg: ` - Total tests where heuristic validator passed: ${
            this._results.results.filter((e) => e.passedImplicit === "pass")
              .length
          }, failed: ${
            this._results.results.filter((e) => e.passedImplicit === "fail")
              .length
          }`,
          channel: "summary",
        });

        // Persist to outfile, if requested
        if (this._options.outputFile) {
          fs.writeFileSync(
            this._options.outputFile,
            JSONN.stringify(this._results)
          );
          update({
            msg: ` - Test results: ${this._options.outputFile}`,
            channel: "summary",
          });
        }

        update({
          msg: `Testing ${cancelFn && cancelFn() ? "interrupted" : "finished"}.`,
          channel: "milestone",
        });

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
        inputGenerated: {
          tick: 0,
          value: [],
          source: { type: "unknown" },
        },
        input: [],
        output: [],
        exception: false,
        validatorException: false,
        timeout: false,
        skipped: false,
        passedImplicit: "unknown",
        passedHuman: "unknown",
        passedValidator: "unknown",
        passedValidators: [],
        timers: {
          run: 0,
          gen: 0,
          transform: 0,
        },
        category: "ok",
        interestingReasons: [],
      };

      // Generate and store the inputs
      const startGenTime = performance.now(); // start time: input generation
      result.inputGenerated = this._compositeInputGenerator.next();
      result.timers.gen = performance.now() - startGenTime; // total time: input generation

      // Map the generated inputs to the result object
      // (the transformer might modify these)
      result.input = result.inputGenerated.value.map((e, i) => {
        return {
          name: argDefs[i]?.getName() ?? "?",
          offset: i,
          value: e.value,
          origin: result.inputGenerated.source,
        };
      });

      // Apply input transformers to generated inputs (before dedup)
      const startTransformTime = performance.now(); // start time: input transformation
      if (!result.inputGenerated.injected && transformRunner) {
        const transformerResult = await transformRunner.run(
          structuredClone(result.inputGenerated.value.map((e) => e.value)),
          Math.max(this._options.fnTimeout, 1)
        );

        // If transformer returns null, then input was rejected so skip this input
        switch (transformerResult.result.tag) {
          case "skip":
            result.skipped = true;
            result.skipReason = `(${transformRunner.name}) ${transformerResult.result.message}`;
            break;
          case "timeout":
            result.validatorException = true;
            result.validatorExceptionFunction = transformRunner.name;
            result.validatorExceptionMessage = `timeout`;
            break;
          case "error":
            // TODO: These need their own place in the results
            result.validatorException = true;
            result.validatorExceptionFunction = transformRunner.name;
            result.validatorExceptionMessage = transformerResult.result.message;
            break;
          case "value": {
            const values = transformerResult.result.value;
            if (Array.isArray(values)) {
              result.inputGenerated.value.forEach((e, i) => {
                if (i < values.length) {
                  const oldValue = result.input[i].value;
                  const newValue = values[i];
                  result.input[i].value = newValue;

                  if (JSONN.stringify(oldValue) !== JSONN.stringify(newValue)) {
                    result.input[i].origin = {
                      type: "transformer",
                      transformer: transformRunner.name,
                      basis: {
                        value: structuredClone(result.inputGenerated.value),
                        source: structuredClone(result.inputGenerated.source),
                      },
                    };
                  }
                }
              });
            } else {
              // TODO: These need their own place in the results (see above)
              result.validatorException = true;
              result.validatorExceptionFunction = transformRunner.name;
              result.validatorExceptionMessage = `Transformer returned non-array value: ${JSONN.stringify(transformerResult.result.value)}`;
              break;
            }
          }
        }
      }
      result.timers.transform = performance.now() - startTransformTime; // total time: input transformation

      // Pointer to generator stats for this input, if not injected
      let genStats:
        | FuzzTestStats["generators"]["RandomInputGenerator"]
        | undefined = undefined;

      // Handle injected and generated tests differently, e.g.,
      // we need to retain any saved details for injected tests.
      if (result.inputGenerated.injected) {
        // Ensure the injected inputs are in the expected order
        const expectedInput = JSONN.stringify(
          injectTests[runStats.counters.inputsInjected].input.map(
            (i) => i.value
          )
        );
        const returnedInput = JSONN.stringify(result.input.map((i) => i.value));
        if (expectedInput !== returnedInput) {
          throw new Error(
            `Injected inputs in unexpected order at injected input# ${runStats.counters.inputsInjected}. Expected: "${expectedInput}". Got: "${returnedInput}".` +
              JSONN.stringify(injectTests, null, 3)
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
        if (result.inputGenerated.source.type === "generator") {
          // Add generation times to the generator stats
          genStats =
            this._results.stats.generators[
              result.inputGenerated.source.generator
            ];
          genStats.timers.gen += result.timers.gen;
          this._results.stats.timers.gen += result.timers.gen;

          // Add transform times to the stats
          genStats.timers.transform += result.timers.transform;
          this._results.stats.timers.transform += result.timers.transform;

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

      // If the function accepts inputs, check if the input is a dupe
      if (this._function.getArgDefs().length) {
        // Skip tests if we previously processed the input
        // Note the our hash value is language specific
        const inputHash = getLangIoKey(lang, result.input);
        if (this._allInputs.has(inputHash)) {
          runStats.counters.dupesSequential++; // increment the sequential dupe counter
          runStats.counters.dupesGenerated++; // incremement the total run dupe counter
          this._compositeInputGenerator.onInputFeedback([], result.timers.gen); // return empty input generator feedback
          if (genStats) {
            genStats.counters.dupesGenerated++; // increment the generator's dupe counter
          }
          continue; // skip this test
        } else {
          runStats.counters.dupesSequential = 0; // reset the sequential duplicate count
          this._allInputs.set(inputHash, true);
        }
      }

      // Front-end status update
      update({
        msg: `${cancelFn && cancelFn() && stillInjecting ? "Interrupt pending retest of prior inputs.\r\n" : ""}${stillInjecting ? "Retesting prior" : "Testing new"} example# ${
          runStats.counters.passedTests +
          runStats.counters.failedTests +
          runStats.counters.erroredTests +
          1
        }: ${this._function.getName()}(${result.input
          .map((i) => ValueMapper.toLang(lang, i.value))
          .join(
            ","
          )})\r\n  Passed: ${runStats.counters.passedTests}${`\r\n  Failed: ${runStats.counters.failedTests}`}${
          runStats.counters.erroredTests
            ? `\r\n Errored: ${runStats.counters.erroredTests}`
            : ""
        }${
          runStats.counters.inputsSkipped
            ? `\r\n Skipped: ${runStats.counters.inputsSkipped}`
            : ""
        }`,
        channel: "update",
        pct: typeof stopCondition === "number" ? stopCondition : 100,
      });

      // Call the PUT via its runner
      if (!result.skipped && !result.validatorException) {
        const startRunTime = performance.now(); // start timer
        let exeOutput: RunnerResult;
        try {
          exeOutput = await runner.run(
            structuredClone(result.input.map((e) => e.value)),
            Math.max(this._options.fnTimeout, 1)
          );
        } catch (e: unknown) {
          if (isError(e)) {
            exeOutput = {
              result: {
                tag: "error",
                name: e.name,
                message: e.message,
                stack: e.stack ?? "<no stack>",
                seq: -1,
              },
              env: {},
            };
          } else {
            exeOutput = {
              result: {
                tag: "error",
                name: "unknown internal runner error",
                message: "unknown",
                stack: "<no stack>",
                seq: -1,
              },
              env: {},
            };
          }
        }
        result.timers.run = performance.now() - startRunTime; // stop timer
        switch (exeOutput.result.tag) {
          case "value":
            result.output.push({
              name: "0",
              offset: 0,
              value: isArgType(exeOutput.result.value)
                ? exeOutput.result.value
                : undefined,
              origin: { type: "put" },
            });
            break;
          case "error":
            result.exception = true;
            result.exceptionMessage = exeOutput.result.message;
            result.stack = exeOutput.result.stack;
            break;
          case "timeout":
            result.timeout = true;
            break;
          case "skip":
            result.skipped = true;
            result.skipReason = exeOutput.result.message;
            break;
        }

        this._results.stats.timers.put += result.timers.run;
        if (genStats) {
          genStats.timers.run += result.timers.run;
        }

        const startValTime = performance.now(); // start timer
        if (!result.skipped) {
          // IMPLICIT ORACLE --------------------------------------------
          if (this._options.useImplicit) {
            result.passedImplicit = ImplicitOracle.judge(
              result.timeout,
              result.exception,
              this._function.isVoid(),
              result.output
            );
          }

          // EXAMPLE ORACLE ---------------------------------------------
          // If a human annotated an expected output, then check it
          if (this._options.useHuman && result.expectedOutput) {
            result.passedHuman = ExampleOracle.judge(
              result.timeout,
              result.exception,
              result.expectedOutput,
              result.output
            );
          }

          // PROPERTY ORACLE --------------------------------------------
          // If a property validator is selected, call it to evaluate the result
          if (this._options.useProperty) {
            (
              await propertyOracle.judge(
                Object.freeze({
                  in: result.input.map((i) => i.value), // inputs
                  out:
                    result.output.length === 0
                      ? "timeout or exception"
                      : result.output[0].value,
                  exception: result.exception,
                  timeout: result.timeout,
                }),
                Math.max(this._options.fnTimeout, 1)
              )
            ).forEach((j, i) => {
              if (isError(j)) {
                result.passedValidators.push("unknown");
                result.validatorException = true;
                result.validatorExceptionMessage = j.message;
                result.validatorExceptionFunction = this._validators[i].name;
                result.validatorExceptionStack = j.stack;
              } else {
                result.passedValidators.push(j);
              }
            });

            // Summarize propert judgments.
            result.passedValidator = PropertyOracle.summarize(
              result.passedValidators
            );
          } // if validator
        }

        // Validator stats
        const valTime = performance.now() - startValTime; // stop timer
        this._results.stats.timers.val += valTime;
        if (genStats) {
          genStats.timers.val += valTime;
        }
      }

      // (Re-)categorize the result
      result.category = categorizeResult(result);

      // Increment the test counters
      switch (result.category) {
        case "ok":
          runStats.counters.passedTests++;
          break;
        case "skip":
          runStats.counters.inputsSkipped++;
          break;
        case "failure":
        case "disagree":
          runStats.counters.erroredTests++;
          break;
        case "badValue":
        case "timeout":
        case "exception":
          runStats.counters.failedTests++;
          break;
      }

      // Store the result for this iteration
      this._results.results.push(result);

      // Take measurements for this test run
      {
        const startMeasureTime = performance.now(); // start timer
        const measurements = this._measures.map((e) =>
          e.measure(
            structuredClone(result.inputGenerated),
            structuredClone(result)
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
        ? stats.counters.inputsGenerated -
          stats.counters.dupesGenerated -
          stats.counters.inputsSkipped
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

  // End testing if we exceed the maximum number of failures & are done injecting inputs
  if (options.maxFailures > 0 && !injecting) {
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
 * Returns a list of validator FunctionRefs found within the ProgramDef
 * associated with a FunctionDef
 *
 * @param program the ProgramDef to search
 * @returns an array of validator FunctionRefs
 */
export function getValidators(
  program: AbstractProgram,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  const fnUnderTestName = fnUnderTest.getName();
  return Object.values(program.functionsExported)
    .filter(
      (fn) =>
        fn.isValidator() && fn.getValidatorTargetName() === fnUnderTestName
    )
    .map((fn) => fn.getRef());
} // fn: getValidators()

/**
 * Returns a list of input transformer functions for the function under test.
 *
 * @param program the program to search
 * @param fnUnderTest the function under test
 * @returns an array of transformer FunctionRefs
 */
export function getTransformers(
  program: AbstractProgram,
  fnUnderTest: FunctionDef
): FunctionRef[] {
  return Object.values(program.functionsExported)
    .filter(
      (fn) =>
        fn.isTransformer() && fn.getName().startsWith(fnUnderTest.getName())
    )
    .map((fn) => fn.getRef());
} // fn: getTransformers()

/**
 * Categorizes the result of a fuzz test according to the available
 * categories defined in ResultType.
 * @param result of the test
 * @returns the category of the result
 */
export function categorizeResult(result: FuzzTestResult): FuzzResultCategory {
  if (result.validatorException) {
    return "failure"; // Validator or transformer failed
  }
  if (result.skipped) {
    return "skip";
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

  // Use the Composite Oracle to render a single judgment from among
  // the various oracles. We describe this in the TerzoN paper:
  //
  // TerzoN: Human-in-the-Loop Software Testing with a Composite Oracle
  // https://doi.org/10.1145/3580446
  //
  // Subsequently, map the judgment to a FuzzResultCategory
  switch (
    CompositeOracle.judge([
      [result.passedValidator, result.passedHuman],
      [result.passedImplicit],
    ])
  ) {
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
  return JSONN.stringify(
    io.map((input) => {
      return { value: input.value };
    })
  );
} // fn: getIoKey

/**
 * Gets the langiage-specific input key as a string from an array of `FuzzIoElement`s
 *
 * @param `lang` programming language
 * @param `io` array of `FuzzIoElements`
 * @returns string representation array of inputs in `lang` format
 */
export function getLangIoKey(
  lang: ProgramLanguage,
  io: FuzzIoElement[]
): string {
  return ValueMapper.toLang(
    lang,
    io.map((i) => i.value)
  );
} // fn: getLangIoKey

/**
 * Fuzzer Environment required to fuzz a function.
 */
export type FuzzEnv = {
  options: FuzzOptions; // fuzzer options
  function: FunctionDef; // the function to fuzz
  validators: FunctionRef[]; // list of the module's validator functions
  transformers: FunctionRef[]; // list of the module's input transformer functions
};

/**
 * Fuzzer Test Result
 */
export type FuzzTestResults = {
  toolVersion: string; // NaNofuzz name and version that generated the results
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
    transform: number; // elapsed time to transform inputs
  };
};
export type FuzzTestStats = {
  timers: {
    total: number; // elapsed time the fuzzer ran
    compile: number; // elapsed time to compile & instrument PUT
    put: number; // elapsed time the PUT ran
    val: number; // elapsed time to categorize outputs
    gen: number; // elapsed time to generate inputs
    transform: number; // elapsed time to transform inputs
    measure: number; // elapsed time to measure
  };
  counters: {
    testingRuns: number; // number of test runs
    inputsGenerated: number; // number of inputs generated, including dupes
    dupesGenerated: number; // number of duplicate inputs generated
    inputsInjected: number; // number of inputs pinned
    erroredTests: number; // number of tests with internal errors
    passedTests: number; // number of passed tests
    inputsSkipped: number; // number of skipped tests
    failedTests: number; // number of failed tests
  };
  generators: {
    RandomInputGenerator: FuzzGeneratorStatsBase;
    MutationInputGenerator: FuzzGeneratorStatsBase;
    AiInputGenerator: FuzzGeneratorStatsBase & { gen?: InputGeneratorStatsAi };
    CompositeInputGenerator?: {
      config?: {
        lookbackWindow: number;
        chunkSize: number;
        explorationChance: number;
        initialFocus: number;
        focusDecay: number;
      };
      checkpoints: {
        tick: number; // tick of the checkpoint
        gens: Record<
          string,
          {
            active: boolean; // subgen is active
            nextable: boolean; // subgen is active and nextable
            productivity: number; // current productivity[g] for this input generator
            cost: number; // current cost[g] for this input generator
          }
        >;
      }[];
    };
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
    erroredTests: number; // number of tests with internal errors so far
    failedTests: number; // number of failed tests so far
    passedTests: number; // number of passed tests so far
    inputsSkipped: number; // number of skipped tests so far
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

export * from "./analysis/typescript/TypescriptProgram";
export * from "./analysis/FunctionDef";
export * from "./analysis/ArgDef";
export * from "./analysis/Types";
export * from "./Types";
