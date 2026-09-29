import * as Config from "../../Config";
import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { Leaderboard } from "./Leaderboard";
import { ScoredInput } from "./Types";
import {
  FuzzOptions,
  FuzzPinnedTest,
  FuzzStopReason,
  GetFuzzerFocusFn,
  InputAndSource,
  TransformedInputAndSource,
} from "./../Types";
import { NextableStatus } from "./Types";
import { FunctionDef, FuzzTestResults, FuzzTestStats } from "../Fuzzer";
import { InputGeneratorFactory } from "./InputGeneratorFactory";
import { AbstractRunner, RunnerResult } from "../runners/AbstractRunner";
import * as ValueMapper from "../mappers/ValueMapper";
import * as JSONN from "../../Jsonn";

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
  protected _tick = 0; // Number of inputs generated
  protected _ticksLeftInChunk = 0; // Number of input generations remaining in this chunk
  protected _measures: AbstractMeasure[]; // Measures that provide feedback
  protected _history: {
    progress: (number | undefined)[][]; // progress by measure and input tick (of L)
    cost: (number | undefined)[]; // cost by input tick (of L)
    currentIndex: number; // current index (of L) into last dimension of progress and cost
  }[] = []; // history for each input generator
  protected interestingInputs: ScoredInput[] = []; // List of interesting inputs
  protected _selectedSubgenIndex = -1; // Selected subordinate input generator (e.g., by efficiency)
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
  protected _fn: FunctionDef; // Target function
  protected _allInputs: Map<string, unknown>; // Hashed inputs map
  protected _dupesSequential = 0; // Sequential duplicates count
  protected _dupesGenerated = 0; // Duplicates generated count
  protected _inputsGenerated = 0; // Inputs generated count
  protected _maxDupeInputs!: number; // Max sequential duplicates before stopping
  protected _stopReason?: FuzzStopReason; // Stop reason if CIG stopped fuzzing
  protected _transformRunner?: AbstractRunner; // Input transformer runner
  protected _transformerName?: string; // Active transformer name
  protected _pretransformedInputs: Set<string> = new Set(); // Pre-transformer candidate hashes
  protected _fnTimeout!: number; // Timeout for function/transformer execution
  protected _lastInputSubgenIndex = 0; // Subgen index for last generated input
  public static readonly INJECTED = "injected";

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

    this._fn = fn;
    this._allInputs = allInputs;
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
   *
   * If the lookback window size changes, the measure history is reset with
   * the new window size.
   */
  protected _loadConfig(): void {
    const L = Config.get<number>(
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

    if (L !== this._L || !this._history.length) {
      this._L = L;
      this._history = this._subgens.map(() => ({
        progress: this._measures.map(() => Array(this._L).fill(undefined)),
        cost: Array(this._L).fill(undefined),
        currentIndex: 0,
      }));
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
   * Records that a candidate input was a duplicate in generator stats.
   */
  protected _recordDupe(candidate: InputAndSource): void {
    this._dupesSequential++;
    this._dupesGenerated++;
    this._inputsGenerated++;
    if (candidate.source.type === "generator") {
      const stats = this._genStats[candidate.source.generator];
      stats.counters.dupesGenerated++;
      stats.counters.inputsGenerated++;
      stats.counters.dupeTicks.push(this._tick + 1);
    }
  }

  /**
   * Records that a candidate input was generated in generator stats.
   */
  protected _recordGenerated(candidate: InputAndSource): void {
    this._inputsGenerated++;
    if (candidate.source.type === "generator") {
      const stats = this._genStats[candidate.source.generator];
      stats.counters.inputsGenerated++;
    }
  }

  /**
   * Produces the next input (synchronous fast path when no transformer is active).
   *
   * @returns the next input, including its source metadata
   */
  public override next(): InputAndSource {
    if (this._transformRunner) {
      throw new Error(
        "CompositeInputGenerator.next() cannot be called when an input transformer is configured. Use nextTransformed() instead."
      );
    }

    // Make sure we are permitted to generate inputs
    if (!this.nextable()) {
      throw new Error(
        "Injected inputs exhausted and input generators are suppressed."
      );
    }

    while (
      this._permitSubgens ||
      this._subgens.some(
        (g, i) => this._activeSubgens[i] && g.nextable() === "now!"
      )
    ) {
      if (
        this._ticksLeftInChunk <= 0 ||
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

      const selectedSubgen = this._subgens[this._selectedSubgenIndex];
      const startGenTime = performance.now();
      const candidate = selectedSubgen.next();
      const genCost = performance.now() - startGenTime;

      // Injected inputs from HumanInputGenerator are always processed and never dupe-skipped
      if (candidate.injected) {
        this._tick++;
        if (this._fn && this._fn.getArgDefs().length) {
          const hash = ValueMapper.toLang(
            this._fn.getLang(),
            candidate.value.map((v) => v.value)
          );
          this._pretransformedInputs.add(hash);
          this._allInputs.set(hash, true);
        }
        this._lastInput = {
          ...candidate,
          tick: this._tick,
        };
        this._lastInputSubgenIndex = this._selectedSubgenIndex;
        return structuredClone(this._lastInput);
      }

      // Deduplicate against _allInputs
      if (this._fn && this._fn.getArgDefs().length) {
        const inputHash = ValueMapper.toLang(
          this._fn.getLang(),
          candidate.value.map((v) => v.value)
        );

        if (this._allInputs.has(inputHash)) {
          this._recordDupe(candidate);
          this.onInputFeedback([], genCost);

          if (this._dupesSequential >= this._maxDupeInputs) {
            this._stopReason = FuzzStopReason.MAXDUPES;
            this.suppressGenerators();
            break;
          }
          continue;
        } else {
          this._allInputs.set(inputHash, true);
        }
      }

      this._tick++;
      this._ticksLeftInChunk--;
      this._dupesSequential = 0;
      this._recordGenerated(candidate);
      this._lastInput = {
        ...candidate,
        tick: this._tick,
      };
      this._lastInputSubgenIndex = this._selectedSubgenIndex;
      return structuredClone(this._lastInput);
    }

    throw new Error(
      "Injected inputs exhausted and input generators are suppressed."
    );
  } // fn: next

  /**
   * Produces the next transformed input (asynchronous path when transformer is active).
   *
   * @returns the next transformed input, including its source metadata and transformer result
   */
  public async nextTransformed(): Promise<
    TransformedInputAndSource | undefined
  > {
    // If no transformer is active, fast-path to standard synchronous next()
    if (!this._transformRunner) {
      try {
        return this.next();
      } catch {
        return undefined;
      }
    }

    // Make sure we are permitted to generate inputs
    if (!this.nextable()) {
      throw new Error(
        "Injected inputs exhausted and input generators are suppressed."
      );
    }

    while (
      this._permitSubgens ||
      this._subgens.some(
        (g, i) => this._activeSubgens[i] && g.nextable() === "now!"
      )
    ) {
      if (
        this._ticksLeftInChunk <= 0 ||
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

      const selectedSubgen = this._subgens[this._selectedSubgenIndex];
      const startGenTime = performance.now();
      const untransformedCandidate = await selectedSubgen.next();
      const genCost = performance.now() - startGenTime;

      // Injected inputs from HumanInputGenerator are always processed and never dupe-skipped or transformed
      if (untransformedCandidate.injected) {
        this._tick++;
        if (this._fn && this._fn.getArgDefs().length) {
          const hash = ValueMapper.toLang(
            this._fn.getLang(),
            untransformedCandidate.value.map((v) => v.value)
          );
          this._pretransformedInputs.add(hash);
          this._allInputs.set(hash, true);
        }
        this._lastInput = {
          ...untransformedCandidate,
          tick: this._tick,
        };
        this._lastInputSubgenIndex = this._selectedSubgenIndex;
        return structuredClone(this._lastInput);
      }

      // Stage 1: Pre-transformer duplicate check (only if transformer is active)
      if (this._transformRunner && this._fn && this._fn.getArgDefs().length) {
        const untransformedHash = ValueMapper.toLang(
          this._fn.getLang(),
          untransformedCandidate.value.map((v) => v.value)
        );

        if (this._pretransformedInputs.has(untransformedHash)) {
          this._recordDupe(untransformedCandidate);
          this.onInputFeedback([], genCost);

          if (this._dupesSequential >= this._maxDupeInputs) {
            this._stopReason = FuzzStopReason.MAXDUPES;
            this.suppressGenerators();
            break;
          }
          continue;
        } else {
          this._pretransformedInputs.add(untransformedHash);
        }
      }

      // 1. Transform candidate
      const transformRes = await this._transformCandidate(
        untransformedCandidate
      );
      if (transformRes.skip) {
        this._tick++;
        this._ticksLeftInChunk--;
        this._recordGenerated(untransformedCandidate);
        const skippedInput: TransformedInputAndSource = {
          ...untransformedCandidate,
          tick: this._tick,
          transformerResult: transformRes.transformerResult,
        };
        this._lastInput = skippedInput;
        this._lastInputSubgenIndex = this._selectedSubgenIndex;
        this.onInputFeedback([], genCost);
        return structuredClone(skippedInput);
      }

      const candidate = transformRes.candidate;

      // Stage 2: Post-transformer duplicate check
      if (this._fn && this._fn.getArgDefs().length) {
        const inputHash = ValueMapper.toLang(
          this._fn.getLang(),
          candidate.value.map((v) => v.value)
        );

        if (this._allInputs.has(inputHash)) {
          this._recordDupe(untransformedCandidate);
          this.onInputFeedback([], genCost);

          if (this._dupesSequential >= this._maxDupeInputs) {
            this._stopReason = FuzzStopReason.MAXDUPES;
            this.suppressGenerators();
            break;
          }
          continue;
        } else {
          this._allInputs.set(inputHash, true);
        }
      }

      this._tick++;
      this._ticksLeftInChunk--;
      this._dupesSequential = 0;
      this._recordGenerated(untransformedCandidate);
      this._lastInput = {
        ...candidate,
        tick: this._tick,
      };
      this._lastInputSubgenIndex = this._selectedSubgenIndex;
      return structuredClone(this._lastInput);
    }

    if (this._stopReason !== undefined || !this._permitSubgens) {
      return undefined;
    }

    if (this._lastInput !== undefined) {
      return structuredClone(this._lastInput);
    }

    return undefined;
  } // fn: nextTransformed

  /**
   * Applies the input transformer (if configured) to an untransformed candidate input.
   */
  protected async _transformCandidate(
    untransformedCandidate: InputAndSource
  ): Promise<{
    candidate: InputAndSource;
    skip?: boolean;
    transformerResult?: RunnerResult;
  }> {
    if (!this._transformRunner) {
      return { candidate: untransformedCandidate };
    }

    const transformerResult = await this._transformRunner.run(
      structuredClone(untransformedCandidate.value.map((e) => e.value)),
      Math.max(this._fnTimeout, 1)
    );

    if (transformerResult.result.tag === "value") {
      const values = transformerResult.result.value;
      if (Array.isArray(values)) {
        const transformedValue = structuredClone(untransformedCandidate.value);
        let changed = false;
        transformedValue.forEach((e, i) => {
          if (i < values.length) {
            const oldValue = untransformedCandidate.value[i]?.value;
            const newValue = values[i];
            transformedValue[i].value = newValue;

            if (JSONN.stringify(oldValue) !== JSONN.stringify(newValue)) {
              changed = true;
            }
          }
        });

        const transformedCandidate: InputAndSource = {
          ...untransformedCandidate,
          value: transformedValue,
          source: changed
            ? {
                type: "transformer",
                transformer: this._transformRunner.name,
                basis: {
                  value: structuredClone(untransformedCandidate.value),
                  source: structuredClone(untransformedCandidate.source),
                },
              }
            : untransformedCandidate.source,
        };
        return { candidate: transformedCandidate };
      } else {
        const msg = `Transformer returned non-array value: ${JSONN.stringify(
          transformerResult.result.value
        )}`;
        return {
          candidate: untransformedCandidate,
          skip: true,
          transformerResult: {
            result: {
              tag: "error",
              name: "TransformerError",
              message: msg,
              seq: -1,
            },
            env: {},
          },
        };
      }
    }

    return { candidate: untransformedCandidate, skip: true, transformerResult };
  } // fn: _transformCandidate

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

    const h = this._history[this._selectedSubgenIndex]; // history of current subgen
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

      // Update history of current subgen (-1 = no subgen)
      if (this._selectedSubgenIndex >= 0) {
        h.progress[m][h.currentIndex] = delta;
        h.cost[h.currentIndex] = cost;
      }
    }); // foreach: measurements

    // Roll over to the beginning if we reach the last slot
    if (this._selectedSubgenIndex >= 0) {
      h.currentIndex = (h.currentIndex + 1) % this._L;
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
   * Randomly selects a subgen for the next chunk with a bias toward
   * subgens of higher relative productivity.
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

    // 4. At least one active subgen needs to be available
    if (
      !this._subgens.some(
        (g, i) => this._activeSubgens[i] && g.nextable() === "now"
      )
    ) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${this._subgens.length} subgens configured)`
      );
    }

    // Fastpath: if compositeExplorationChance >= 1.0, randomly select from active & nextable subgens
    // and skip calculations of cost, progress, and productivity.
    if (this._P >= 1.0) {
      const activeSubgenIndices = this._subgens
        .map((_g, i) => i)
        .filter(
          (i) => this._activeSubgens[i] && this._subgens[i].nextable() === "now"
        );

      const selectedIdx =
        activeSubgenIndices[
          Math.floor(this._prng() * activeSubgenIndices.length)
        ];

      if (this._trackCheckpoints) {
        const checkpointGens: NonNullable<
          FuzzTestStats["generators"]["CompositeInputGenerator"]
        >["checkpoints"][number]["gens"] = {};

        this._subgens.forEach((e, g) => {
          checkpointGens[e.name] = {
            active: !!this._activeSubgens[g],
            nextable: e.nextable(),
            productivity: 0,
            cost: 0,
          };
        });
        checkpointGens[this._subgens[selectedIdx].name].selected = true;

        this._checkpoints.push({
          tick: this._tick + 1,
          gens: checkpointGens,
          scheduler: "random",
        });
      }

      return selectedIdx;
    }

    // Calculate cost and progress for each subgen's prior L generations
    const cost: number[] = []; // cost of subgen for L generations
    const progress: number[] = []; // progress of subgen for L generations
    const productivity: number[] = []; // productivity = progress / cost
    let totalProductivity = 0; // total productivity of active subgens
    const checkpointGens: NonNullable<
      FuzzTestStats["generators"]["CompositeInputGenerator"]
    >["checkpoints"][number]["gens"] = {};

    this._subgens.forEach((e, g) => {
      cost[g] = 0;
      this._history[g].cost.forEach((e) => {
        cost[g] += e || 0;
      });
      progress[g] = 0;
      this._measures.forEach((e, m) => {
        this._history[g].progress[m].forEach((e) => {
          progress[g] += (e || 0) * this._measures[m].weight;
        });
      });
      productivity[g] = Math.max(0, cost[g] ? progress[g] / cost[g] : 0);
      const isNextable = e.nextable();
      const isAvailableNow = !!this._activeSubgens[g] && isNextable === "now";
      if (isAvailableNow) {
        totalProductivity += productivity[g];
      }

      if (this._trackCheckpoints) {
        checkpointGens[e.name] = {
          active: !!this._activeSubgens[g],
          nextable: isNextable,
          productivity: productivity[g],
          cost: cost[g],
        };
      }
    }); // foreach: subgen

    // All active subgens have a minimum chance of being selected,
    // which is determined by _P
    const activeSubgens = this._subgens.filter(
      (e, i) => this._activeSubgens[i] && e.nextable() === "now"
    );
    const addlChanceSpace =
      totalProductivity > 0 ? totalProductivity * this._P : 1;
    const addlChance = addlChanceSpace / activeSubgens.length;

    // Randomly select an active subgen with a bias toward subgens
    // of higher productivity for the prior L generations
    const rnd = this._prng() * (totalProductivity + addlChanceSpace);
    let lbound = 0;
    let selectedIdx = -1;
    for (const g in this._subgens) {
      const idx = Number(g);
      if (this._activeSubgens[idx] && this._subgens[idx].nextable() === "now") {
        lbound += productivity[idx] + addlChance;
        if (lbound >= rnd) {
          selectedIdx = idx;
          break;
        }
      }
    }

    if (selectedIdx === -1) {
      throw new Error(
        `Internal failure selecting subgen: ${JSON.stringify(
          {
            progress,
            cost,
            productivity,
            totalProductivity,
            lbound,
            rnd,
            addlChance,
          },
          null,
          3
        )}`
      );
    }

    if (this._trackCheckpoints) {
      checkpointGens[this._subgens[selectedIdx].name].selected = true;
      this._checkpoints.push({
        tick: this._tick + 1,
        gens: checkpointGens,
        scheduler: "mab",
      });
    }

    return selectedIdx;
  } // fn: selectNextSubGen

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
   * Returns the stop reason if the composite generator caused fuzzing to stop.
   */
  public get stopReason(): FuzzStopReason | undefined {
    return this._stopReason;
  }

  /**
   * Returns the number of sequential duplicate inputs generated in the current run.
   */
  public get dupesSequential(): number {
    return this._dupesSequential;
  }

  /**
   * Returns the total number of duplicate inputs generated in the current run.
   */
  public get dupesGenerated(): number {
    return this._dupesGenerated;
  }

  /**
   * Returns the total number of inputs generated in the current run.
   */
  public get inputsGenerated(): number {
    return this._inputsGenerated;
  }

  /**
   * Startup when the test run begins
   */
  public override onRunStart(
    gen: boolean,
    injectedInputs: (FuzzPinnedTest | Omit<InputAndSource, "tick">)[],
    transformRunner: AbstractRunner | undefined,
    fnTimeout: number,
    maxDupeInputs: number
  ): void {
    this._stopReason = undefined;
    this._dupesSequential = 0;
    this._dupesGenerated = 0;
    this._inputsGenerated = 0;
    this._ticksLeftInChunk = 0;

    const newTransformerName = transformRunner?.name;
    if (this._transformerName !== newTransformerName) {
      this._pretransformedInputs.clear();
      this._transformerName = newTransformerName;
    }
    this._transformRunner = transformRunner;
    this._fnTimeout = fnTimeout;
    this._maxDupeInputs = maxDupeInputs;

    this._loadConfig();
    this._leaderboard.loadConfig();
    for (const subgen in this._subgens) {
      this._subgens[subgen].onRunStart(
        gen && this._activeSubgens[subgen],
        injectedInputs
      );
    }
  } // fn: onRunStart

  /**
   * Cleanup all subgens and update stats when the test run ends
   */
  public async onRunEnd(results?: FuzzTestResults): Promise<void> {
    await super.onRunEnd(results);
    await Promise.all(this._subgens.map((g) => g.onRunEnd(results)));
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
