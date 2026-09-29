import * as Config from "../../Config";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Multi-Armed Bandit (MAB) subgenerator scheduler.
 *
 * References:
 *   M. Woo, S. K. Cha, S. Gottlieb, and D. Brumley,
 *   “Scheduling black-box mutational fuzzing,”
 *   in Proceedings of the 2013 ACM SIGSAC conference on Computer & Communications Security,
 *   in CCS ’13. New York, NY, USA: Association for Computing Machinery,
 *   Nov. 2013, pp. 511–522. doi: 10.1145/2508859.2516736.
 *
 *   H. Robbins,
 *   "Some aspects of the sequential design of experiments."
 *   in Bulletin of the American Mathematical Society.
 *   Vol 58, issue 5. September, 1952. 527-535.
 *   https://projecteuclid.org/journals/bulletin-of-the-american-mathematical-society/volume-58/issue-5/Robins/bams/1183517370.pdf
 *
 * Selects subgenerators based on their historical productivity (progress / cost)
 * with an additional exploration chance.
 */
export class MabScheduler extends AbstractInputScheduler {
  protected _L = 500; // Lookback window size for history
  protected _P = 0.1; // Additional chance of subgen exploration
  protected _history: SubgenHistory[] = []; // history for each input generator
  protected _productivity: number[] = []; // last computed productivities per subgen
  protected _cost: number[] = []; // last computed costs per subgen

  /**
   * Create a new MAB input generator scheduler
   *
   * @param `rngSeed` seed for pseudo random number generator
   */
  public constructor(rngSeed: string | undefined) {
    super(rngSeed);
    this._loadConfig();
  } // fn: constructor

  /**
   * Returns the scheduler type identifier
   */
  public override get type(): InputSchedulerType {
    return "mab";
  } // property: get type

  /**
   * MAB scheduler requires execution feedback to calculate productivity
   */
  public override get needsFeedback(): boolean {
    return true;
  } // property: get needsFeedback

  /**
   * Lifecycle hook when a test run starts or resumes
   */
  public override onRunStart(): void {
    this._loadConfig();
  } // fn: onRunStart

  /**
   * Loads configuration parameters
   */
  protected _loadConfig(): void {
    const L = Config.get<number>(
      "nanofuzz.generators.compositeLookbackWindow",
      500
    );
    this._P = Config.get<number>(
      "nanofuzz.generators.compositeExplorationChance",
      0.1
    );

    if (L !== this._L) {
      this._L = L;
      this._history = [];
    }
  } // fn: _loadConfig

  /**
   * Returns productivity and cost metrics for a given subgenerator
   */
  public override getSubgenMetrics(subgenIndex: number): {
    productivity: number;
    cost: number;
  } {
    return {
      productivity: this._productivity[subgenIndex] ?? 0,
      cost: this._cost[subgenIndex] ?? 0,
    };
  } // fn: getSubgenMetrics

  /**
   * Selects the next subgenerator index biased by relative productivity and exploration
   */
  public override next(ctx: InputSchedulerNextContext): number {
    this._ensureHistory(ctx.subgens.length, ctx.measures.length);

    const candidateIndices = this._getAvailableCandidateIndices(ctx);
    if (candidateIndices.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    // Calculate cost and progress for each subgen's prior L generations
    const cost: number[] = [];
    const progress: number[] = [];
    const productivity: number[] = [];
    let totalProductivity = 0;

    for (let g = 0; g < ctx.subgens.length; g++) {
      cost[g] = 0;
      this._history[g].cost.forEach((e) => {
        cost[g] += e || 0;
      });
      progress[g] = 0;
      ctx.measures.forEach((e, m) => {
        this._history[g].progress[m].forEach((e) => {
          progress[g] += (e || 0) * ctx.measures[m].weight;
        });
      });
      productivity[g] = Math.max(0, cost[g] ? progress[g] / cost[g] : 0);
      const isNextable = ctx.subgens[g].nextable();
      const isAvailableNow = !!ctx.activeSubgens[g] && isNextable === "now";
      if (isAvailableNow) {
        totalProductivity += productivity[g];
      }
    }

    this._cost = cost;
    this._productivity = productivity;

    // All active subgens have a minimum chance of being selected,
    // which is determined by _P
    const addlChanceSpace =
      totalProductivity > 0 ? totalProductivity * this._P : 1;
    const addlChance = addlChanceSpace / candidateIndices.length;

    // Randomly select an active subgen with a bias toward subgens
    // of higher productivity for the prior L generations
    const rnd = this._prng() * (totalProductivity + addlChanceSpace);
    let lbound = 0;
    let selectedIdx = -1;
    for (const idx of candidateIndices) {
      lbound += productivity[idx] + addlChance;
      if (lbound >= rnd) {
        selectedIdx = idx;
        break;
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

    this._lastSelectedSubgenIndex = selectedIdx;
    return selectedIdx;
  } // fn: next

  /**
   * Updates sliding history for the last selected subgenerator based on execution feedback
   */
  public override onInputFeedback(
    measurements: BaseMeasurement[],
    cost: number,
    measures: readonly AbstractMeasure[]
  ): void {
    if (this._lastSelectedSubgenIndex < 0) {
      return;
    }

    this._ensureHistory(this._lastSelectedSubgenIndex + 1, measures.length);
    const h = this._history[this._lastSelectedSubgenIndex];

    measurements.forEach((measurement, m) => {
      const measure = measures[m];
      if (measure.name !== measurement.name) {
        throw new Error(
          `Expected feedback for measure "${measure.name}" at offset ${String(
            m
          )} but received "${measurement.name}" instead.`
        );
      }

      const delta = measure.delta(measurement);
      h.progress[m][h.currentIndex] = delta;
      h.cost[h.currentIndex] = cost;
    });

    h.currentIndex = (h.currentIndex + 1) % this._L;
  } // fn: onInputFeedback

  /**
   * Ensures history data structures are allocated for the specified subgens and measures
   */
  protected _ensureHistory(subgenCount: number, measureCount: number): void {
    while (this._history.length < subgenCount) {
      this._history.push({
        progress: Array.from({ length: measureCount }, () =>
          Array(this._L).fill(undefined)
        ),
        cost: Array(this._L).fill(undefined),
        currentIndex: 0,
      });
    }
  } // fn: _ensureHistory
} // class: MabScheduler

/**
 * Historical progress and cost for a single subgenerator
 */
interface SubgenHistory {
  progress: (number | undefined)[][]; // progress by measure and input tick (of L)
  cost: (number | undefined)[]; // cost by input tick (of L)
  currentIndex: number; // current index (of L) into last dimension of progress and cost
}
