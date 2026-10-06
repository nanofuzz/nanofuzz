import { getToolVersion } from "../ToolVersion";
import { FunctionDef } from "./analysis/FunctionDef";
import { FunctionRef } from "./analysis/Types";
import {
  CurrentRunStats,
  FuzzOptions,
  FuzzResultCategoryValues,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
  TransformedInputAndSource,
} from "./Types";

/**
 * FuzzStats manages metrics, timers, counters, outcome tallies,
 * and stop condition evaluation for a fuzz testing session.
 */
export class FuzzStats {
  protected _options: FuzzOptions;
  protected _function: FunctionDef;
  protected _validators: FunctionRef[];
  protected _transformers: FunctionRef[];
  protected _results: FuzzTestResults;
  protected _currentRun: CurrentRunStats;
  protected _startGenTime = 0;
  protected _startTime = 0;

  public constructor(
    options: FuzzOptions,
    fnDef: FunctionDef,
    validators: FunctionRef[],
    transformers: FunctionRef[] = []
  ) {
    this._options = options;
    this._function = fnDef;
    this._validators = validators;
    this._transformers = transformers;
    this._results = this._getInitializedResults();
    this._currentRun = this._getInitializedRunStats();
  } // fn: constructor

  public get results(): FuzzTestResults {
    return this._results;
  } // get: results

  public set options(options: FuzzOptions) {
    this._options = options;
    this._results.env.options = structuredClone(options);
  } // set: options

  public get currentRun(): CurrentRunStats {
    return this._currentRun;
  } // get: currentRun

  public get startGenTime(): number {
    return this._startGenTime;
  } // get: startGenTime

  public startRun(): void {
    this._startTime = performance.now();
    this._startGenTime = 0;
    this._currentRun = this._getInitializedRunStats();
    this._currentRun.timers.startTime = this._startTime;
    this._results.stats.counters.testingRuns++;
  } // fn: startRun

  public markGenStarted(timestamp: number = performance.now()): void {
    if (this._startGenTime === 0) {
      this._startGenTime = timestamp;
      this._currentRun.timers.startGenTime = timestamp;
    }
  } // fn: markGenStarted

  /**
   * Records a single test execution result into the statistics accumulators.
   *
   * @param result the fuzz test result
   * @param candidate the input and source metadata
   * @param valTime validation time in ms
   * @param measureTime measurement time in ms
   * @param fuzzerMode "gen" or "shrink"
   */
  public record(
    result: FuzzTestResult,
    candidate: TransformedInputAndSource,
    valTime: number = 0,
    measureTime: number = 0,
    _fuzzerMode: "gen" | "shrink" = "gen"
  ): void {
    // 1. Accumulate Global Timers
    this._results.stats.timers.put += result.timers.run;
    this._results.stats.timers.val += valTime;
    this._results.stats.timers.gen += result.timers.gen;
    this._results.stats.timers.measure += measureTime;
    if (result.timers.transform) {
      this._results.stats.timers.transform += result.timers.transform;
    }

    // 2. Accumulate Sub-Generator Timers
    if (candidate.source.type === "generator") {
      const genStats =
        this._results.stats.generators[candidate.source.generator];
      if (genStats) {
        genStats.timers.gen += result.timers.gen;
        genStats.timers.run += result.timers.run;
        genStats.timers.val += valTime;
        genStats.timers.measure += measureTime;
        if (result.timers.transform) {
          genStats.timers.transform += result.timers.transform;
        }
      }
    }

    // 3. Counter attribution
    if (candidate.injected) {
      this._currentRun.counters.inputsInjected++;
    }

    // 4. Update Outcomes & Category Bins
    if (result.category !== "skip") {
      this._currentRun.outcomes.total++;
    }
    this._currentRun.outcomes.categories[result.category]++;
    if (result.exception) {
      this._currentRun.outcomes.exceptions++;
    }
    if (result.timeout) {
      this._currentRun.outcomes.timeouts++;
    }

    if (result.passedImplicit in this._currentRun.outcomes.oracles.heuristic) {
      this._currentRun.outcomes.oracles.heuristic[result.passedImplicit]++;
    }
    if (result.passedHuman in this._currentRun.outcomes.oracles.human) {
      this._currentRun.outcomes.oracles.human[result.passedHuman]++;
    }
    if (result.passedValidator in this._currentRun.outcomes.oracles.property) {
      this._currentRun.outcomes.oracles.property[result.passedValidator]++;
    }

    switch (result.category) {
      case "ok":
        this._currentRun.counters.passedTests++;
        break;
      case "skip":
        this._currentRun.counters.inputsSkipped++;
        break;
      case "failure":
      case "disagree":
        this._currentRun.counters.erroredTests++;
        break;
      case "badValue":
      case "timeout":
      case "exception":
        this._currentRun.counters.failedTests++;
        break;
    }

    // Track first failing test
    if (
      !this._currentRun.outcomes.firstFailure &&
      result.category !== "ok" &&
      result.category !== "skip"
    ) {
      this._currentRun.outcomes.firstFailure = result;
    }

    // 5. Result retention policy
    const retention = this._options.outputResults ?? "all";
    const shouldRetain =
      retention === "all" ||
      Boolean(candidate.injected) ||
      (retention === "failures" &&
        result.category !== "ok" &&
        result.category !== "skip");

    if (shouldRetain) {
      this._results.results.push(result);
    }
  } // fn: record

  /**
   * Checks whether testing should stop based on suite timeout, max tests,
   * max failures, max duplicates, user cancellation, or input exhaustion.
   *
   * @returns FuzzStopReason if testing should stop, or a number 0..100 representing percentage complete
   */
  public shouldStop(
    options: FuzzOptions,
    moreInputs: boolean,
    injecting: boolean,
    injectCount: number,
    userCancel: boolean,
    fuzzerFocusMode: "gen" | "shrink",
    gen: boolean,
    dupeStats: { generated: number; dupes: number; sequentialDupes: number }
  ): FuzzStopReason | number {
    this._currentRun.counters.inputsGenerated = dupeStats.generated;
    this._currentRun.counters.dupesGenerated = dupeStats.dupes;
    this._currentRun.counters.dupesSequential = dupeStats.sequentialDupes;

    let maxPct = 0;
    const now = performance.now();

    // End testing if the user cancels (unless still injecting pinned inputs)
    if (userCancel && !injecting) {
      return FuzzStopReason.PAUSE;
    }

    // Suite Timeout: measured from the time of the first generated input
    if (options.suiteTimeout > 0 && this._currentRun.timers.startGenTime > 0) {
      const elapsed = now - this._currentRun.timers.startGenTime;
      if (elapsed >= options.suiteTimeout) {
        return FuzzStopReason.MAXTIME;
      }
      const timePct = elapsed / options.suiteTimeout;
      if (timePct > maxPct) maxPct = timePct;
    }

    // Max Tests limit
    const executedNonInjected = gen
      ? this._currentRun.counters.inputsGenerated -
        this._currentRun.counters.dupesGenerated -
        this._currentRun.counters.inputsSkipped
      : 0;
    const totalInputsCount =
      this._currentRun.counters.inputsInjected + executedNonInjected;
    const targetCount = injectCount + (gen ? options.maxTests : 0);

    if (totalInputsCount >= targetCount) {
      return FuzzStopReason.MAXTESTS;
    }
    if (targetCount > 0) {
      const testsPct = totalInputsCount / targetCount;
      if (testsPct > maxPct) maxPct = testsPct;
    }

    // Max Failures limit (inactive during injection or shrinking)
    if (options.maxFailures > 0 && !injecting && fuzzerFocusMode !== "shrink") {
      const totalFailures =
        this._currentRun.counters.failedTests +
        this._currentRun.counters.erroredTests;
      if (totalFailures >= options.maxFailures) {
        return FuzzStopReason.MAXFAILURES;
      }
      const failuresPct = totalFailures / options.maxFailures;
      if (failuresPct > maxPct) maxPct = failuresPct;
    }

    // Max Sequential Duplicates
    if (this._currentRun.counters.dupesSequential >= options.maxDupeInputs) {
      return FuzzStopReason.MAXDUPES;
    }

    // Input exhaustion
    if (!moreInputs) {
      return FuzzStopReason.NOMOREINPUTS;
    }

    return Math.max(0, Math.floor(maxPct * 100));
  } // fn: shouldStop

  /**
   * Finalizes the test run by merging current run stats into the overall results.
   *
   * @param stopReason the reason testing stopped
   * @returns the finalized FuzzTestResults
   */
  public finalize(stopReason: FuzzStopReason): FuzzTestResults {
    this._results.stopReason = stopReason;
    this._results.stats.timers.total +=
      performance.now() - this._currentRun.timers.startTime;

    this._results.stats.counters.inputsGenerated +=
      this._currentRun.counters.inputsGenerated;
    this._results.stats.counters.dupesGenerated +=
      this._currentRun.counters.dupesGenerated;
    this._results.stats.counters.inputsInjected +=
      this._currentRun.counters.inputsInjected;
    this._results.stats.counters.erroredTests +=
      this._currentRun.counters.erroredTests;
    this._results.stats.counters.passedTests +=
      this._currentRun.counters.passedTests;
    this._results.stats.counters.inputsSkipped +=
      this._currentRun.counters.inputsSkipped;
    this._results.stats.counters.failedTests +=
      this._currentRun.counters.failedTests;

    this._results.stats.outcomes.total += this._currentRun.outcomes.total;
    this._results.stats.outcomes.exceptions +=
      this._currentRun.outcomes.exceptions;
    this._results.stats.outcomes.timeouts += this._currentRun.outcomes.timeouts;

    for (const cat of FuzzResultCategoryValues) {
      this._results.stats.outcomes.categories[cat] +=
        this._currentRun.outcomes.categories[cat];
    }
    for (const j of ["pass", "fail", "unknown"] as const) {
      this._results.stats.outcomes.oracles.heuristic[j] +=
        this._currentRun.outcomes.oracles.heuristic[j];
      this._results.stats.outcomes.oracles.human[j] +=
        this._currentRun.outcomes.oracles.human[j];
      this._results.stats.outcomes.oracles.property[j] +=
        this._currentRun.outcomes.oracles.property[j];
    }
    if (
      !this._results.stats.outcomes.firstFailure &&
      this._currentRun.outcomes.firstFailure
    ) {
      this._results.stats.outcomes.firstFailure =
        this._currentRun.outcomes.firstFailure;
    }

    return this._results;
  } // fn: finalize

  /**
   * Retrieves an initialized FuzzTestResults object with default values.
   *
   * @returns The initialized FuzzTestResults object.
   */
  protected _getInitializedResults(): FuzzTestResults {
    return {
      toolVersion: getToolVersion(),
      env: {
        options: structuredClone(this._options),
        function: this._function,
        validators: structuredClone(this._validators),
        transformers: structuredClone(this._transformers),
      },
      stopReason: FuzzStopReason.CRASH,
      stats: {
        timers: {
          total: 0,
          put: 0,
          val: 0,
          gen: 0,
          measure: 0,
          compile: 0,
          instrument: 0,
          transform: 0,
        },
        counters: {
          testingRuns: 0,
          inputsGenerated: 0,
          dupesGenerated: 0,
          inputsInjected: 0,
          passedTests: 0,
          erroredTests: 0,
          inputsSkipped: 0,
          failedTests: 0,
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
            timers: { gen: 0, run: 0, val: 0, measure: 0, transform: 0 },
            counters: { dupesGenerated: 0, inputsGenerated: 0, dupeTicks: [] },
          },
          MutationInputGenerator: {
            timers: { gen: 0, run: 0, val: 0, measure: 0, transform: 0 },
            counters: { dupesGenerated: 0, inputsGenerated: 0, dupeTicks: [] },
          },
          AiInputGenerator: {
            timers: { gen: 0, run: 0, val: 0, measure: 0, transform: 0 },
            counters: { dupesGenerated: 0, inputsGenerated: 0, dupeTicks: [] },
          },
        },
        measures: {},
      },
      interesting: {
        inputs: [],
      },
      results: [],
    };
  } // fn: _getInitializedResults

  /**
   * Retrieves an initialized CurrentRunStats object with default values.
   *
   * @returns The initialized CurrentRunStats object.
   */
  protected _getInitializedRunStats(): CurrentRunStats {
    return {
      counters: {
        inputsInjected: 0,
        inputsGenerated: 0,
        dupesGenerated: 0,
        dupesSequential: 0,
        erroredTests: 0,
        failedTests: 0,
        passedTests: 0,
        inputsSkipped: 0,
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
        startTime: performance.now(),
        startGenTime: 0,
      },
    };
  } // fn: _getInitializedRunStats
} // class: FuzzStats
