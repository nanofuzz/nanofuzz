import { AbstractInputGenerator } from "./AbstractInputGenerator";
import { ArgType, ArgValueType } from "../analysis/typescript/Types";
import { ArgDef } from "../analysis/typescript/ArgDef";
import { AbstractMeasure } from "../measures/AbstractMeasure";
import { BaseMeasurement } from "../measures/Types";
import { Leaderboard } from "./Leaderboard";
import * as JSON5 from "json5";
import { InputAndSource, ScoredInput } from "./Types";

// !!!!
export class CompositeInputGenerator extends AbstractInputGenerator {
  private _subgens: AbstractInputGenerator[] = []; // Subordinate input generators
  private _tick = 0; // Number of inputs generated
  private _ticksLeftInChunk = 0; // Number of input generations remaining in this chunk
  private _measures: AbstractMeasure[]; // Measures that provide feedback
  private _weights: number[]; // Weights for the various measures
  private _history: {
    progress: (number | undefined)[][]; // progress by measure and input tick (of L)
    cost: (number | undefined)[]; // cost by input tick (of L)
    currentIndex: number; // current index (of L) into last dimension of progress and cost
  }[]; // history for each input generator
  private _scoredInputs: ScoredInput[] = []; // !!!!!!
  private _injectedInputs: ArgValueType[][] = []; // Inputs to force generate first
  private _selectedSubgenIndex = 0; // Selected subordinate input generator (e.g., by efficiency)
  private _leaderboard; // Interesting inputs
  private _lastInput?: InputAndSource; // Last input generated
  private readonly _L = 500; // Lookback window size for history !!!!!!! externalize
  private readonly _chunkSize = 10; // Re-evaluate subgen after _chunkSize inputs generated
  private readonly _P = 0.05; // Additional chance of subgen exploration !!!!!!! externalize
  public static readonly INJECTED = "injected";

  // !!!!!!
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
    this._weights = measures.map((m) => m.weight);
    this._leaderboard = leaderboard;

    if (this._subgens.length === 0)
      throw new Error(
        "No input generators provided to CompositeInputGenerator."
      );

    // Initialize measure history
    this._history = subgens.map(() => ({
      progress: measures.map(() => Array(this._L).fill(undefined)),
      cost: Array(this._L).fill(undefined),
      currentIndex: 0,
    }));
  }

  // !!!!!!
  public inject(inputs: ArgValueType[][]): void {
    this._injectedInputs = JSON5.parse(JSON5.stringify(inputs.reverse()));
  }

  // !!!!!!
  public next(): InputAndSource {
    this._tick++;

    // Produce injected inputs first, if available
    if (this._injectedInputs.length) {
      const injectedInput = this._injectedInputs.pop();
      if (injectedInput) {
        this._lastInput = {
          tick: this._tick,
          value: injectedInput,
          source: {
            subgen: CompositeInputGenerator.INJECTED,
          },
        };
        return this._lastInput;
      }
    }

    // If the prior chunk of generated inputs is exhausted, start
    // a new chunk and choose the subgen for that chunk
    if (this._ticksLeftInChunk-- < 1) {
      this._ticksLeftInChunk = this._chunkSize;
      const priorSubGen = this._selectedSubgenIndex;
      this._selectedSubgenIndex = this.selectNextSubGen();
      console.debug(
        `[${this.name}][${this._tick}] Prior subgen: ${
          this._subgens[priorSubGen].name
        } Next subgen: ${this._subgens[this._selectedSubgenIndex].name}`
      ); // !!!!!!!
    }

    // Generate and return the input
    this._lastInput = {
      ...this._subgens[this._selectedSubgenIndex].next(),
      tick: this._tick,
    };
    return JSON5.parse(JSON5.stringify(this._lastInput));
  } // !!!!!!

  // !!!!!!
  // pre: this._lastInput !== undefined
  public onInputFeedback(measurements: BaseMeasurement[], cost: number): void {
    let score = 0; // !!!!!!
    const h = this._history[this._selectedSubgenIndex]; // history of current subgen

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

      // Update history of current subgen
      h.progress[m][h.currentIndex] = measure.delta(measurement);
      h.cost[h.currentIndex] = 1; // !!!!!!!! cost;
      score += (h.progress[m][h.currentIndex] ?? 0) * measure.weight;
    }); // !!!!!!

    h.currentIndex = (h.currentIndex + 1) % this._L; // !!!!!!

    // Update history of composite input generator
    this._scoredInputs[this._tick] = {
      input: this._lastInput,
      tick: this._tick,
      score,
      cost,
      measurements,
    };

    // Update leaderboard & last measured input if we have measures
    // (e.g., the input was not a dupe and was actually executed)
    if (measurements.length) {
      this._leaderboard.postScore(this._lastInput, score);
    }
  } // !!!!!!

  // !!!!!!
  private selectNextSubGen(): number {
    // Calculate cost and progress for each subgen's prior L generations
    const cost: number[] = []; // cost of subgen for L generations
    const progress: number[] = []; // progress of subgen for L generations
    const productivity: number[] = []; // productivity = progress / cost
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
    });

    // Calculate total productivity for active subgens for L generations
    let totalProductivity = 0;
    this._subgens.forEach((e, g) => {
      if (e.isAvailable()) {
        totalProductivity += productivity[g];
      }
    });

    // All active subgens have a minimum chance of being selected,
    // which is determined by _P
    const activeSubgens = this._subgens.filter((e) => e.isAvailable());
    const addlChanceSpace = totalProductivity ? totalProductivity * this._P : 1;
    const addlChance = addlChanceSpace / activeSubgens.length;

    // Randomly select an active subgen with a bias toward subgens
    // of higher productivity for the prior L generations
    const rnd = this._prng() * (totalProductivity + addlChanceSpace);
    console.debug(
      `[${this.name}] probability space. totPro: ${totalProductivity} addChnSpc: ${addlChanceSpace} rnd: ${rnd}`
    ); // !!!!!!!
    console.debug(
      `[${this.name}] productivity: ${JSON5.stringify(productivity)}`
    ); // !!!!!!!
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
    ); // !!!!!!!
  }

  // !!!!!!
  public onShutdown(): void {
    super.onShutdown();
    this._subgens.forEach((e) => {
      e.onShutdown();
    });

    console.debug(`All inputs:`); // !!!!!!!
    this._scoredInputs
      .map((e) => [e.input, e.score])
      .forEach((e) => {
        console.debug(JSON5.stringify(e));
      });

    const leaders = this._leaderboard.getLeaders();
    console.debug(
      `Leaderboard: (${leaders.length} of max ${this._leaderboard.slots} entries)`
    ); // !!!!!!!
    leaders
      .map((e) => [e.leader.tick, e.leader.value, e.leader.source, e.score])
      .forEach((e) => {
        console.debug(JSON.stringify(e));
      }); // !!!!!!!
  }
}
