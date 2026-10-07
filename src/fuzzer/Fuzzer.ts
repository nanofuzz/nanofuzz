import * as fs from "fs";
import * as Config from "../Config";
import * as JSONN from "../Jsonn";
import { deepFreeze } from "../Util";
import { ArgDef } from "./analysis/ArgDef";
import { FunctionRef } from "./analysis/Types";
import { CompositeInputGenerator } from "./generators/CompositeInputGenerator";
import * as CompilerFactory from "./compilers/CompilerFactory";
import { Instrumenter } from "./compilers/Instrumenter";
import * as ProgramFactory from "./analysis/ProgramFactory";
import { FunctionDef } from "./analysis/FunctionDef";
import {
  FuzzPinnedTest,
  FuzzTestResult,
  FuzzResultCategoryValues,
  FuzzStopReason,
  FuzzStatusUpdater,
  FuzzResultCallback,
  BaseMeasureConfig,
  FuzzerFocus,
  TransformedInputAndSource,
  InputAndSource,
  FuzzOptions,
  FuzzEnv,
  FuzzMode,
  FuzzTestResults,
  FuzzTestStats,
  CurrentRunStats,
} from "./Types";
import { MeasureFactory } from "./measures/MeasureFactory";
import { RunnerFactory } from "./runners/RunnerFactory";
import { Leaderboard } from "./generators/Leaderboard";
import { categorizeResult, getIoKey, isError, isSameJudgments } from "./Util";
import {
  getTransformers,
  getValidators,
  isArgValueType,
  isOptionValid,
} from "./analysis/Util";
import { ImplicitOracle } from "./oracles/ImplicitOracle";
import { ExampleOracle } from "./oracles/ExampleOracle";
import { PropertyOracle } from "./oracles/PropertyOracle";
import { Judgment } from "./oracles/Types";
import { AbstractProgram } from "./analysis/AbstractProgram";
import { AbstractRunner, RunnerResult } from "./runners/AbstractRunner";
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

  protected _fuzzerFocus: FuzzerFocus = deepFreeze({ mode: "gen" });
  protected _failingResultToShrink?: FuzzTestResult;
  protected _shrinkStartTime = 0;
  protected _savedGeneratorOptions?: FuzzOptions["generators"];
  protected getFuzzerFocus(): FuzzerFocus {
    return this._fuzzerFocus;
  }

  constructor(
    module: string,
    fnName: string,
    options: FuzzOptions,
    mode: { precompile?: true } = {}
  ) {
    this._module = require.resolve(module);
    this._fnName = fnName;

    const normalizedOptions: FuzzOptions = {
      ...options,
      argDefaults: ArgDef.normalizeOptions(options?.argDefaults),
    };

    // Get the program & function definitions
    try {
      this._program = ProgramFactory.fromFile(
        this._module,
        undefined,
        normalizedOptions.argDefaults
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
      if (this._fnName in this._program.functionsNotSupported) {
        const reason = this._program.functionsNotSupported[this._fnName].reason;
        throw new Error(
          `Function ${this._fnName} in ${this._module} is not supported for reason: ${reason}`
        );
      }
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
    if (!isOptionValid(normalizedOptions)) {
      throw new Error(
        `Invalid options provided: ${JSONN.stringify(normalizedOptions, null, 2)}`
      );
    }
    this._options = structuredClone(normalizedOptions);

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
      this._allInputs, // running list of dupe-checked inputs
      this._program.src, // enclosing module source code
      this.getFuzzerFocus.bind(this)
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
          instrument: 0, // updated later
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
        outcomes: {
          total: 0,
          exceptions: 0,
          timeouts: 0,
          categories: {
            ok: 0,
            badValue: 0,
            timeout: 0,
            exception: 0,
            skip: 0,
            disagree: 0,
            failure: 0,
          },
          oracles: {
            heuristic: { pass: 0, fail: 0, unknown: 0 },
            human: { pass: 0, fail: 0, unknown: 0 },
            property: { pass: 0, fail: 0, unknown: 0 },
          },
          firstFailure: undefined,
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
              dupeTicks: [],
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
              dupeTicks: [],
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
              dupeTicks: [],
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
    const normalizedOptions: FuzzOptions = {
      ...options,
      argDefaults: ArgDef.normalizeOptions(options?.argDefaults),
    };

    // Ensure we have a valid set of Fuzz options
    if (!isOptionValid(normalizedOptions)) {
      throw new Error(
        `Invalid options provided: ${JSONN.stringify(normalizedOptions, null, 2)}`
      );
    }

    // If we already have an option set and it differs
    // from the new one, use the new options.
    if (JSONN.stringify(this._options) !== JSONN.stringify(normalizedOptions)) {
      this._options = structuredClone(normalizedOptions);
      this._results.env.options = structuredClone(normalizedOptions);
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
   * Returns the active worker count.
   */
  public get workerCount(): number {
    return 1;
  } // get: workerCount

  /**
   * Runs the tester and returns its results.
   *
   * @param `injectTests` tests to inject
   * @param `mode` testing mode
   * @param `updateFn` status update callback
   * @param `cancelFn` cancel checking callback
   * @param `onResultFn` callback called for each test result produced
   * @returns `FuzzTestResults`
   */
  public async test(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
    updateFn?: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<FuzzTestResults> {
    let result: FuzzTestResults | undefined;
    try {
      const run = this._run(injectTests, mode, updateFn, cancelFn, onResultFn);
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
  } // fn: test

  /**
   * Generates and returns new test results
   *
   * @param `injectTests` tests to inject
   * @param `mode` tester mode
   * @param `updateFn` called to report status updates
   * @param `cancelFn` called to check cancel status
   * @param `onResultFn` called for each test result produced
   * @returns test results
   */
  protected async *_run(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
    updateFn?: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
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

    let lastUpdateTimestamp = 0;
    let periodicTimer: ReturnType<typeof setInterval> | undefined = undefined;

    const update: FuzzStatusUpdater = (payload) => {
      lastUpdateTimestamp = performance.now();
      if (payload.type === "testing-complete" && periodicTimer !== undefined) {
        clearInterval(periodicTimer);
        periodicTimer = undefined;
      }
      if (updateFn) {
        updateFn({ ...payload });
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
      outcomes: {
        total: 0,
        exceptions: 0,
        timeouts: 0,
        categories: {
          ok: 0,
          badValue: 0,
          timeout: 0,
          exception: 0,
          skip: 0,
          disagree: 0,
          failure: 0,
        },
        oracles: {
          heuristic: { pass: 0, fail: 0, unknown: 0 },
          human: { pass: 0, fail: 0, unknown: 0 },
          property: { pass: 0, fail: 0, unknown: 0 },
        },
        firstFailure: undefined,
      },
      timers: {
        startTime: performance.now(), // time the tester started in this run
        startGenTime: 0, // time the tester started generating inputs in this run
      },
    };

    const argDefs = this._function.getArgDefs();

    // Only generate new inputs if running in input generation mode
    if (mode.gen) {
      this._compositeInputGenerator.permitGenerators();
    } else {
      this._compositeInputGenerator.suppressGenerators();
    }

    // Compile the target, if required (currently only Typescript)
    const fqSrcFile = fs.realpathSync(this._function.getModule()); // Help the module loader
    const startCompTime = performance.now(); // start time: compile & instrument
    this._lastCompiler = CompilerFactory.fromSourcefile(fqSrcFile);
    const mod = this._lastCompiler
      ? this._lastCompiler.compileSync(update) // native ts
      : fqSrcFile; // something other than native ts
    this._results.stats.timers.compile = performance.now() - startCompTime;

    // Instrument the target, if required (currently only Typescript)
    // Note: Python is currently instrumented in PythonRunnerHost
    // Assumes: put, transformers, & validators are in the same module
    const instrumentTime = performance.now(); // start time: instrument
    const targetMod = this._lastCompiler
      ? Instrumenter.prepareInstrumentedTree(
          mod,
          this._lastCompiler.getCompiledDependencies(),
          this._measures,
          this._lastCompiler.options.tmpDir,
          updateFn
        )
      : mod;
    this._results.stats.timers.instrument = performance.now() - instrumentTime;

    // Build a test runner for executing tests
    const runner = RunnerFactory(this.env, targetMod, this._function.getName());
    await runner.onRunStart();

    // Build a test runner for executing transformers, if any are present and enabled
    // Assumed: transforers are in the same module
    let transformRunner: ReturnType<typeof RunnerFactory> | undefined;
    if (this.env.options.useTransformer && this.env.transformers.length) {
      transformRunner = RunnerFactory(
        this.env,
        targetMod,
        this.env.transformers[0].name
      );
      await transformRunner.onRunStart();
    }

    // Indicate the start of the run for the composite input generator
    this._compositeInputGenerator.onRunStart(
      !!mode.gen,
      injectTests,
      transformRunner,
      this._options.fnTimeout,
      this._options.maxDupeInputs
    );

    // Build runners for the property validators
    // Assumed: property validators are in the same module
    const propRunners = this._validators.map((vFnRef) =>
      RunnerFactory(this.env, targetMod, vFnRef.name)
    );
    await Promise.all(propRunners.map((p) => p.onRunStart()));
    const propertyOracle = new PropertyOracle(propRunners);

    // Connect the measures to the runners. Measures that source their data
    // from runners (e.g., Python or TypeScript coverage) need them before the first test.
    const runners = [runner, transformRunner, ...propRunners].filter(
      (r): r is AbstractRunner => r !== undefined
    );
    this._measures.forEach((m) => {
      m.onRunStart(runners, this.env);
    });

    // Injected tests lookup map
    const injectMap = new Map(injectTests.map((t) => [getIoKey(t.input), t]));

    // Are we currently injecting inputs?
    let stillInjecting = !!injectTests.length;
    this._state = "ready";
    lastUpdateTimestamp = performance.now();

    const checkPeriodicUpdate = () => {
      if (
        this._state === "running" &&
        performance.now() - lastUpdateTimestamp >= 100
      ) {
        runStats.counters.inputsGenerated =
          this._compositeInputGenerator.inputsGenerated;
        runStats.counters.dupesGenerated =
          this._compositeInputGenerator.dupesGenerated;
        runStats.counters.dupesSequential =
          this._compositeInputGenerator.dupesSequential;

        const stopCondition = _checkStopCondition(
          this._options,
          this._compositeInputGenerator.nextable() !== false,
          stillInjecting,
          injectTests.length,
          !!cancelFn && cancelFn(),
          runStats,
          !!mode.gen,
          this._fuzzerFocus.mode
        );
        const pct = typeof stopCondition === "number" ? stopCondition : 100;
        update({
          type: "progress-tick",
          pct,
        });
      }
    };

    periodicTimer = setInterval(checkPeriodicUpdate, 50);

    try {
      // Main test loop
      while (true) {
        this._state = "running";
        checkPeriodicUpdate();
        runStats.counters.inputsGenerated =
          this._compositeInputGenerator.inputsGenerated;
        runStats.counters.dupesGenerated =
          this._compositeInputGenerator.dupesGenerated;
        runStats.counters.dupesSequential =
          this._compositeInputGenerator.dupesSequential;

        // End the testing run when we encounter a stop condition
        const stopCondition = _checkStopCondition(
          this._options,
          this._compositeInputGenerator.nextable() !== false,
          stillInjecting,
          injectTests.length,
          !!cancelFn && cancelFn(),
          runStats,
          !!mode.gen,
          this._fuzzerFocus.mode
        );
        if (typeof stopCondition !== "number") {
          if (this._fuzzerFocus.mode === "shrink") {
            this._fuzzerFocus = deepFreeze({ mode: "gen" });
            if (this._savedGeneratorOptions) {
              this._compositeInputGenerator.options =
                this._savedGeneratorOptions;
            }
            continue;
          }
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

          this._results.stats.outcomes.total += runStats.outcomes.total;
          this._results.stats.outcomes.exceptions +=
            runStats.outcomes.exceptions;
          this._results.stats.outcomes.timeouts += runStats.outcomes.timeouts;
          for (const cat of FuzzResultCategoryValues) {
            this._results.stats.outcomes.categories[cat] +=
              runStats.outcomes.categories[cat];
          }
          for (const j of ["pass", "fail", "unknown"] as const) {
            this._results.stats.outcomes.oracles.heuristic[j] +=
              runStats.outcomes.oracles.heuristic[j];
            this._results.stats.outcomes.oracles.human[j] +=
              runStats.outcomes.oracles.human[j];
            this._results.stats.outcomes.oracles.property[j] +=
              runStats.outcomes.oracles.property[j];
          }
          if (
            !this._results.stats.outcomes.firstFailure &&
            runStats.outcomes.firstFailure
          ) {
            this._results.stats.outcomes.firstFailure =
              runStats.outcomes.firstFailure;
          }

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
            type: "testing-complete",
            cancelled: Boolean(cancelFn && cancelFn()),
            pct: 100,
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
          harnessErrors: [],
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

        // Prepare measures for next test execution (before transformers & runners execute)
        {
          const startMeasTime = performance.now();
          this._measures.forEach((m) => {
            m.onBeforeNextTestExecution();
          });
          const measureTime = performance.now() - startMeasTime;
          this._results.stats.timers.measure += measureTime;
        }

        // Generate and store the inputs
        const startGenTime = performance.now(); // start time: input generation
        if (!stillInjecting && runStats.timers.startGenTime === 0) {
          runStats.timers.startGenTime = startGenTime;
        }

        if (this._compositeInputGenerator.nextable() === "soon") {
          const remainingTimeout =
            this._options.suiteTimeout > 0 && runStats.timers.startGenTime > 0
              ? Math.max(
                  0,
                  this._options.suiteTimeout -
                    (performance.now() - runStats.timers.startGenTime)
                )
              : undefined;
          update({
            type: "waiting-for-generator",
            pendingGenerators:
              this._compositeInputGenerator.getPendingGeneratorNames(),
            stats: runStats,
            pct: typeof stopCondition === "number" ? stopCondition : 0,
          });
          await this._compositeInputGenerator.waitForNextInput(
            remainingTimeout
          );
        }

        if (
          this._compositeInputGenerator.nextable() !== "now" &&
          this._compositeInputGenerator.nextable() !== "now!" &&
          !stillInjecting
        ) {
          continue;
        }

        const getRemainingSuiteTime = (): number => {
          const timeSinceGenStart =
            runStats.timers.startGenTime > 0
              ? performance.now() - runStats.timers.startGenTime
              : 0;
          return this._options.suiteTimeout > 0 &&
            runStats.timers.startGenTime > 0
            ? Math.max(0, this._options.suiteTimeout - timeSinceGenStart)
            : Infinity;
        };

        const getEffectiveCancelFn = (): (() => boolean) | undefined => {
          if (!cancelFn) return undefined;
          return () => !stillInjecting && cancelFn();
        };

        if (transformRunner) {
          let transformedInput: TransformedInputAndSource;
          try {
            transformedInput =
              await this._compositeInputGenerator.nextTransformed();
          } catch {
            continue; // stopReason checked at top of loop
          }
          result.inputGenerated = transformedInput;

          // Process transformer result if candidate was skipped/errored by transformer
          if (transformedInput.transformerResult) {
            const transformerResult = transformedInput.transformerResult;
            switch (transformerResult.result.tag) {
              case "skip":
                result.skipped = true;
                result.skipReason = `(${transformRunner.name}) ${transformerResult.result.message}`;
                break;

              case "timeout":
                result.harnessErrors.push({
                  kind: "timeout",
                  stage: "transformer",
                  fnName: transformRunner.name,
                  message: `Timeout exceeding ${this._options.fnTimeout} ms`,
                  display: `(${transformRunner.name} timeout)`,
                });
                break;

              case "error":
                result.harnessErrors.push({
                  kind: "exception",
                  stage: "transformer",
                  fnName: transformRunner.name,
                  message: transformerResult.result.message,
                  display: `(${transformRunner.name} ${transformerResult.result.name}) ${transformerResult.result.message}`,
                  stack: transformerResult.result.stack ?? "<no stack>",
                });
                break;

              case "value":
                break;
            }
          }
        } else {
          try {
            result.inputGenerated = this._compositeInputGenerator.next();
          } catch {
            continue; // stopReason checked at top of loop
          }
        }
        result.timers.gen = performance.now() - startGenTime; // total time: input generation

        // Map the generated inputs to the result object
        result.input = result.inputGenerated.value.map((e, i) => {
          return {
            name: argDefs[i]?.getName() ?? "?",
            offset: i,
            value: e.value,
            origin: result.inputGenerated.source,
          };
        });

        // Pointer to generator stats for this input, if not injected
        let genStats:
          | FuzzTestStats["generators"]["RandomInputGenerator"]
          | undefined = undefined;

        // Handle injected and generated tests
        if (result.inputGenerated.injected) {
          const pinnedTest = injectMap.get(getIoKey(result.input));
          if (pinnedTest) {
            result.pinned = !!pinnedTest.pinned;
            if (pinnedTest.expectedOutput) {
              result.expectedOutput = pinnedTest.expectedOutput;
            }
          }
          runStats.counters.inputsInjected++;
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

            // Log the generation start time
            if (runStats.timers.startGenTime === 0) {
              runStats.timers.startGenTime = startGenTime;
            }
          }
          // Indicate that we are no longer injecting inputs
          stillInjecting = false;
        }

        // Front-end status update
        update({
          type: "testing",
          fnName: this._fnName,
          lang: this._program.lang,
          inputs: result.input.map((i) => i.value),
          stats: runStats,
          pct: typeof stopCondition === "number" ? stopCondition : 100,
          stillInjecting,
          isCancelled: Boolean(cancelFn && cancelFn()),
        });

        // Call the PUT via its runner
        if (!result.skipped && result.harnessErrors.length === 0) {
          const startRunTime = performance.now(); // start timer
          let exeOutput: RunnerResult;
          try {
            exeOutput = await runner.runWithInterrupt(
              () =>
                runner.run(
                  result.input.map((e) => e.value),
                  Math.max(this._options.fnTimeout, 0)
                ),
              getRemainingSuiteTime(),
              getEffectiveCancelFn()
            );
          } catch (e: unknown) {
            if (isError(e) && e.message === "runnerInterrupted") {
              continue;
            }

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
                value: isArgValueType(exeOutput.result.value)
                  ? exeOutput.result.value
                  : undefined,
                origin: { type: "put" },
              });
              break;
            case "error":
              result.exception = true;
              result.exceptionMessage = exeOutput.result.message;
              result.exceptionDisplay = `(${exeOutput.result.name}) ${exeOutput.result.message}`;
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
              let validatorJudgments: (Judgment | Error)[] = [];
              try {
                validatorJudgments = await propertyOracle.judge(
                  Object.freeze({
                    in: result.input.map((i) => i.value), // inputs
                    out:
                      result.output.length === 0
                        ? "timeout or exception"
                        : result.output[0].value,
                    exception: result.exception,
                    timeout: result.timeout,
                  }),
                  Math.max(this._options.fnTimeout, 0),
                  getRemainingSuiteTime(),
                  getEffectiveCancelFn()
                );
              } catch (e: unknown) {
                if (isError(e) && e.message === "runnerInterrupted") {
                  continue;
                }
                throw e;
              }

              validatorJudgments.forEach((j, i) => {
                if (isError(j)) {
                  result.passedValidators.push("unknown");
                  const fnName = this._validators[i].name;
                  if (j.name === "PropertyValidatorTimeout") {
                    result.harnessErrors.push({
                      kind: "timeout",
                      stage: "validator",
                      fnName,
                      message: `Timeout exceeding ${this._options.fnTimeout} ms`,
                      display: `(${fnName} timeout)`,
                    });
                  } else {
                    result.harnessErrors.push({
                      kind: "exception",
                      stage: "validator",
                      fnName,
                      message: j.message,
                      display: `(${fnName} ${j.name}) ${j.message}`,
                      stack: j.stack ?? "<no stack>",
                    });
                  }
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

        // --- SHRINKING LOGIC ---
        if (
          this._fuzzerFocus.mode === "shrink" &&
          this._failingResultToShrink
        ) {
          const targetFailure = this._failingResultToShrink;

          // Check if candidate input reproduced the exact same failure
          const sameJudgments = isSameJudgments(result, targetFailure);
          const sameCategory = result.category === targetFailure.category;
          const sameException =
            !targetFailure.exceptionMessage ||
            result.exceptionMessage === targetFailure.exceptionMessage;

          if (sameJudgments && sameCategory && sameException) {
            // Adopt smaller input as new shrink target
            this._fuzzerFocus = deepFreeze({
              mode: "shrink",
              target: result.inputGenerated,
            });
            targetFailure.input = result.input;
            targetFailure.output = result.output;
            targetFailure.shrinkStep = (targetFailure.shrinkStep ?? 0) + 1;
          }

          // Check shrink exit conditions
          const maxShrinkTime = Config.get(
            "nanofuzz.fuzzer.maxShrinkTime",
            2000
          );
          const shrinkTimeElapsed = performance.now() - this._shrinkStartTime;
          const timeExceeded =
            maxShrinkTime > 0 && shrinkTimeElapsed >= maxShrinkTime;
          const stepCapExceeded = (targetFailure.shrinkStep ?? 0) >= 100;
          const noMoreShrinks =
            this._compositeInputGenerator.nextable() === false;

          if (timeExceeded || stepCapExceeded || noMoreShrinks) {
            this._fuzzerFocus = deepFreeze({ mode: "gen" });
            if (this._savedGeneratorOptions) {
              this._compositeInputGenerator.options =
                this._savedGeneratorOptions;
            }
          }
        } else {
          // --- NORMAL GENERATION MODE: TRIGGER SHRINKING ON FAILURE ---
          const isFailingResult =
            result.category === "badValue" ||
            result.category === "exception" ||
            result.category === "timeout";

          const shouldShrinkTrigger =
            isFailingResult &&
            this._options.maxFailures === 1 &&
            Config.get("nanofuzz.fuzzer.shrinkFailures", true) &&
            !result.inputGenerated.injected &&
            this._function.getArgDefs().length > 0;

          if (shouldShrinkTrigger) {
            this._failingResultToShrink = result;
            this._failingResultToShrink.shrinkStep = 0;
            this._shrinkStartTime = performance.now();
            this._savedGeneratorOptions = structuredClone(
              this._options.generators
            );

            this._fuzzerFocus = deepFreeze({
              mode: "shrink",
              target: result.inputGenerated,
            });

            this._compositeInputGenerator.options = {
              RandomInputGenerator: { enabled: false },
              MutationInputGenerator: { enabled: true },
              AiInputGenerator: { enabled: false },
            };
          }
        }

        // Increment the test counters and outcome statistics
        runStats.outcomes.categories[result.category]++;
        if (result.exception) {
          runStats.outcomes.exceptions++;
        }
        if (result.timeout) {
          runStats.outcomes.timeouts++;
        }
        if (result.passedImplicit in runStats.outcomes.oracles.heuristic) {
          runStats.outcomes.oracles.heuristic[result.passedImplicit]++;
        }
        if (result.passedHuman in runStats.outcomes.oracles.human) {
          runStats.outcomes.oracles.human[result.passedHuman]++;
        }
        if (result.passedValidator in runStats.outcomes.oracles.property) {
          runStats.outcomes.oracles.property[result.passedValidator]++;
        }
        if (result.category !== "skip") {
          runStats.outcomes.total++;
        }
        if (
          result.category !== "ok" &&
          result.category !== "skip" &&
          !runStats.outcomes.firstFailure
        ) {
          runStats.outcomes.firstFailure = result;
        }

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

        // Take measurements for this test run
        {
          const startMeasureTime = performance.now(); // start timer
          const measurements = this._measures.map((e) =>
            e.measure(result.inputGenerated, result)
          );

          // Provide measures feedback to the composite input generator
          result.interestingReasons =
            this._compositeInputGenerator.onInputFeedback(
              measurements,
              result.timers.run + result.timers.gen,
              result.inputGenerated
            );

          // Measurement stats
          const measureTime = performance.now() - startMeasureTime;
          this._results.stats.timers.measure += measureTime;
          if (genStats) {
            genStats.timers.measure += measureTime;
          }
        }

        // Store the result for this iteration
        const retention = this._options.outputResults ?? "all";
        const shouldRetain =
          retention === "all" ||
          Boolean(result.inputGenerated?.injected) ||
          (retention === "failures" &&
            result.category !== "ok" &&
            result.category !== "skip");

        if (shouldRetain) {
          this._results.results.push(result);
        }
        if (onResultFn) {
          onResultFn(deepFreeze(result));
        }

        yield undefined;
      } // for: Main test loop
    } finally {
      this._fuzzerFocus = deepFreeze({ mode: "gen" });
      if (this._savedGeneratorOptions) {
        this._compositeInputGenerator.options = this._savedGeneratorOptions;
      }
      if (periodicTimer !== undefined) {
        clearInterval(periodicTimer);
        periodicTimer = undefined;
      }
    }
  } // fn: _run

  /**
   * Returns diagnostic messages from the composite input generator.
   */
  public getInputGeneratorDiagnostics(): string[] {
    return this._compositeInputGenerator.getDiagnostics();
  }
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
  gen: boolean,
  fuzzerFocusMode: "gen" | "shrink" = "gen"
): FuzzStopReason | number => {
  let maxPct = 0;
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
    const timePct = (now - stats.timers.startGenTime) / options.suiteTimeout;
    if (timePct > maxPct) maxPct = timePct;
  }

  // End testing if we exceed the maximum number of tests
  const executedNonInjected = gen
    ? stats.counters.inputsGenerated -
      stats.counters.dupesGenerated -
      stats.counters.inputsSkipped
    : 0;
  const totalInputsCount = stats.counters.inputsInjected + executedNonInjected;
  const targetCount = injectCount + (gen ? options.maxTests : 0);

  if (totalInputsCount >= targetCount) {
    return FuzzStopReason.MAXTESTS;
  }
  if (targetCount > 0) {
    const testsPct = totalInputsCount / targetCount;
    if (testsPct > maxPct) maxPct = testsPct;
  }

  // End testing if we exceed the maximum number of failures & are done injecting inputs
  if (options.maxFailures > 0 && !injecting && fuzzerFocusMode !== "shrink") {
    const totalFailures =
      stats.counters.failedTests + stats.counters.erroredTests;
    if (totalFailures >= options.maxFailures) {
      return FuzzStopReason.MAXFAILURES;
    }
    const failuresPct = totalFailures / options.maxFailures;
    if (failuresPct > maxPct) maxPct = failuresPct;
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
  return Math.max(0, Math.floor(maxPct * 100));
}; // fn: _checkStopCondition()
