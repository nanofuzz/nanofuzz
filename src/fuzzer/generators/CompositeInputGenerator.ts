import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgType } from "../analysis/typescript/Types";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { Leaderboard } from "./Leaderboard";
import * as JSON5 from "json5";
import { ScoredInput } from "./Types";
import { InputAndSource } from "./../Types";

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
  private _subgens: AbstractInputGenerator[] = []; // Subordinate input generators
  private _tick = 0; // Number of inputs generated
  private _ticksLeftInChunk = 0; // Number of input generations remaining in this chunk
  private _measures: AbstractMeasure[]; // Measures that provide feedback
  private _history: {
    progress: (number | undefined)[][]; // progress by measure and input tick (of L)
    cost: (number | undefined)[]; // cost by input tick (of L)
    currentIndex: number; // current index (of L) into last dimension of progress and cost
  }[]; // history for each input generator
  private _scoredInputs: ScoredInput[] = []; // List of scored inputs
  private _injectedInputs: Omit<InputAndSource, "tick">[] = []; // Inputs to force generate first
  private _selectedSubgenIndex = -1; // Selected subordinate input generator (e.g., by efficiency)
  private _leaderboard; // Interesting inputs
  private _lastInput?: InputAndSource; // Last input generated
  private readonly _L = 500; // Lookback window size for history !!!!!!! externalize
  private readonly _chunkSize = 20; // Re-evaluate subgen after _chunkSize inputs generated
  private readonly _P = 0.1; // Additional chance of subgen exploration !!!!!!! externalize
  public static readonly INJECTED = "injected";

  /**
   * Creates a new composite input generator, which subsumes multiple concrete input
   * generators (subgens) and selects which subgen to use next based on each subgen's
   * recent productivity relative to other subgens, as calculated by various measures.
   *
   * @param `specs` ArgDef specs that describe the inputs to generate
   * @param `rngSeed` seed for pseudo random number generator
   * @param `subgens` array of concrete input generators to subsume
   * @param `measures` array of measures used to evaluate relative productivity of the subgens
   * @param `leaderboard` running list of "interesting" inputs, according to the measures
   */
  public constructor(
    specs: ArgDef<ArgType>[],
    rngSeed: string,
    subgens: AbstractInputGenerator[],
    measures: AbstractMeasure[],
    leaderboard: Leaderboard<InputAndSource>
  ) {
    super(specs, rngSeed);

    this._subgens = subgens;
    this._measures = measures;
    this._leaderboard = leaderboard;

    // Initialize measure history
    this._history = subgens.map(() => ({
      progress: measures.map(() => Array(this._L).fill(undefined)),
      cost: Array(this._L).fill(undefined),
      currentIndex: 0,
    }));
  } // fn: constructor

  /**
   * Returns true if further inputs may be produced, false otherwise.
   */
  public isAvailable(): boolean {
    return (
      !!this._injectedInputs.length ||
      this._subgens.some((g) => g.isAvailable())
    );
  } // fn: isAvailable

  /**
   * Inject predefined inputs into the queue. These inputs will be produced
   * by the composite input generator prior to producing inputs with subgens.
   *
   * @param `inputs` array of input values to produce first
   */
  public inject(inputs: Omit<InputAndSource, "tick">[]): void {
    this._injectedInputs = [...inputs].reverse();
  } // fn: inject

  /**
   * Produces the next input
   *
   * @returns the next input, including its source metadata
   */
  public next(): InputAndSource {
    this._tick++;

    // Produce injected inputs first, if available
    if (this._injectedInputs.length) {
      const injectedInput = this._injectedInputs.pop();
      if (injectedInput) {
        this._lastInput = {
          tick: this._tick,
          value: injectedInput.value,
          source: injectedInput.source,
          injected: true,
        };
        return this._lastInput;
      }
    }

    // If the prior chunk of generated inputs is exhausted or the
    // subgen is no longer available, start a new chunk and choose
    // the subgen for that chunk
    if (
      this._ticksLeftInChunk-- < 1 ||
      !this._subgens[this._selectedSubgenIndex].isAvailable()
    ) {
      this._ticksLeftInChunk = this._chunkSize;
      this._selectedSubgenIndex = this._selectNextSubGen();
    }

    // Generate and return the input
    this._lastInput = {
      ...this._subgens[this._selectedSubgenIndex].next(),
      tick: this._tick,
    };
    return JSON5.parse(JSON5.stringify(this._lastInput));
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

    // Update history of composite input generator
    this._scoredInputs[this._tick] = {
      input: this._lastInput,
      tick: this._tick,
      score: weightedProgress,
      cost,
      measurements,
      interestingReasons,
    };

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
  private _selectNextSubGen(): number {
    // At least one subgen needs to be available
    if (!this._subgens.some((g) => g.isAvailable())) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${this._subgens.length} subgens configured)`
      );
    }

    // Calculate cost and progress for each subgen's prior L generations
    const cost: number[] = []; // cost of subgen for L generations
    const progress: number[] = []; // progress of subgen for L generations
    const productivity: number[] = []; // productivity = progress / cost
    let totalProductivity = 0; // total productivity of active subgens
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
      productivity[g] = cost[g] ? progress[g] / cost[g] : 0;
      if (e.isAvailable()) {
        totalProductivity += productivity[g];
      }
    }); // foreach: subgen

    // All active subgens have a minimum chance of being selected,
    // which is determined by _P
    const activeSubgens = this._subgens.filter((e) => e.isAvailable());
    const addlChanceSpace = totalProductivity ? totalProductivity * this._P : 1;
    const addlChance = addlChanceSpace / activeSubgens.length;

    // Randomly select an active subgen with a bias toward subgens
    // of higher productivity for the prior L generations
    const rnd = this._prng() * (totalProductivity + addlChanceSpace);
    let lbound = 0;
    for (const g in this._subgens) {
      if (this._subgens[g].isAvailable()) {
        lbound += productivity[g] + addlChance;
        if (lbound >= rnd) {
          return Number(g);
        }
      }
    }
    throw new Error(
      `Internal failure selecting subgen: ${JSON5.stringify(
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
  } // fn: selectNextSubGen

  /**
   * Return interesting inputs, their sources, and their measures
   *
   * @returns interesting inputs
   */
  public getInterestingInputs(): ScoredInput[] {
    return this._scoredInputs
      .filter((i) => i.interestingReasons.length)
      .map((i) => {
        return { ...i };
      });
  } // fn: getInterestingInputs

  /**
   * Cleanup and reporting activities during fuzzer shutdown
   */
  public onShutdown(): void {
    super.onShutdown();
    this._subgens.forEach((e) => {
      e.onShutdown();
    });
    /*
    const leaders = this._leaderboard.getLeaders();
    console.debug(
      `Leaderboard: (${leaders.length} of max ${this._leaderboard.slots} entries)`
    ); 
    leaders
      .sort((a, b) => a.leader.tick - b.leader.tick)
      .map((e) => [e.leader.tick, e.leader.value, e.leader.source, e.score])
      .forEach((e) => {
        console.debug(JSON.stringify(e));
      }); 
    */
  } // fn: onShutdown
} // class: CompositeInputGenerator
