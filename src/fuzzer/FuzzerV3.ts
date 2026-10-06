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
  getValidators,
  isArgValueType,
  isOptionValid,
} from "./analysis/Util";
import { MeasureFactory } from "./measures/MeasureFactory";
import { RunnerFactory } from "./runners/RunnerFactory";
import { Leaderboard } from "./generators/Leaderboard";
import { categorizeResult, getIoKey, isError, isSameJudgments } from "./Util";
import { PropertyOracle } from "./oracles/PropertyOracle";
import { ImplicitOracle } from "./oracles/ImplicitOracle";
import { ExampleOracle } from "./oracles/ExampleOracle";
import { Judgment } from "./oracles/Types";
import { AbstractProgram } from "./analysis/AbstractProgram";
import { AbstractRunner, RunnerResult } from "./runners/AbstractRunner";
import { AbstractMeasure, BaseMeasurement } from "./measures/AbstractMeasure";
import { FailedTestMeasure } from "./measures/FailedTestMeasure";
import { CompilerStaleness } from "./compilers/Types";
import { FuzzStats } from "./FuzzStats";

/**
 * Represents a single test candidate transitioning through the 5 pipeline stages.
 */
export interface PipelineSlot {
  id: number;
  tick: number;

  // Stage 1: Generated Input
  candidate?: TransformedInputAndSource;
  genTime: number;
  injected: boolean;

  // Stage 2: Transformer Output
  transformedCandidate?: TransformedInputAndSource;
  transformTime: number;

  // Stage 3: PUT Execution Output
  result?: FuzzTestResult;
  exeOutput?: RunnerResult;
  runTime: number;
  coverageMeasurements?: BaseMeasurement[];

  // Stage 4: Validator & Oracle Output
  valTime: number;

  // Stage 5: Measure & Feedback Output
  measureTime: number;

  // Control flags
  isBubble?: boolean;
}

/**
 * FuzzerV3 is a lockstep 5-stage pipelined fuzzer engine.
 * On every tick, it executes all active pipeline stages concurrently:
 *  - Stage 1: Fetch / Generate Input N+4
 *  - Stage 2: Transform Input N+3
 *  - Stage 3: Execute PUT N+2
 *  - Stage 4: Validate / Oracles N+1
 *  - Stage 5: Measure, Record & Feedback N
 */
export class FuzzerV3 {
  protected _module: string;
  protected _fnName: string;
  protected _options: FuzzOptions;
  protected _program: AbstractProgram;
  protected _function: FunctionDef;
  protected _validators: FunctionRef[] = [];
  protected _transformers: FunctionRef[] = [];
  protected _measures: AbstractMeasure[];
  protected _leaderboard = new Leaderboard<InputAndSource>();
  protected _allInputs: Map<string, unknown> = new Map();
  protected _state: "init" | "ready" | "running" | "paused" | "crashed" =
    "init";

  protected _compositeInputGenerator: CompositeInputGenerator;
  protected _runner?: AbstractRunner;
  protected _transformRunner?: AbstractRunner;
  protected _propRunners: AbstractRunner[] = [];
  protected _propertyOracle?: PropertyOracle;
  protected _injectMap: Map<string, FuzzPinnedTest> = new Map();
  protected _stats: FuzzStats;
  protected _lastCompiler?: ReturnType<
    (typeof CompilerFactory)["fromSourcefile"]
  >;
  protected _slotSeq = 0;
  protected _stage1InjectedCount = 0;

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
      this._transformers
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
    };
  } // get: env

  /**
   * Retrieves the current state of the fuzzer.
   */
  public get state(): typeof this._state {
    return this._state;
  } // fn: state

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

    // Pipeline Registers holding slots between ticks:
    // s1: Output of Stage 1 (ready for Stage 2)
    // s2: Output of Stage 2 (ready for Stage 3)
    // s3: Output of Stage 3 (ready for Stage 4)
    // s4: Output of Stage 4 (ready for Stage 5)
    let s1: PipelineSlot | undefined = undefined;
    let s2: PipelineSlot | undefined = undefined;
    let s3: PipelineSlot | undefined = undefined;
    let s4: PipelineSlot | undefined = undefined;

    let isGenActive = true;
    let finalStopReason: FuzzStopReason | undefined = undefined;

    try {
      this._state = "running";

      while (isGenActive || s1 || s2 || s3 || s4) {
        checkPeriodicUpdate();

        const stopCondition = this._shouldGenStop(
          injectTests.length,
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
            if (
              stopCondition === FuzzStopReason.PAUSE ||
              stopCondition === FuzzStopReason.MAXTIME ||
              stopCondition === FuzzStopReason.MAXFAILURES
            ) {
              s1 = undefined;
              s2 = undefined;
              s3 = undefined;
              s4 = undefined;
              break;
            }
          }
        }

        const stillInjecting = this._stage1InjectedCount < injectTests.length;

        // Snapshot current inputs to stages for this tick
        const currentS1Input: boolean = isGenActive;
        const currentS2Input: PipelineSlot | undefined = s1;
        const currentS3Input: PipelineSlot | undefined = s2;
        const currentS4Input: PipelineSlot | undefined = s3;
        const currentS5Input: PipelineSlot | undefined = s4;

        // Execute all 5 discrete stages concurrently in parallel for this tick
        const [outS1, outS2, outS3, outS4, outS5]: [
          PipelineSlot | undefined,
          PipelineSlot | undefined,
          PipelineSlot | undefined,
          PipelineSlot | undefined,
          { triggeredShrink: boolean } | undefined,
        ] = await Promise.all([
          currentS1Input
            ? this._stage1FetchAndGen(
                update,
                cancelFn,
                stillInjecting,
                stopCondition
              )
            : Promise.resolve(undefined),
          currentS2Input
            ? this._stage2Transform(currentS2Input, cancelFn)
            : Promise.resolve(undefined),
          currentS3Input
            ? this._stage3ExecutePUT(currentS3Input, cancelFn)
            : Promise.resolve(undefined),
          currentS4Input
            ? this._stage4Validate(currentS4Input, cancelFn)
            : Promise.resolve(undefined),
          currentS5Input
            ? this._stage5MeasureAndRecord(currentS5Input, onResultFn)
            : Promise.resolve(undefined),
        ]);

        // Handle Pipeline Flush if Stage 5 triggered cooperative shrinking
        if (outS5?.triggeredShrink) {
          s1 = undefined;
          s2 = undefined;
          s3 = undefined;
          s4 = undefined;
          isGenActive = true;
          continue;
        }

        // Advance pipeline registers to next stage
        s1 = outS1;
        s2 = outS2;
        s3 = outS3;
        s4 = outS4;
      }

      return await this._finalizeRun(
        finalStopReason ?? FuzzStopReason.NOMOREINPUTS,
        update,
        cancelFn
      );
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
      update({
        type: "waiting-for-generator",
        pendingGenerators:
          this._compositeInputGenerator.getPendingGeneratorNames(),
        stats: this._stats.currentRun,
        pct: typeof stopCondition === "number" ? stopCondition : 0,
      });
      await this._compositeInputGenerator.waitForNextInput(remainingTimeout);
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
   * STAGE 2: Transform Input (N+3)
   */
  protected async _stage2Transform(
    slot: PipelineSlot,
    _cancelFn?: () => boolean
  ): Promise<PipelineSlot> {
    if (!slot || slot.isBubble || !slot.candidate) {
      return slot;
    }

    // Injected inputs or already transformed candidates pass through
    slot.transformedCandidate = slot.candidate;
    return slot;
  } // fn: _stage2Transform

  /**
   * STAGE 3: Execute PUT (N+2)
   */
  protected async _stage3ExecutePUT(
    slot: PipelineSlot,
    cancelFn?: () => boolean
  ): Promise<PipelineSlot> {
    if (!slot || !slot.transformedCandidate || !this._runner) {
      return slot;
    }

    const result = this._createInitialResult(
      slot.transformedCandidate,
      slot.genTime,
      slot.transformTime
    );

    if (slot.transformedCandidate.transformerResult && this._transformRunner) {
      this._handleTransformerResult(
        slot.transformedCandidate.transformerResult,
        result
      );
    }

    if (slot.isBubble || result.skipped || result.harnessErrors.length > 0) {
      slot.result = result;
      return slot;
    }

    this._prepareMeasures();

    const startRunTime = performance.now();
    let exeOutput: RunnerResult;
    try {
      const cancelCheck = cancelFn && !slot.injected ? cancelFn : undefined;
      exeOutput = await this._runner.runWithInterrupt(
        () =>
          this._runner!.run(
            result.input.map((e) => e.value),
            Math.max(this._options.fnTimeout, 0)
          ),
        this._getRemainingSuiteTime(),
        cancelCheck
      );
    } catch (e: unknown) {
      if (isError(e) && e.message === "runnerInterrupted") {
        slot.isBubble = true;
        slot.result = result;
        return slot;
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
    slot.result = result;
    slot.exeOutput = exeOutput;

    // Snapshot coverage measures immediately while coverage data is fresh
    slot.coverageMeasurements = this._measures
      .filter((m) => !(m instanceof FailedTestMeasure))
      .map((m) => m.measure(slot.transformedCandidate!, result));

    return slot;
  } // fn: _stage3ExecutePUT

  /**
   * STAGE 4: Validate / Oracles (N+1)
   */
  protected async _stage4Validate(
    slot: PipelineSlot,
    cancelFn?: () => boolean
  ): Promise<PipelineSlot> {
    if (!slot || !slot.result) {
      return slot;
    }

    if (
      slot.isBubble ||
      slot.result.skipped ||
      slot.result.harnessErrors.length > 0
    ) {
      return slot;
    }

    const startValTime = performance.now();
    const cancelCheck = cancelFn && !slot.injected ? cancelFn : undefined;
    const oracleSuccess = await this._evaluateOracles(slot.result, cancelCheck);
    if (!oracleSuccess) {
      slot.isBubble = true;
    }
    slot.valTime = performance.now() - startValTime;
    return slot;
  } // fn: _stage4Validate

  /**
   * STAGE 5: Measure, Record & Feedback (N)
   */
  protected async _stage5MeasureAndRecord(
    slot: PipelineSlot,
    onResultFn?: FuzzResultCallback
  ): Promise<{ triggeredShrink: boolean } | undefined> {
    if (!slot || !slot.result || !slot.transformedCandidate) {
      return undefined;
    }

    const result = slot.result;

    // 1. Categorize composite result
    result.category = categorizeResult(result);

    // 2. Take measurements & feed back to generator
    const startMeasureFeedbackTime = performance.now();
    const measurements =
      slot.coverageMeasurements !== undefined
        ? [
            ...slot.coverageMeasurements,
            ...this._measures
              .filter((m) => m instanceof FailedTestMeasure)
              .map((e) => e.measure(slot.transformedCandidate!, result)),
          ]
        : this._measures.map((e) =>
            e.measure(slot.transformedCandidate!, result)
          );

    result.interestingReasons = this._compositeInputGenerator.onInputFeedback(
      measurements,
      result.timers.run + result.timers.gen,
      slot.transformedCandidate
    );
    const measureTime = performance.now() - startMeasureFeedbackTime;
    slot.measureTime = measureTime;

    // 3. Record stats and outcomes
    this._stats.record(
      result,
      slot.transformedCandidate,
      slot.valTime,
      measureTime,
      this._fuzzerFocus.mode
    );

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

    return { triggeredShrink };
  } // fn: _stage5MeasureAndRecord

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

    this._runner = RunnerFactory(this.env, targetMod, this._function.getName());
    await this._runner.onRunStart();

    if (this.env.options.useTransformer && this.env.transformers.length) {
      this._transformRunner = RunnerFactory(
        this.env,
        targetMod,
        this.env.transformers[0].name
      );
      await this._transformRunner.onRunStart();
    } else {
      this._transformRunner = undefined;
    }

    this._compositeInputGenerator.onRunStart(
      Boolean(mode.gen),
      injectTests,
      this._transformRunner,
      this._options.fnTimeout,
      this._options.maxDupeInputs
    );

    this._propRunners = this._validators.map((vFnRef) =>
      RunnerFactory(this.env, targetMod, vFnRef.name)
    );
    await Promise.all(this._propRunners.map((p) => p.onRunStart()));
    this._propertyOracle = new PropertyOracle(this._propRunners);

    const allRunners = [
      this._runner,
      this._transformRunner,
      ...this._propRunners,
    ].filter((r): r is AbstractRunner => r !== undefined);
    this._measures.forEach((m) => {
      m.onRunStart(allRunners);
    });

    this._injectMap = new Map(injectTests.map((t) => [getIoKey(t.input), t]));
  } // fn: _initRunners

  /**
   * Stops all active runner processes.
   */
  protected async _stopRunners(): Promise<void> {
    const allRunners = [
      this._runner,
      this._transformRunner,
      ...this._propRunners,
    ].filter((r): r is AbstractRunner => r !== undefined);
    await Promise.all(allRunners.map((r) => r.onRunEnd()));
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
    this._stats.currentRun.counters.inputsGenerated =
      this._compositeInputGenerator.inputsGenerated;
    this._stats.currentRun.counters.dupesGenerated =
      this._compositeInputGenerator.dupesGenerated;
    this._stats.currentRun.counters.dupesSequential =
      this._compositeInputGenerator.dupesSequential;

    const injecting = this._stage1InjectedCount < injectCount;

    // End testing if the user cancels (unless still injecting pinned inputs)
    if (userCancel && !injecting) {
      return FuzzStopReason.PAUSE;
    }

    // Suite Timeout: measured from the time of the first generated input
    if (this._options.suiteTimeout > 0 && this._stats.startGenTime > 0) {
      const elapsed = performance.now() - this._stats.startGenTime;
      if (elapsed >= this._options.suiteTimeout) {
        return FuzzStopReason.MAXTIME;
      }
    }

    // Max Failures limit (inactive during injection or shrinking)
    if (
      this._options.maxFailures > 0 &&
      !injecting &&
      this._fuzzerFocus.mode !== "shrink"
    ) {
      const totalFailures =
        this._stats.currentRun.counters.failedTests +
        this._stats.currentRun.counters.erroredTests;
      if (totalFailures >= this._options.maxFailures) {
        return FuzzStopReason.MAXFAILURES;
      }
    }

    // Max Sequential Duplicates
    if (
      this._compositeInputGenerator.dupesSequential >=
      this._options.maxDupeInputs
    ) {
      return FuzzStopReason.MAXDUPES;
    }

    // Max Tests limit
    const executedNonInjected = gen
      ? this._compositeInputGenerator.inputsGenerated -
        this._compositeInputGenerator.dupesGenerated
      : 0;
    const totalGenerated = this._stage1InjectedCount + executedNonInjected;
    const targetCount = injectCount + (gen ? this._options.maxTests : 0);

    if (totalGenerated >= targetCount) {
      return FuzzStopReason.MAXTESTS;
    }

    // Input exhaustion
    if (!injecting && this._compositeInputGenerator.nextable() === false) {
      return FuzzStopReason.NOMOREINPUTS;
    }

    let maxPct = 0;
    if (targetCount > 0) {
      maxPct = Math.max(maxPct, totalGenerated / targetCount);
    }
    if (this._options.suiteTimeout > 0 && this._stats.startGenTime > 0) {
      maxPct = Math.max(
        maxPct,
        (performance.now() - this._stats.startGenTime) /
          this._options.suiteTimeout
      );
    }

    return Math.max(0, Math.floor(maxPct * 100));
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
    result: FuzzTestResult
  ): void {
    const fnName = this._transformRunner?.name ?? "transformer";
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
    if (
      this._options.useProperty &&
      this._propertyOracle &&
      this._propRunners.length > 0
    ) {
      let validatorJudgments: (Judgment | Error)[];
      try {
        validatorJudgments = await this._propertyOracle.judge(
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
