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
  isArgValueType,
  isOptionValid,
} from "./analysis/Util";
import { MeasureFactory } from "./measures/MeasureFactory";
import { RunnerFactory } from "./runners/RunnerFactory";
import { Leaderboard } from "./generators/Leaderboard";
import {
  categorizeResult,
  getIoKey,
  isError,
  isSameJudgments,
  resolveWorkerCount,
} from "./Util";
import { PropertyOracle } from "./oracles/PropertyOracle";
import { ImplicitOracle } from "./oracles/ImplicitOracle";
import { ExampleOracle } from "./oracles/ExampleOracle";
import { Judgment } from "./oracles/Types";
import { AbstractProgram } from "./analysis/AbstractProgram";
import { AbstractRunner, RunnerResult } from "./runners/AbstractRunner";
import { AbstractMeasure, BaseMeasurement } from "./measures/AbstractMeasure";
import { AbstractCoverageMeasure } from "./measures/AbstractCoverageMeasure";
import { CompilerStaleness } from "./compilers/Types";
import { FuzzStats } from "./FuzzStats";

/**
 * FuzzerV3 is a multi-worker concurrent fuzzer engine.
 * It coordinates candidate input generation across a pool of parallel runner workers.
 */
export class FuzzerV3 {
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
  protected _workers: WorkerContext[] = [];
  protected _userGenRunner?: AbstractRunner;
  protected _injectMap: Map<string, FuzzPinnedTest> = new Map();
  protected _stats: FuzzStats;
  protected _lastCompiler?: ReturnType<
    (typeof CompilerFactory)["fromSourcefile"]
  >;
  protected _slotSeq = 0;
  protected _stage1InjectedCount = 0;
  protected _injectedInFlight = 0;

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

    this._validators = getValidators(this._program, fnList[this._fnName]);
    this._transformers = getTransformers(this._program, fnList[this._fnName]);
    this._userGenerators = getUserGenerators(
      this._program,
      fnList[this._fnName]
    );

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
        this._stats.results.env.options = structuredClone(normalizedOptions);
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
   * Retrieves the active worker count.
   */
  public get workerCount(): number {
    return this._workers.length || resolveWorkerCount(this._options.workers);
  } // get: workerCount

  /**
   * Executes the fuzzing run using a 5-stage lockstep pipeline.
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

    await this._initRunners(injectTests, mode, update, updateFn);

    this._stage1InjectedCount = 0;
    this._state = "ready";
    lastUpdateTimestamp = performance.now();

    const checkPeriodicUpdate = () => {
      if (
        this._state === "running" &&
        performance.now() - lastUpdateTimestamp >= 100
      ) {
        const stopCondition = this._shouldGenStop(
          injectTests.length,
          Boolean(mode.gen),
          Boolean(cancelFn && cancelFn())
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
      this._state = "running";

      const stopReason = await this._runMultiWorkerPipeline(
        injectTests.length,
        mode,
        update,
        checkPeriodicUpdate,
        cancelFn,
        onResultFn
      );

      return await this._finalizeRun(stopReason, update, cancelFn);
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
      await this._stopRunners();
    }
  } // fn: test

  /**
   * Runs the concurrent multi-worker pipeline across a pool of PUT runners.
   */
  protected async _runMultiWorkerPipeline(
    injectCount: number,
    mode: FuzzMode,
    update: FuzzStatusUpdater,
    checkPeriodicUpdate: () => void,
    cancelFn?: () => boolean,
    onResultFn?: FuzzResultCallback
  ): Promise<FuzzStopReason> {
    let isGenActive = true;
    let finalStopReason: FuzzStopReason | undefined = undefined;
    let genPromise: Promise<void> = Promise.resolve();
    let recordPromise: Promise<void> = Promise.resolve();

    const fetchNextSlot = async (): Promise<{
      slot?: PipelineSlot;
      stopReason?: FuzzStopReason;
    }> => {
      let res: { slot?: PipelineSlot; stopReason?: FuzzStopReason } = {};
      const nextGen = genPromise.then(async () => {
        if (!isGenActive) return;
        checkPeriodicUpdate();

        // If we finished fetching injected inputs but some are still running, wait for them to finish before starting generation
        if (
          this._stage1InjectedCount >= injectCount &&
          this._injectedInFlight > 0
        ) {
          while (this._injectedInFlight > 0 && isGenActive) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }

        const stopCondition = this._shouldGenStop(
          injectCount,
          Boolean(mode.gen),
          Boolean(cancelFn && cancelFn())
        );

        if (typeof stopCondition !== "number") {
          if (this._fuzzerFocus.mode === "shrink") {
            this._exitShrink();
          } else {
            isGenActive = false;
            if (!finalStopReason) {
              finalStopReason = stopCondition;
            }
            res = { stopReason: stopCondition };
            return;
          }
        }

        const stillInjecting = this._stage1InjectedCount < injectCount;
        const slot = await this._stage1FetchAndGen(
          update,
          cancelFn,
          stillInjecting,
          stopCondition
        );

        res = { slot };
      });

      genPromise = nextGen.catch(() => {});
      await nextGen;
      return res;
    };

    const runWorker = async (worker: WorkerContext) => {
      while (isGenActive) {
        const { slot, stopReason } = await fetchNextSlot();

        if (stopReason || !slot) {
          break;
        }

        if (
          this._options.maxFailures > 0 &&
          this._stats.currentRun.counters.failedTests +
            this._stats.currentRun.counters.erroredTests >=
            this._options.maxFailures &&
          this._fuzzerFocus.mode !== "shrink"
        ) {
          break;
        }

        const executedSlot = await this._stage2ExecuteTest(
          slot,
          worker,
          cancelFn
        );

        if (executedSlot) {
          let shrinkTriggered = false;
          const nextRecord = recordPromise.then(async () => {
            if (
              this._options.maxFailures > 0 &&
              this._stats.currentRun.counters.failedTests +
                this._stats.currentRun.counters.erroredTests >=
                this._options.maxFailures &&
              this._fuzzerFocus.mode !== "shrink"
            ) {
              isGenActive = false;
              if (!finalStopReason) {
                finalStopReason = FuzzStopReason.MAXFAILURES;
              }
              return;
            }

            shrinkTriggered = await this._stageMeasureAndRecord(
              executedSlot,
              onResultFn
            );

            if (
              this._options.maxFailures > 0 &&
              !executedSlot.candidate?.injected &&
              this._fuzzerFocus.mode !== "shrink"
            ) {
              const totalFailures =
                this._stats.currentRun.counters.failedTests +
                this._stats.currentRun.counters.erroredTests;
              if (totalFailures >= this._options.maxFailures) {
                isGenActive = false;
                if (!finalStopReason) {
                  finalStopReason = FuzzStopReason.MAXFAILURES;
                }
              }
            }

            if (shrinkTriggered) {
              isGenActive = true;
            }
          });

          recordPromise = nextRecord.catch(() => {});
          await nextRecord;
        } else if (slot.injected) {
          this._injectedInFlight = Math.max(0, this._injectedInFlight - 1);
        }
      }
    };

    await Promise.all(this._workers.map((worker) => runWorker(worker)));
    await recordPromise.catch(() => {});

    if (
      this._options.maxFailures > 0 &&
      this._stats.currentRun.counters.failedTests +
        this._stats.currentRun.counters.erroredTests >=
        this._options.maxFailures
    ) {
      finalStopReason = FuzzStopReason.MAXFAILURES;
    } else if (!finalStopReason) {
      const condition = this._shouldGenStop(
        injectCount,
        Boolean(mode.gen),
        Boolean(cancelFn && cancelFn())
      );
      finalStopReason =
        typeof condition !== "number" ? condition : FuzzStopReason.NOMOREINPUTS;
    }

    return finalStopReason;
  } // fn: _runMultiWorkerPipeline

  /**
   * Retrieves diagnostic messages from the input generator.
   *
   * @returns An array of diagnostic messages from the input generator.
   */
  public getInputGeneratorDiagnostics(): string[] {
    return this._compositeInputGenerator.getDiagnostics();
  } // fn: getInputGeneratorDiagnostics

  // ---------------------------------------------------------------------------
  // Pipeline Stages
  // ---------------------------------------------------------------------------

  /**
   * STAGE 1: Fetch/Generate Candidate Input (N+4)
   */
  protected async _stage1FetchAndGen(
    update: FuzzStatusUpdater,
    cancelFn?: () => boolean,
    stillInjecting: boolean = false,
    stopCondition: FuzzStopReason | number = 0
  ): Promise<PipelineSlot | undefined> {
    const startGenTime = performance.now();
    if (!stillInjecting && this._stats.startGenTime === 0) {
      this._stats.markGenStarted(startGenTime);
    }

    // Handle async generator wait (e.g. LLM inputs)
    if (this._compositeInputGenerator.nextable() === "soon") {
      const remainingTimeout =
        this._options.suiteTimeout > 0 && this._stats.startGenTime > 0
          ? Math.max(
              0,
              this._options.suiteTimeout -
                (performance.now() - this._stats.startGenTime)
            )
          : undefined;
      const waitTimer = setTimeout(() => {
        update({
          type: "waiting-for-generator",
          pendingGenerators:
            this._compositeInputGenerator.getPendingGeneratorNames(),
          stats: this._stats.currentRun,
          pct: typeof stopCondition === "number" ? stopCondition : 0,
        });
      }, 200);
      try {
        await this._compositeInputGenerator.waitForNextInput(remainingTimeout);
      } catch (e: unknown) {
        this._state = "crashed";
        this._stats.results.stopReason = FuzzStopReason.CRASH;
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
      return undefined;
    }

    // Fetch candidate input
    let candidate: TransformedInputAndSource;
    try {
      candidate = await this._compositeInputGenerator.nextTransformed();
    } catch {
      return undefined;
    }
    const genTime = performance.now() - startGenTime;

    if (candidate.injected) {
      this._stage1InjectedCount++;
      this._injectedInFlight++;
    } else {
      if (this._stats.startGenTime === 0) {
        this._stats.markGenStarted(startGenTime);
      }
    }

    const currentStopCondition = this._shouldGenStop(
      this._injectMap.size,
      true,
      Boolean(cancelFn && cancelFn())
    );
    const currentPct =
      typeof currentStopCondition === "number" ? currentStopCondition : 100;
    this._notify(candidate, currentPct, update, cancelFn, stillInjecting);

    return {
      id: this._slotSeq++,
      tick: candidate.tick,
      candidate,
      genTime,
      injected: Boolean(candidate.injected),
      transformTime: 0,
      runTime: 0,
      valTime: 0,
      measureTime: 0,
    };
  } // fn: _stage1FetchAndGen

  /**
   * STAGE 2: Execute Test (PUT + Validators)
   */
  protected async _stage2ExecuteTest(
    slot: PipelineSlot,
    worker: WorkerContext,
    cancelFn?: () => boolean
  ): Promise<PipelineSlot | undefined> {
    if (!slot || !slot.candidate || !worker.runner) {
      return slot;
    }

    const result = this._createInitialResult(
      slot.candidate,
      slot.genTime,
      slot.transformTime
    );

    if (slot.candidate.transformerResult && worker.transformRunner) {
      this._handleTransformerResult(
        slot.candidate.transformerResult,
        result,
        worker.transformRunner.name
      );
    }

    if (result.skipped || result.harnessErrors.length > 0) {
      slot.result = result;
      return slot;
    }

    const startRunTime = performance.now();
    let exeOutput: RunnerResult;
    try {
      const cancelCheck = cancelFn && !slot.injected ? cancelFn : undefined;
      exeOutput = await worker.runner.runWithInterrupt(
        () =>
          worker.runner.run(
            result.input.map((e) => e.value),
            Math.max(this._options.fnTimeout, 0)
          ),
        this._getRemainingSuiteTime(),
        cancelCheck
      );
    } catch (e: unknown) {
      if (isError(e) && e.message === "runnerInterrupted") {
        return undefined;
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
    result.timers.run = performance.now() - startRunTime;
    slot.runTime = result.timers.run;

    this._applyRunnerOutput(exeOutput, result);

    if (!result.skipped) {
      const startValTime = performance.now();
      const cancelCheck = cancelFn && !slot.injected ? cancelFn : undefined;
      const oracleSuccess = await this._evaluateOracles(
        result,
        worker.propertyOracle,
        worker.propRunners,
        cancelCheck
      );
      if (!oracleSuccess) {
        return undefined;
      }
      slot.valTime = performance.now() - startValTime;
    }

    slot.result = result;
    slot.exeOutput = exeOutput;
    slot.worker = worker;
    return slot;
  } // fn: _stage2ExecuteTest

  /**
   * Final Measure, Record & Feedback
   */
  protected async _stageMeasureAndRecord(
    slot: PipelineSlot,
    onResultFn?: FuzzResultCallback
  ): Promise<boolean> {
    if (!slot || !slot.result || !slot.candidate) {
      return false;
    }

    const result = slot.result;

    // 1. Categorize composite result
    result.category = categorizeResult(result);

    // 2. Take measurements & feed back to generator
    this._prepareMeasures();
    const runnersToRecord: AbstractRunner[] = [];
    if (slot.worker) {
      runnersToRecord.push(slot.worker.runner);
      if (slot.worker.transformRunner) {
        runnersToRecord.push(slot.worker.transformRunner);
      }
      runnersToRecord.push(...slot.worker.propRunners);
    }
    if (
      this._userGenRunner &&
      slot.candidate.source.type === "generator" &&
      slot.candidate.source.generator === "UserInputGenerator"
    ) {
      runnersToRecord.push(this._userGenRunner);
    }

    for (const r of runnersToRecord) {
      if (r.lastRunCoverage) {
        this._measures.forEach((m) => {
          if (m instanceof AbstractCoverageMeasure) {
            m.recordHits(r.lastRunCoverage);
          }
        });
      }
    }

    const startMeasureFeedbackTime = performance.now();
    const measurements = this._measures.map((e) =>
      e.measure(slot.candidate!, result)
    );

    result.interestingReasons = this._compositeInputGenerator.onInputFeedback(
      measurements,
      result.timers.run + result.timers.gen,
      slot.candidate
    );
    const measureTime = performance.now() - startMeasureFeedbackTime;
    slot.measureTime = measureTime;

    // 3. Record stats and outcomes
    this._stats.record(
      result,
      slot.candidate,
      slot.valTime,
      measureTime,
      this._fuzzerFocus.mode
    );

    if (slot.injected) {
      this._injectedInFlight = Math.max(0, this._injectedInFlight - 1);
    }

    // 4. Cooperative shrinking step
    const modeBeforeShrink: FuzzerFocus["mode"] = this._fuzzerFocus.mode;
    this._shrink(result);
    const modeAfterShrink: FuzzerFocus["mode"] = this._fuzzerFocus.mode;
    const triggeredShrink =
      modeBeforeShrink === "gen" && modeAfterShrink === "shrink";

    // 5. Notify result callback
    if (onResultFn) {
      onResultFn(deepFreeze(result));
    }

    return triggeredShrink;
  } // fn: _stageMeasureAndRecord

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Initializes runners, compilers, and measures for the test run.
   */
  protected async _initRunners(
    injectTests: FuzzPinnedTest[],
    mode: FuzzMode,
    update: FuzzStatusUpdater,
    updateFn?: FuzzStatusUpdater
  ): Promise<void> {
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

    const workerCount =
      this._options.maxTests > 0
        ? Math.max(1, Math.min(this.workerCount, this._options.maxTests))
        : this.workerCount;

    this._userGenRunner = undefined;
    if (
      this.env.options.generators.UserInputGenerator?.enabled &&
      this.env.userGenerators.length
    ) {
      this._userGenRunner = RunnerFactory(
        this.env,
        targetMod,
        this.env.userGenerators[0].name
      );
    }

    this._workers = [];
    for (let i = 0; i < workerCount; i++) {
      const runner = RunnerFactory(
        this.env,
        targetMod,
        this._function.getName(),
        i === 0 ? { acceptsStaticCoverage: true } : {}
      );
      let transformRunner: AbstractRunner | undefined;
      if (this.env.options.useTransformer && this.env.transformers.length) {
        transformRunner = RunnerFactory(
          this.env,
          targetMod,
          this.env.transformers[0].name
        );
      }
      const propRunners = this._validators.map((vFnRef) =>
        RunnerFactory(this.env, targetMod, vFnRef.name)
      );
      const propertyOracle = new PropertyOracle(propRunners);
      this._workers.push({
        runner,
        transformRunner,
        propRunners,
        propertyOracle,
      });
    }

    const allRunnersToStart: Promise<void>[] = [];
    if (this._userGenRunner) {
      allRunnersToStart.push(this._userGenRunner.onRunStart());
    }
    for (const w of this._workers) {
      allRunnersToStart.push(w.runner.onRunStart());
      if (w.transformRunner) {
        allRunnersToStart.push(w.transformRunner.onRunStart());
      }
      for (const p of w.propRunners) {
        allRunnersToStart.push(p.onRunStart());
      }
    }
    await Promise.all(allRunnersToStart);

    this._compositeInputGenerator.onRunStart(
      Boolean(mode.gen),
      injectTests,
      this._workers[0]?.transformRunner,
      this._options.fnTimeout,
      this._options.maxDupeInputs,
      this._userGenRunner
    );

    const allRunners = [
      ...this._workers.flatMap((w) => [
        w.runner,
        w.transformRunner,
        ...w.propRunners,
      ]),
      this._userGenRunner,
    ].filter((r): r is AbstractRunner => r !== undefined);
    this._measures.forEach((m) => {
      m.onRunStart(allRunners, this.env);
    });

    this._injectMap = new Map(injectTests.map((t) => [getIoKey(t.input), t]));
  } // fn: _initRunners

  /**
   * Stops all active runner processes.
   */
  protected async _stopRunners(): Promise<void> {
    const allRunnersToStop: Promise<void>[] = [];
    if (this._userGenRunner) {
      allRunnersToStop.push(this._userGenRunner.onRunEnd());
    }
    for (const w of this._workers) {
      allRunnersToStop.push(w.runner.onRunEnd());
      if (w.transformRunner) {
        allRunnersToStop.push(w.transformRunner.onRunEnd());
      }
      for (const p of w.propRunners) {
        allRunnersToStop.push(p.onRunEnd());
      }
    }
    await Promise.all(allRunnersToStop);
  } // fn: _stopRunners

  /**
   * Prepares measures before execution of the PUT.
   */
  protected _prepareMeasures(): number {
    const startMeasTime = performance.now();
    this._measures.forEach((m) => {
      m.onBeforeNextTestExecution();
    });
    return performance.now() - startMeasTime;
  } // fn: _prepareMeasures

  /**
   * Evaluates stop conditions for Stage 1 input generation.
   */
  protected _shouldGenStop(
    injectCount: number,
    gen: boolean,
    userCancel: boolean
  ): FuzzStopReason | number {
    const injecting = this._stage1InjectedCount < injectCount;

    return this._stats.shouldStop(
      this._options,
      this._compositeInputGenerator.nextable() !== false,
      injecting,
      injectCount,
      userCancel,
      this._fuzzerFocus.mode,
      gen,
      {
        generated: this._compositeInputGenerator.inputsGenerated,
        dupes: this._compositeInputGenerator.dupesGenerated,
        sequentialDupes: this._compositeInputGenerator.dupesSequential,
      }
    );
  } // fn: _shouldGenStop

  /**
   * Calculates remaining time in the suite timeout.
   */
  protected _getRemainingSuiteTime(): number {
    const timeSinceGenStart =
      this._stats && this._stats.currentRun.timers.startGenTime > 0
        ? performance.now() - this._stats.currentRun.timers.startGenTime
        : 0;
    return this._options.suiteTimeout > 0 &&
      this._stats &&
      this._stats.currentRun.timers.startGenTime > 0
      ? Math.max(0, this._options.suiteTimeout - timeSinceGenStart)
      : Infinity;
  } // fn: _getRemainingSuiteTime

  /**
   * Creates an initial FuzzTestResult object for a candidate.
   */
  protected _createInitialResult(
    candidate: TransformedInputAndSource,
    genTime: number,
    transformTime: number = 0
  ): FuzzTestResult {
    const argDefs = this._function.getArgDefs();

    const result: FuzzTestResult = {
      pinned: false,
      inputGenerated: candidate,
      input: candidate.value.map((e, i) => {
        return {
          name: argDefs[i]?.getName() ?? "?",
          offset: i,
          value: e.value,
          origin: candidate.source,
        };
      }),
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
        gen: genTime,
        transform: transformTime,
      },
      category: "ok",
      interestingReasons: [],
    };

    if (candidate.injected) {
      const pinnedTest = this._injectMap.get(getIoKey(result.input));
      if (pinnedTest) {
        result.pinned = Boolean(pinnedTest.pinned);
        if (pinnedTest.expectedOutput) {
          result.expectedOutput = pinnedTest.expectedOutput;
        }
      }
    }

    return result;
  } // fn: _createInitialResult

  /**
   * Handles transformer error or skip results.
   */
  protected _handleTransformerResult(
    transformerResult: NonNullable<
      TransformedInputAndSource["transformerResult"]
    >,
    result: FuzzTestResult,
    transformerName: string = "transformer"
  ): void {
    const fnName = transformerName;
    switch (transformerResult.result.tag) {
      case "skip":
        result.skipped = true;
        result.skipReason = `(${fnName}) ${transformerResult.result.message}`;
        break;

      case "timeout":
        result.harnessErrors.push({
          kind: "timeout",
          stage: "transformer",
          fnName,
          message: `Timeout exceeding ${this._options.fnTimeout} ms`,
          display: `(${fnName} timeout)`,
        });
        break;

      case "error":
        result.harnessErrors.push({
          kind: "exception",
          stage: "transformer",
          fnName,
          message: transformerResult.result.message,
          display: `(${fnName} ${transformerResult.result.name}) ${transformerResult.result.message}`,
          stack: transformerResult.result.stack ?? "<no stack>",
        });
        break;

      case "value":
        break;
    }
  } // fn: _handleTransformerResult

  /**
   * Applies runner output to the test result object.
   */
  protected _applyRunnerOutput(
    exeOutput: RunnerResult,
    result: FuzzTestResult
  ): void {
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
  } // fn: _applyRunnerOutput

  /**
   * Evaluates Implicit, Example, and Property oracles.
   */
  protected async _evaluateOracles(
    result: FuzzTestResult,
    propertyOracle?: PropertyOracle,
    propRunners: AbstractRunner[] = [],
    cancelCheck?: () => boolean
  ): Promise<boolean> {
    // IMPLICIT ORACLE
    if (this._options.useImplicit) {
      result.passedImplicit = ImplicitOracle.judge(
        result.timeout,
        result.exception,
        this._function.isVoid(),
        result.output
      );
    }

    // EXAMPLE ORACLE
    if (this._options.useHuman && result.expectedOutput) {
      result.passedHuman = ExampleOracle.judge(
        result.timeout,
        result.exception,
        result.expectedOutput,
        result.output
      );
    }

    // PROPERTY ORACLE
    if (this._options.useProperty && propertyOracle && propRunners.length > 0) {
      let validatorJudgments: (Judgment | Error)[];
      try {
        validatorJudgments = await propertyOracle.judge(
          Object.freeze({
            in: result.input.map((i) => i.value),
            out:
              result.output.length === 0
                ? "timeout or exception"
                : result.output[0].value,
            exception: result.exception,
            timeout: result.timeout,
          }),
          Math.max(this._options.fnTimeout, 0),
          this._getRemainingSuiteTime(),
          cancelCheck
        );
      } catch (e: unknown) {
        if (isError(e) && e.message === "runnerInterrupted") {
          return false;
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

      result.passedValidator = PropertyOracle.summarize(
        result.passedValidators
      );
    }

    return true;
  } // fn: _evaluateOracles

  /**
   * Cooperative shrinking step.
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
   * Exits the shrinking mode and restores generator options.
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
   * Notifies status update callback.
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
      stats: this._stats.currentRun,
      pct,
      stillInjecting,
      isCancelled: Boolean(cancelFn && cancelFn()),
    });
  } // fn: _notify

  /**
   * Finalizes the fuzzing run and returns completed results.
   */
  protected async _finalizeRun(
    stopReason: FuzzStopReason,
    update: FuzzStatusUpdater,
    cancelFn?: () => boolean
  ): Promise<FuzzTestResults> {
    this._stats.currentRun.counters.inputsGenerated =
      this._compositeInputGenerator.inputsGenerated;
    this._stats.currentRun.counters.dupesGenerated =
      this._compositeInputGenerator.dupesGenerated;
    this._stats.currentRun.counters.dupesSequential =
      this._compositeInputGenerator.dupesSequential;

    const results = this._stats.finalize(stopReason);

    results.interesting.inputs =
      this._compositeInputGenerator.getInterestingInputs();

    this._measures.forEach((e) => {
      e.onRunEnd(results);
    });
    await this._compositeInputGenerator.onRunEnd(results);

    await this._stopRunners();

    update({
      type: "testing-complete",
      cancelled: Boolean(cancelFn && cancelFn()),
      pct: 100,
    });

    this._state = "paused";
    return results;
  } // fn: _finalizeRun
} // class: FuzzerV3

/**
 * Represents a single test candidate transitioning through pipeline stages.
 */
interface PipelineSlot {
  id: number;
  tick: number;

  // Generated Input
  candidate?: TransformedInputAndSource;
  genTime: number;
  injected: boolean;
  transformTime: number;

  // PUT Execution Output
  result?: FuzzTestResult;
  exeOutput?: RunnerResult;
  worker?: WorkerContext;
  runTime: number;
  coverageMeasurements?: BaseMeasurement[];

  // Validator & Oracle Output
  valTime: number;

  // Measure & Feedback Output
  measureTime: number;

  // Control flags
  isBubble?: boolean;
}

/**
 * Encapsulates the execution runners for an isolated worker pipeline.
 */
interface WorkerContext {
  runner: AbstractRunner;
  transformRunner?: AbstractRunner;
  propRunners: AbstractRunner[];
  propertyOracle?: PropertyOracle;
}
