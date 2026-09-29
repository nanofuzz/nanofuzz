import * as Config from "../../Config";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { Leaderboard } from "./Leaderboard";
import { ScoredInput } from "./Types";
import {
  FuzzOptions,
  FuzzPinnedTest,
  GetFuzzerFocusFn,
  InputAndSource,
} from "./../Types";
import { NextableStatus } from "./Types";
import { FunctionDef, FuzzTestResults, FuzzTestStats } from "../Fuzzer";
import { InputGeneratorFactory } from "./InputGeneratorFactory";
import { AbstractInputScheduler } from "../schedulers/AbstractInputScheduler";
import { SchedulerFactory } from "../schedulers/SchedulerFactory";
import { InputSchedulerType } from "../schedulers/Types";

/**
 * The Composite Input Generator subsumes multiple types of input generator and biases
 * its selection of which generator to use next based on subsumed generators' progress
 * toward certain measures, which the user weights according to their goals.
 *
 * Such self-adaptation is important because different input generator types have
 * different trade-offs, and these trade-offs may change throughout a testing session.
 * The primary advantage of such an arrangement is that the fuzzer can generate more
 * interesting inputs without relying on the user to decide which particular input
 * generator to use at any particular moment in time.
 *
 * Regardless of an input's generation source, inputs that make more progress toward
 * measures are tracked on a leaderboard, which subsumed input generators may use as
 * a source of interesting inputs to mutate.
 *
 * In the case where the Composite Input Generator is started with no subordinate
 * generators (e.g., it can only produce injected inputs), isAvailable() will return
 * false when the injected inputs are exhausted.
 */
export class CompositeInputGenerator extends AbstractInputGenerator {
  protected _subgens; // Subordinate input generators
  protected _activeSubgens: boolean[] = []; // boolean array of whether subgen is active
  protected _scheduler!: AbstractInputScheduler; // Subgenerator scheduler strategy
  protected _tick = 0; // Number of inputs generated
  protected _ticksLeftInChunk = 0; // Number of input generations remaining in this chunk
  protected _measures: AbstractMeasure[]; // Measures that provide feedback
  protected interestingInputs: ScoredInput[] = []; // List of interesting inputs
  protected _selectedSubgenIndex = -1; // Selected subordinate input generator
  protected _leaderboard; // Interesting inputs
  protected _lastInput?: InputAndSource; // Last input generated
  protected _L = 500; // Lookback window size for history
  protected _chunkSize = 20; // Re-evaluate subgen after _chunkSize inputs generated
  protected _P = 0.1; // Additional chance of subgen exploration
  protected _permitSubgens = true; // Allow generators to produce inputs
  protected _genStats: FuzzTestStats["generators"]; // Generator statistics
  protected _trackCheckpoints = false; // Track checkpoints for statistics
  protected _checkpoints: NonNullable<
    FuzzTestStats["generators"]["CompositeInputGenerator"]
  >["checkpoints"] = []; // status of subgens at selection
  protected _rngSeed?: string; // Seed for pseudo random number generator

  /**
   * Creates a new composite input generator, which subsumes multiple concrete input
   * generators (subgens) and selects which subgen to use next based on each subgen's
   * recent productivity relative to other subgens, as calculated by various measures.
   *
   * @param `options` generator options
   * @param `rngSeed` seed for pseudo random number generator
   * @param `subgens` array of concrete input generators to subsume
   * @param `measures` array of measures used to evaluate relative productivity of the subgens
   * @param `leaderboard` running list of "interesting" inputs, according to the measures
   */
  public constructor(
    options: FuzzOptions["generators"],
    fn: FunctionDef,
    rngSeed: string | undefined,
    measures: AbstractMeasure[],
    leaderboard: Leaderboard<InputAndSource>,
    genStats: FuzzTestStats["generators"],
    allInputs: Map<string, unknown>,
    moduleSrc: string,
    getFuzzerFocus?: GetFuzzerFocusFn
  ) {
    super([], rngSeed);

    this._rngSeed = rngSeed;
    this._subgens = InputGeneratorFactory(
      options,
      fn,
      rngSeed,
      leaderboard,
      genStats,
      allInputs,
      moduleSrc,
      getFuzzerFocus
    );
    this._measures = measures;
    this._leaderboard = leaderboard;
    this._genStats = genStats;

    this._loadConfig();

    this.options = options;
  } // fn: constructor

  /**
   * Loads any configurable parameters using `Config`.
   */
  protected _loadConfig(): void {
    const schedulerType = Config.get<InputSchedulerType>(
      "nanofuzz.generators.scheduler.impl",
      "mab"
    );
    this._L = Config.get<number>(
      "nanofuzz.generators.compositeLookbackWindow",
      500
    );
    this._chunkSize = Config.get<number>(
      "nanofuzz.generators.compositeChunkSize",
      20
    );
    this._P = Config.get<number>(
      "nanofuzz.generators.compositeExplorationChance",
      0.1
    );
    this._trackCheckpoints = Config.get<boolean>(
      "nanofuzz.generators.compositeTrackCheckpoints",
      false
    );

    if (!this._scheduler || this._scheduler.type !== schedulerType) {
      this._scheduler = SchedulerFactory.create(schedulerType, this._rngSeed);
      this._ticksLeftInChunk = 0;
    }
  } // fn: _loadConfig

  /**
   * Returns `now!`, `now`, or `soon` if further inputs may be produced, `false` otherwise.
   */
  public override nextable(): NextableStatus {
    let hasNow = false;
    let hasSoon = false;

    for (let i = 0; i < this._subgens.length; i++) {
      if (!this._activeSubgens[i]) {
        continue;
      }
      const status = this._subgens[i].nextable();
      if (status === "now!") {
        return "now!";
      }
      if (this._permitSubgens) {
        if (status === "now") {
          hasNow = true;
        } else if (status === "soon") {
          hasSoon = true;
        }
      }
    }

    if (hasNow) {
      return "now";
    }
    if (hasSoon) {
      return "soon";
    }
    return false;
  } // fn: isAvailable

  /**
   * Waits asynchronously until at least one input becomes available,
   * or until all pending generators finish or fail, or until `timeoutMs` elapses.
   *
   * @param `timeoutMs` optional max time to wait in ms
   */
  public async waitForNextInput(timeoutMs?: number): Promise<boolean> {
    const startTime = performance.now();
    while (this.nextable() === "soon") {
      if (timeoutMs !== undefined && timeoutMs > 0) {
        const elapsed = performance.now() - startTime;
        if (elapsed >= timeoutMs) {
          break;
        }
      }
      const pendingSubgens = this._subgens.filter(
        (g, i) => this._activeSubgens[i] && g.nextable() === "soon"
      );
      if (pendingSubgens.length > 0) {
        const remaining =
          timeoutMs !== undefined && timeoutMs > 0
            ? Math.max(0, timeoutMs - (performance.now() - startTime))
            : undefined;

        if (remaining !== undefined && remaining <= 0) {
          break;
        }

        const promises: Promise<unknown>[] = pendingSubgens.map((g) =>
          g.nextSoon().catch(() => {})
        );

        if (remaining !== undefined) {
          let timerId: NodeJS.Timeout;
          const timeoutPromise = new Promise<void>((resolve) => {
            timerId = setTimeout(resolve, remaining);
          });
          await Promise.race([...promises, timeoutPromise]);
          clearTimeout(timerId!);
        } else {
          await Promise.race(promises);
        }
      } else {
        break;
      }
    }
    const status = this.nextable();
    return status === "now" || status === "now!";
  } // fn: waitForNextInput

  /**
   * Suppress all input generators. Input injection
   * is unaffected.
   */
  public suppressGenerators(): void {
    this._permitSubgens = false;
  } // fn: suppressGenerators

  /**
   * Allow input generators to generate inputs.
   */
  public permitGenerators(): void {
    this._permitSubgens = true;
  } // fn: permitGenerators

  /**
   * Updates input generator options and enables/disables
   * input generators accordingly.
   */
  public set options(options: FuzzOptions["generators"]) {
    const _options: Record<string, typeof options.RandomInputGenerator> =
      options; // happify the type checker
    this._activeSubgens = this._subgens.map((m) =>
      m.name in _options ? _options[m.name].enabled : true
    );
  } // setter: options

  /**
   * Produces the next input
   *
   * @returns the next input, including its source metadata
   */
  public next(): InputAndSource {
    this._tick++;

    // If the prior chunk of generated inputs is exhausted or the
    // subgen is no longer available, start a new chunk and choose
    // the subgen for that chunk
    if (
      this._ticksLeftInChunk-- <= 1 ||
      !this._subgens[this._selectedSubgenIndex] ||
      !this._activeSubgens[this._selectedSubgenIndex] ||
      !(
        this._subgens[this._selectedSubgenIndex].nextable() === "now!" ||
        (this._permitSubgens &&
          this._subgens[this._selectedSubgenIndex].nextable() === "now")
      )
    ) {
      this._selectedSubgenIndex = this._selectNextSubGen();
    }

    // Generate and return the input
    this._lastInput = {
      ...this._subgens[this._selectedSubgenIndex].next(),
      tick: this._tick,
    };
    return structuredClone(this._lastInput);
  } // fn: next

  /**
   * Provide feedback to the composite input generator about the last input generated.
   *
   * Note: Requires that an input has already been generated.
   *
   * @param `measurements` array of measurements that correspond to this._measures
   * @param `cost` cost of generating and executing the input (e.g., ms)
   * @returns list of measures making the input interesting, if any
   */
  public onInputFeedback(
    measurements: BaseMeasurement[],
    cost: number
  ): string[] {
    // Ensure we actually generated something
    if (this._lastInput === undefined) {
      throw new Error("Input feedback provided prior to input generation");
    }

    // Ensure we have either no measures (e.g., input was a dupe not executed) or
    // a matching number of measures
    if (measurements.length && measurements.length !== this._measures.length) {
      throw new Error(
        `Number of feedback measures (${measurements.length}) differs from number of expected measures (${this._measures.length})`
      );
    }

    const interestingReasons: string[] = []; // list of measures finding this input interesing
    let weightedProgress = 0; // weighted progress of input, according to measures

    // Add progress and cost to the current subgen history
    measurements.forEach((measurement, m) => {
      const measure = this._measures[m]; // measure for this measurement

      // Fail if we receive a different measurement than expected
      if (measure.name !== measurement.name) {
        throw new Error(
          `Expected feedback for measure "${measure.name}" at offset ${String(
            m
          )} but received "${measurement.name}" instead.`
        );
      }

      // Calculate progress
      const delta = measure.delta(measurement);
      weightedProgress += delta * measure.weight;

      // If progress is reported by this measure, the input might be interesting
      if (delta) {
        interestingReasons.push(measure.name);
      }
    }); // foreach: measurements

    // Forward feedback to the scheduler if it needs feedback
    if (this._scheduler.needsFeedback) {
      this._scheduler.onInputFeedback(measurements, cost, this._measures);
    }

    // Update history of composite input generator if the input was interesting
    if (interestingReasons.length > 0) {
      this.interestingInputs.push({
        input: this._lastInput,
        tick: this._tick,
        score: weightedProgress,
        cost,
        measurements,
        interestingReasons,
      });
    }

    // Update leaderboard & last measured input if we have measures
    // (e.g., the input was not a dupe and was actually executed)
    //
    // If the input was added to the leaderboard, then return the
    // measures that contributed to its interestingness.
    if (
      measurements.length &&
      this._leaderboard.postScore(this._lastInput, weightedProgress)
    ) {
      return interestingReasons;
    } else {
      return [];
    }
  } // fn: onInputFeedback

  /**
   * Selects a subgen for the next chunk via the configured scheduler.
   * Priority inputs ("now!") bypass the scheduler and use a 1-tick chunk.
   *
   * @returns the index of the selected subgen
   */
  protected _selectNextSubGen(): number {
    // 1. High-priority inputs (e.g. pinned/human) always come first
    const priorityIdx = this._subgens.findIndex(
      (g, i) => this._activeSubgens[i] && g.nextable() === "now!"
    );
    if (priorityIdx !== -1) {
      this._ticksLeftInChunk = 1;
      return priorityIdx;
    }

    // 2. Guard: If priority is exhausted and autonomous generation is suppressed
    if (!this._permitSubgens) {
      throw new Error(
        "Injected inputs exhausted and input generators are suppressed."
      );
    }

    // 3. Reset standard chunk size for autonomous generation
    this._ticksLeftInChunk = this._chunkSize;

    // 4. Delegate subgenerator selection to the scheduler
    const selectedIdx = this._scheduler.next({
      tick: this._tick,
      subgens: this._subgens,
      activeSubgens: this._activeSubgens,
      measures: this._measures,
    });

    if (this._trackCheckpoints) {
      const checkpointGens: NonNullable<
        FuzzTestStats["generators"]["CompositeInputGenerator"]
      >["checkpoints"][number]["gens"] = {};

      this._subgens.forEach((subgen, g) => {
        const metrics = this._scheduler.getSubgenMetrics(g);
        checkpointGens[subgen.name] = {
          active: !!this._activeSubgens[g],
          nextable: subgen.nextable(),
          productivity: metrics.productivity,
          cost: metrics.cost,
        };
      });
      checkpointGens[this._subgens[selectedIdx].name].selected = true;

      this._checkpoints.push({
        tick: this._tick,
        gens: checkpointGens,
        scheduler: this._scheduler.type,
      });
    }

    return selectedIdx;
  } // fn: _selectNextSubGen

  /**
   * Return interesting inputs, their sources, and their measures
   *
   * @returns interesting inputs
   */
  public getInterestingInputs(): ScoredInput[] {
    return this.interestingInputs.map((i) => {
      return { ...i };
    });
  } // fn: getInterestingInputs

  /**
   * Startup when the test run begins
   */
  public override onRunStart(
    gen: boolean,
    injectedInputs?: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[]
  ): void {
    this._loadConfig();
    this._scheduler.onRunStart();
    this._leaderboard.loadConfig();
    for (const subgen in this._subgens) {
      this._subgens[subgen].onRunStart(
        gen && this._activeSubgens[subgen],
        injectedInputs
      );
    }
  } // fn: onRun

  /**
   * Cleanup all subgens and update stats when the test run ends
   */
  public async onRunEnd(results?: FuzzTestResults): Promise<void> {
    await super.onRunEnd(results);
    await Promise.all(this._subgens.map((g) => g.onRunEnd(results)));
    this._scheduler.onRunEnd(results);
    if (results) {
      results.stats.generators.CompositeInputGenerator = {
        config: {
          lookbackWindow: this._L,
          chunkSize: this._chunkSize,
          explorationChance: this._P,
          initialFocus: this._leaderboard.initialFocus,
          focusDecay: this._leaderboard.focusDecay,
        },
        checkpoints: this._checkpoints,
      };
    }
  } // fn: onRunEnd

  /**
   * Returns the active subgenerator scheduler
   */
  public get scheduler(): AbstractInputScheduler {
    return this._scheduler;
  } // property: get scheduler

  /**
   * Returns active subgenerators currently pending ("soon").
   */
  public getPendingGenerators(): AbstractInputGenerator[] {
    if (!this._permitSubgens) {
      return [];
    }
    return this._subgens.filter(
      (g, i) => this._activeSubgens[i] && g.nextable() === "soon"
    );
  }

  /**
   * Returns human-readable names of active subgenerators currently pending ("soon").
   */
  public getPendingGeneratorNames(): string[] {
    return this.getPendingGenerators().map((g) => g.humanName);
  }

  /**
   * Returns diagnostic messages from composite input generator and active subgens.
   */
  public override getDiagnostics(): string[] {
    const diagnostics: string[] = [];

    // Warn if all subgens are inactive
    const hasActiveSubgens = this._activeSubgens.some((active) => active);
    if (!hasActiveSubgens) {
      return ["All input generators were disabled by user options."];
    }

    // Return diagnostics from active subgens
    this._subgens.forEach((subgen, i) => {
      if (this._activeSubgens[i]) {
        diagnostics.push(
          ...subgen.getDiagnostics().map((m) => `[${subgen.humanName}] ${m}`)
        );
      }
    });

    return diagnostics;
  } // fn: getDiagnostics
} // class: CompositeInputGenerator
