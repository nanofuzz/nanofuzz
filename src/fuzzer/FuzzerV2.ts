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
  BaseMeasureConfig,
  FuzzEnv,
  FuzzMode,
  FuzzOptions,
  FuzzPinnedTest,
  FuzzResultCallback,
  FuzzStatusUpdater,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
  FuzzerFocus,
  InputAndSource,
  TransformedInputAndSource,
} from "./Types";
import {
  getTransformers,
  getUserGenerators,
  getValidators,
  isOptionValid,
} from "./analysis/Util";
import { MeasureFactory } from "./measures/MeasureFactory";
import { RunnerFactory } from "./runners/RunnerFactory";
import { Leaderboard } from "./generators/Leaderboard";
import { getIoKey, isError, isSameJudgments } from "./Util";
import { PropertyOracle } from "./oracles/PropertyOracle";
import { AbstractProgram } from "./analysis/AbstractProgram";
import { AbstractRunner } from "./runners/AbstractRunner";
import { AbstractMeasure } from "./measures/AbstractMeasure";
import { CompilerStaleness } from "./compilers/Types";
import { FuzzExecutor } from "./FuzzExecutor";
import { FuzzStats } from "./FuzzStats";

/**
 * FuzzerV2 (Tester) is the modernized, simplified orchestrator for the fuzzer.
 * It coordinates candidate input generation from CompositeInputGenerator, single-test
 * execution via FuzzExecutor, and metric tracking / stop conditions via FuzzStats.
 */
export class FuzzerV2 {
  protected _module: string;
  protected _fnName: string;
  protected _options: FuzzOptions;
  protected _program: AbstractProgram;
  protected _function: FunctionDef;
  protected _validators: FunctionRef[] = [];
  protected _transformers: FunctionRef[] = [];
  protected _userGenerators: FunctionRef[] = [];
  protected _measures: AbstractMeasure[];
  protected _leaderboard = new Leaderboard<InputAndSource>();
  protected _allInputs: Map<string, unknown> = new Map();
  protected _state: "init" | "ready" | "running" | "paused" | "crashed" =
    "init";

  protected _compositeInputGenerator: CompositeInputGenerator;
  protected _executor?: FuzzExecutor;
  protected _stats: FuzzStats;
  protected _lastCompiler?: ReturnType<
    (typeof CompilerFactory)["fromSourcefile"]
  >;

  // Cooperative Shrink State
  protected _fuzzerFocus: FuzzerFocus = deepFreeze({ mode: "gen" });
  protected _failingResultToShrink?: FuzzTestResult;
  protected _shrinkStartTime = 0;
  protected _savedGeneratorOptions?: FuzzOptions["generators"];

  public constructor(
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

    const fnList = this._program.functions;
    if (!(this._fnName in fnList)) {
      if (this._fnName in this._program.functionsNotSupported) {
        const reason = this._program.functionsNotSupported[this._fnName].reason;
        throw new Error(
          `Function ${this._fnName} in ${this._module} is not supported for reason: ${reason}`
        );
      }
      throw new Error(
        `Could not find function ${this._fnName} in: ${this._module}`
      );
    }
    this._function = fnList[this._fnName];

    this._validators = getValidators(this._program, this._function);
    this._transformers = getTransformers(this._program, this._function);
    this._userGenerators = getUserGenerators(this._program, this._function);

    if (!isOptionValid(normalizedOptions)) {
      throw new Error(
        `Invalid options provided: ${JSONN.stringify(normalizedOptions, null, 2)}`
      );
    }
    this._options = structuredClone(normalizedOptions);

    const optMeasures: Record<string, BaseMeasureConfig> =
      this._options.measures;
    this._measures = MeasureFactory(this._program.lang).filter((m) =>
      m.name in optMeasures ? optMeasures[m.name].enabled : false
    );

    this._stats = new FuzzStats(
      this._options,
      this._function,
      this._validators,
      this._transformers,
      this._userGenerators
    );

    this._compositeInputGenerator = new CompositeInputGenerator(
      this._options.generators,
      this._function,
      options.seed,
      this._measures,
      this._leaderboard,
      this._stats.results.stats.generators,
      this._allInputs,
      this._program.src,
      this.getFuzzerFocus.bind(this)
    );

    if (mode.precompile) {
      CompilerFactory.fromSourcefile(module)?.compileAsync(module);
    }
  } // fn: constructor

  /**
   * Retrieves the current fuzzer focus.
   *
   * @returns The current fuzzer focus.
   */
  protected getFuzzerFocus(): FuzzerFocus {
    return this._fuzzerFocus;
  } // fn: getFuzzerFocus

  /**
   * Determines whether the compiler or fuzzer options are stale and need to be updated.
   *
   * @param options The fuzzing options to check for staleness.
   * @returns The staleness status of the compiler or fuzzer options.
   */
  public isStale(
    options: FuzzOptions
  ): CompilerStaleness | "optionschanged" | "crashed" {
    if (this._lastCompiler) {
      const compilerIsStale = this._lastCompiler.isStale();
      if (compilerIsStale) {
        return compilerIsStale;
      }
    }

    const retestRelevantOptions = (opt: FuzzOptions): Partial<FuzzOptions> => {
      return {
        measures: opt.measures,
        useProperty: opt.useProperty,
        useImplicit: opt.useImplicit,
        useHuman: opt.useHuman,
      };
    };

    if (
      JSONN.stringify(retestRelevantOptions(options)) !==
      JSONN.stringify(retestRelevantOptions(this._options))
    ) {
      return "optionschanged";
    }

    if (this._state === "crashed") {
      return "crashed";
    }

    return false;
  } // fn: isStale

  /**
   * Sets the fuzzing options for the fuzzer instance.
   * @param options The new fuzzing options to apply.
   */
  public set options(options: FuzzOptions) {
    const normalizedOptions: FuzzOptions = {
      ...options,
      argDefaults: ArgDef.normalizeOptions(options?.argDefaults),
    };

    if (!isOptionValid(normalizedOptions)) {
      throw new Error(
        `Invalid options provided: ${JSONN.stringify(normalizedOptions, null, 2)}`
      );
    }

    if (JSONN.stringify(this._options) !== JSONN.stringify(normalizedOptions)) {
      this._options = structuredClone(normalizedOptions);
      if (this._stats) {
        this._stats.options = this._options;
      }
      this._compositeInputGenerator.options = this._options.generators;
    }
  } // set: options

  /**
   * Retrieves the current environment configuration of the fuzzer.
   */
  public get env(): FuzzEnv {
    return {
      options: structuredClone(this._options),
      function: this._function,
      validators: structuredClone(this._validators),
      transformers: structuredClone(this._transformers),
      userGenerators: structuredClone(this._userGenerators),
    };
  } // get: env

  /**
   * Retrieves the current state of the fuzzer.
   */
  public get state(): typeof this._state {
    return this._state;
  } // fn: state

  /**
   * Executes the fuzzing run and returns the finalized results.
   *
   * @param injectTests An array of pinned tests to inject into the fuzzing run.
   * @param mode The fuzzing mode to use for this run.
   * @param updateFn Optional callback function to receive status updates.
   * @param cancelFn Optional function to determine if the fuzzing run should be canceled.
   * @param onResultFn Optional callback function to receive individual test results.
   * @returns A promise that resolves with the fuzz test results.
   */
  public async test(
    injectTests: FuzzPinnedTest[] = [],
    mode: FuzzMode = { gen: true },
    updateFn?: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<FuzzTestResults> {
    const state = this.state;
    if (!(state === "init" || state === "paused")) {
      throw new Error(
        `Testing cannot be started or resumed from state ${state}`
      );
    }

    this._stats.startRun();

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

    this._executor = await this._initExecutor(
      injectTests,
      mode,
      update,
      updateFn
    );

    let stillInjecting = injectTests.length > 0;
    this._state = "ready";
    lastUpdateTimestamp = performance.now();

    const checkPeriodicUpdate = () => {
      if (
        this._state === "running" &&
        performance.now() - lastUpdateTimestamp >= 100
      ) {
        const stopCondition = this._stats!.shouldStop(
          this._options,
          this._compositeInputGenerator.nextable() !== false,
          stillInjecting,
          injectTests.length,
          Boolean(cancelFn && cancelFn()),
          this._fuzzerFocus.mode,
          Boolean(mode.gen),
          {
            generated: this._compositeInputGenerator.inputsGenerated,
            dupes: this._compositeInputGenerator.dupesGenerated,
            sequentialDupes: this._compositeInputGenerator.dupesSequential,
          }
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
      while (true) {
        this._state = "running";
        checkPeriodicUpdate();

        const stopCondition = this._stats.shouldStop(
          this._options,
          this._compositeInputGenerator.nextable() !== false,
          stillInjecting,
          injectTests.length,
          Boolean(cancelFn && cancelFn()),
          this._fuzzerFocus.mode,
          Boolean(mode.gen),
          {
            generated: this._compositeInputGenerator.inputsGenerated,
            dupes: this._compositeInputGenerator.dupesGenerated,
            sequentialDupes: this._compositeInputGenerator.dupesSequential,
          }
        );

        if (typeof stopCondition !== "number") {
          if (this._fuzzerFocus.mode === "shrink") {
            this._exitShrink();
            continue;
          }
          return await this._finalizeRun(stopCondition, update, cancelFn);
        }

        // Prepare measures for next test execution (before transformers & runners execute)
        const initMeasTime = this._executor!.prepareMeasures();

        // If non-injected generation has begun, record startGenTime
        const startGenTime = performance.now();
        if (!stillInjecting && this._stats!.startGenTime === 0) {
          this._stats!.markGenStarted(startGenTime);
        }

        // Handle async generator wait (e.g. LLM inputs)
        if (this._compositeInputGenerator.nextable() === "soon") {
          const remainingTimeout =
            this._options.suiteTimeout > 0 && this._stats!.startGenTime > 0
              ? Math.max(
                  0,
                  this._options.suiteTimeout -
                    (performance.now() - this._stats!.startGenTime)
                )
              : undefined;
          const waitTimer = setTimeout(() => {
            update({
              type: "waiting-for-generator",
              pendingGenerators:
                this._compositeInputGenerator.getPendingGeneratorNames(),
              stats: this._stats!.currentRun,
              pct: typeof stopCondition === "number" ? stopCondition : 0,
            });
          }, 200);
          try {
            await this._compositeInputGenerator.waitForNextInput(
              remainingTimeout
            );
          } catch (e: unknown) {
            this._state = "crashed";
            if (this._stats) {
              this._stats.results.stopReason = FuzzStopReason.CRASH;
            }
            throw e;
          } finally {
            clearTimeout(waitTimer);
          }
        }

        if (
          this._compositeInputGenerator.nextable() !== "now" &&
          this._compositeInputGenerator.nextable() !== "now!" &&
          !stillInjecting
        ) {
          continue;
        }

        // Fetch candidate input
        let candidate: TransformedInputAndSource;
        try {
          candidate = await this._compositeInputGenerator.nextTransformed();
        } catch (e: unknown) {
          if (
            isError(e) &&
            e.message ===
              "Injected inputs exhausted and input generators are suppressed."
          ) {
            continue;
          }
          this._state = "crashed";
          if (this._stats) {
            this._stats.results.stopReason = FuzzStopReason.CRASH;
          }
          throw e;
        }
        const genTime = performance.now() - startGenTime;

        if (!candidate.injected) {
          stillInjecting = false;
          if (this._stats!.startGenTime === 0) {
            this._stats!.markGenStarted(startGenTime);
          }
        }

        // Notify front-end / status update before executing the test
        const currentStopCondition = this._stats!.shouldStop(
          this._options,
          this._compositeInputGenerator.nextable() !== false,
          stillInjecting,
          injectTests.length,
          Boolean(cancelFn && cancelFn()),
          this._fuzzerFocus.mode,
          Boolean(mode.gen),
          {
            generated: this._compositeInputGenerator.inputsGenerated,
            dupes: this._compositeInputGenerator.dupesGenerated,
            sequentialDupes: this._compositeInputGenerator.dupesSequential,
          }
        );
        const currentPct =
          typeof currentStopCondition === "number" ? currentStopCondition : 100;
        this._notify(candidate, currentPct, update, cancelFn, stillInjecting);

        // Execute single test pipeline: Run -> Oracles -> Measures -> Feedback
        const execution = await this._executor!.execute(
          candidate,
          genTime,
          this._compositeInputGenerator,
          () => {
            if (!cancelFn) return undefined;
            return () => !stillInjecting && cancelFn();
          },
          initMeasTime
        );

        if (!execution) {
          continue; // Interrupted
        }

        const { result, valTime, measureTime } = execution;

        // Record stats and outcomes
        this._stats.record(
          result,
          candidate,
          valTime,
          measureTime,
          this._fuzzerFocus.mode
        );

        // Cooperative shrinking step
        this._shrink(result);

        // Notify result callback
        if (onResultFn) {
          onResultFn(deepFreeze(result));
        }
      }
    } catch (e: unknown) {
      if (this._state === "running") {
        this._state = "crashed";
      }
      throw e;
    } finally {
      this._exitShrink();
      if (periodicTimer !== undefined) {
        clearInterval(periodicTimer);
        periodicTimer = undefined;
      }
      if (this._executor) {
        await this._executor.stop();
      }
    }
  } // fn: test

  /**
   * Initializes the fuzz executor with the given pinned tests, fuzzing mode, and status updaters.
   *
   * @param injectTests The list of pinned tests to inject into the fuzzer.
   * @param mode The current fuzzing mode, indicating whether generation is enabled.
   * @param update The status updater function to report progress and messages.
   * @param updateFn Optional secondary status updater function.
   * @returns A promise that resolves to the initialized fuzz executor.
   */
  protected async _initExecutor(
    injectTests: FuzzPinnedTest[],
    mode: FuzzMode,
    update: FuzzStatusUpdater,
    updateFn?: FuzzStatusUpdater
  ): Promise<FuzzExecutor> {
    if (mode.gen) {
      this._compositeInputGenerator.permitGenerators();
    } else {
      this._compositeInputGenerator.suppressGenerators();
    }

    const fqSrcFile = fs.realpathSync(this._function.getModule());
    const startCompTime = performance.now();
    this._lastCompiler = CompilerFactory.fromSourcefile(fqSrcFile);
    const mod = this._lastCompiler
      ? this._lastCompiler.compileSync(update)
      : fqSrcFile;
    if (this._stats) {
      this._stats.results.stats.timers.compile =
        performance.now() - startCompTime;
    }

    const instrumentTime = performance.now();
    const targetMod = this._lastCompiler
      ? Instrumenter.prepareInstrumentedTree(
          mod,
          this._lastCompiler.getCompiledDependencies(),
          this._measures,
          this._lastCompiler.options.tmpDir,
          updateFn
        )
      : mod;
    if (this._stats) {
      this._stats.results.stats.timers.instrument =
        performance.now() - instrumentTime;
    }

    const runner = RunnerFactory(this.env, targetMod, this._function.getName());
    await runner.onRunStart();

    let transformRunner: ReturnType<typeof RunnerFactory> | undefined;
    if (this.env.options.useTransformer && this.env.transformers.length) {
      transformRunner = RunnerFactory(
        this.env,
        targetMod,
        this.env.transformers[0].name
      );
      await transformRunner.onRunStart();
    }

    let userGenRunner: ReturnType<typeof RunnerFactory> | undefined;
    if (
      this.env.options.generators.UserInputGenerator?.enabled &&
      this.env.userGenerators.length
    ) {
      userGenRunner = RunnerFactory(
        this.env,
        targetMod,
        this.env.userGenerators[0].name
      );
      await userGenRunner.onRunStart();
    }

    this._compositeInputGenerator.onRunStart(
      Boolean(mode.gen),
      injectTests,
      transformRunner,
      this._options.fnTimeout,
      this._options.maxDupeInputs,
      userGenRunner
    );

    const propRunners = this._validators.map((vFnRef) =>
      RunnerFactory(this.env, targetMod, vFnRef.name)
    );
    await Promise.all(propRunners.map((p) => p.onRunStart()));
    const propertyOracle = new PropertyOracle(propRunners);

    const runners = [
      runner,
      transformRunner,
      userGenRunner,
      ...propRunners,
    ].filter((r): r is AbstractRunner => r !== undefined);
    this._measures.forEach((m) => {
      m.onRunStart(runners);
    });

    const injectMap = new Map(injectTests.map((t) => [getIoKey(t.input), t]));

    const getRemainingSuiteTime = (): number => {
      const timeSinceGenStart =
        this._stats && this._stats.currentRun.timers.startGenTime > 0
          ? performance.now() - this._stats.currentRun.timers.startGenTime
          : 0;
      return this._options.suiteTimeout > 0 &&
        this._stats &&
        this._stats.currentRun.timers.startGenTime > 0
        ? Math.max(0, this._options.suiteTimeout - timeSinceGenStart)
        : Infinity;
    };

    return new FuzzExecutor(
      runner,
      transformRunner,
      propRunners,
      propertyOracle,
      this._measures,
      this._options,
      this._function,
      this._validators,
      injectMap,
      getRemainingSuiteTime
    );
  } // fn: _initExecutor

  /**
   * Shrinks the given failing fuzz test result if the fuzzer is in shrink mode.
   * Updates the fuzzer focus and manages the shrinking process.
   *
   * @param result The current fuzz test result.
   */
  protected _shrink(result: FuzzTestResult): void {
    if (this._fuzzerFocus.mode === "shrink" && this._failingResultToShrink) {
      const targetFailure = this._failingResultToShrink;

      const sameJudgments = isSameJudgments(result, targetFailure);
      const sameCategory = result.category === targetFailure.category;
      const sameException =
        !targetFailure.exceptionMessage ||
        result.exceptionMessage === targetFailure.exceptionMessage;

      if (sameJudgments && sameCategory && sameException) {
        this._fuzzerFocus = deepFreeze({
          mode: "shrink",
          target: result.inputGenerated,
        });
        targetFailure.input = result.input;
        targetFailure.output = result.output;
        targetFailure.shrinkStep = (targetFailure.shrinkStep ?? 0) + 1;
      }

      const maxShrinkTime = Config.get("nanofuzz.fuzzer.maxShrinkTime", 2000);
      const shrinkTimeElapsed = performance.now() - this._shrinkStartTime;
      const timeExceeded =
        maxShrinkTime > 0 && shrinkTimeElapsed >= maxShrinkTime;
      const stepCapExceeded = (targetFailure.shrinkStep ?? 0) >= 100;
      const noMoreShrinks = this._compositeInputGenerator.nextable() === false;

      if (timeExceeded || stepCapExceeded || noMoreShrinks) {
        this._exitShrink();
      }
    } else {
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
        this._savedGeneratorOptions = structuredClone(this._options.generators);

        this._fuzzerFocus = deepFreeze({
          mode: "shrink",
          target: result.inputGenerated,
        });

        this._compositeInputGenerator.options = {
          RandomInputGenerator: { enabled: false },
          MutationInputGenerator: { enabled: true },
          AiInputGenerator: { enabled: false },
          UserInputGenerator: { enabled: false },
        };
      }
    }
  } // fn: _shrink

  /**
   * Exits the shrinking mode and restores the previous generator options.
   */
  protected _exitShrink(): void {
    this._fuzzerFocus = deepFreeze({ mode: "gen" });
    if (this._savedGeneratorOptions) {
      this._compositeInputGenerator.options = this._savedGeneratorOptions;
      this._savedGeneratorOptions = undefined;
    }
    this._failingResultToShrink = undefined;
  } // fn: _exitShrink

  /**
   * Notifies the status updater about the upcoming test and progress.
   *
   * @param candidate The candidate input about to be tested.
   * @param pct The current progress percentage.
   * @param update The status updater function to report progress and msgs.
   * @param cancelFn Optional function to check if the run should be cancelled.
   * @param stillInjecting Indicates if the fuzzer is still injecting inputs.
   */
  protected _notify(
    candidate: TransformedInputAndSource,
    pct: number,
    update: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    stillInjecting: boolean = false
  ): void {
    update({
      type: "testing",
      fnName: this._function.getName(),
      lang: this._function.getLang(),
      inputs: candidate.value.map((i) => i.value),
      stats: this._stats!.currentRun,
      pct,
      stillInjecting,
      isCancelled: Boolean(cancelFn && cancelFn()),
    });
  } // fn: _notify

  /**
   * Finalizes the fuzzing run by stopping the executor, collecting diagnostics,
   * and updating the status.
   *
   * @param stopReason The reason why the fuzzing run is stopping.
   * @param update The status updater function to report progress and msgs.
   * @param cancelFn Optional function to check if the run should be cancelled.
   * @returns A promise that resolves to the final fuzz test results.
   */
  protected async _finalizeRun(
    stopReason: FuzzStopReason,
    update: FuzzStatusUpdater,
    cancelFn?: () => boolean
  ): Promise<FuzzTestResults> {
    const results = this._stats!.finalize(stopReason);

    results.interesting.inputs =
      this._compositeInputGenerator.getInterestingInputs();

    this._measures.forEach((e) => {
      e.onRunEnd(results);
    });
    await this._compositeInputGenerator.onRunEnd(results);

    if (this._executor) {
      await this._executor.stop();
    }

    update({
      type: "testing-complete",
      cancelled: Boolean(cancelFn && cancelFn()),
      pct: 100,
    });

    this._state = "paused";
    return results;
  } // fn: _finalizeRun

  /**
   * Retrieves diagnostic messages from the input generator.
   *
   * @returns An array of diagnostic messages from the input generator.
   */
  public getInputGeneratorDiagnostics(): string[] {
    return this._compositeInputGenerator.getDiagnostics();
  } // fn: getInputGeneratorDiagnostics
} // class: FuzzerV2
