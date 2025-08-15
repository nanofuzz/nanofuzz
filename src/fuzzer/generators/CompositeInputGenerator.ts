import seedrandom from "seedrandom";
import { InputGenerator } from "./InputGenerator";
import { FuzzEnv } from "../Fuzzer";
import { FuzzIoElement, FuzzTestResult, FuzzTestResults } from "../Fuzzer";
import { Measure } from "../measures/Measure";

export const InputGeneratorStrategies = ["RandomInputGenerator"] as const;

export class CompositeInputGenerator implements InputGenerator {
  public readonly name = "CompositeInputGenerator";

  private _subgens: InputGenerator[];
  private _measures: (typeof Measure)[];
  private _weights: number[];
  private _history: {
    values: (number | undefined)[][];
    currentIndex: number;
  }[];
  private _runCount = 0;
  private _selectedSubgenIndex = 0;
  private readonly _L = 10; // Lookback window size for history.
  private readonly _explorationP = 20; // Exploration probability.
  private readonly _prng: seedrandom.prng;

  public constructor(
    env: FuzzEnv,
    subgens: InputGenerator[],
    measures: (typeof Measure)[],
    weights: number[]
  ) {
    this._prng = seedrandom(env.options.seed ?? "");
    this._subgens = subgens;
    this._measures = measures;
    this._weights = weights;

    if (this._subgens.length === 0)
      throw new Error(
        "No input generators provided to CompositeInputGenerator."
      );
    if (this._measures.length !== this._weights.length)
      throw new Error("Measures and weights must have the same length.");

    this._history = subgens.map(() => ({
      values: measures.map(() => Array(this._L).fill(undefined)),
      currentIndex: 0,
    }));

    this._runCount = 0;
    for (const h of this._history) {
      h.values.forEach((v) => v.fill(undefined));
      h.currentIndex = 0;
    }
  }

  public next(): FuzzIoElement[] {
    const G = this._subgens.length;

    let gen: InputGenerator;
    const rand = Math.floor(this._prng() * this._explorationP);
    if (rand === 0) {
      const randval = Math.floor(this._prng() * G);
      gen = this._subgens[randval];
    } else gen = this._subgens[this._selectedSubgenIndex];

    return gen.next();
  }

  public initRun(): void {
    const G = this._subgens.length;
    if (
      this._runCount === 0 ||
      Math.floor(this._prng() * this._explorationP) === 0
    ) {
      // Exploration on first run or with prob 1/_explorationP.
      this._selectedSubgenIndex = Math.floor(this._prng() * G);
    } else {
      // Pick g with max weighted sum of delta-M over last L runs with g as selected generator.
      let bestIdx = 0;
      let bestEff = -Infinity;
      for (let genIdx = 0; genIdx < G; genIdx++) {
        let sum = 0;
        for (
          let measureIdx = 0;
          measureIdx < this._measures.length;
          measureIdx++
        ) {
          const buffer = this._history[genIdx].values[measureIdx];

          for (let i = 1; i < this._L; i++) {
            if (buffer[i] !== undefined && buffer[i - 1] !== undefined) {
              const current = buffer[i]!;
              const previous = buffer[i - 1]!;
              sum += (current - previous) * this._weights[measureIdx];
            }
          }
          const eff = sum / 1; // TODO: Let us set cost=1 for now.
          if (eff > bestEff) {
            bestEff = eff;
            bestIdx = genIdx;
          }
        }
        this._selectedSubgenIndex = bestIdx;
      }
    }
  }

  public onRunEnd(results: FuzzTestResults): void {
    let aggregateMeasure = 0;
    for (let measureIdx = 0; measureIdx < this._measures.length; measureIdx++) {
      const h = this._history[this._selectedSubgenIndex];
      const measure = this._measures[measureIdx];

      aggregateMeasure += measure.measure(results);
      h.values[measureIdx][h.currentIndex] = aggregateMeasure;
      h.currentIndex = (h.currentIndex + 1) % this._L;

      this._runCount++;
    }
  }
}
