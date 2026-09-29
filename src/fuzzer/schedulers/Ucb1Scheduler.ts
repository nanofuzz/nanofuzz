import * as Config from "../../Config";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Upper Confidence Bound (UCB1) subgenerator scheduler.
 * 
 * References:
 *   P. Auer, N. Cesa-Bianchi, and P. Fischer, 
 *   “Finite-time Analysis of the Multiarmed Bandit Problem,” 
 *   Machine Learning, vol. 47, no. 2, pp. 235–256, May 2002, 
 *   doi: 10.1023/A:1013689704352.

 * Selects subgenerators using optimistic exploration in the face of uncertainty:
 * Score_i = mu_i + c * sqrt(2 * ln(N) / n_i)
 */
export class Ucb1Scheduler extends AbstractInputScheduler {
  protected _c = 1.414; // Exploration constant (c)
  protected _totalPicks = 0; // Total selections across all subgens (N)
  protected _stats: SubgenUcbStats[] = []; // Statistics per subgenerator

  /**
   * Create a new UCB1 input generator scheduler
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
    return "ucb1";
  } // property: get type

  /**
   * UCB1 scheduler requires execution feedback to calculate scores
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
    this._c = Config.get<number>(
      "nanofuzz.generators.scheduler.ucb1.exploration",
      1.414
    );
  } // fn: _loadConfig

  /**
   * Returns productivity and cost metrics for a given subgenerator
   */
  public override getSubgenMetrics(subgenIndex: number): {
    productivity: number;
    cost: number;
  } {
    const s = this._stats[subgenIndex];
    if (!s || s.picks === 0) {
      return { productivity: 0, cost: 0 };
    }
    const avgCost = s.totalCost / s.picks;
    const avgProgress = s.totalProgress / s.picks;
    return {
      productivity: avgCost > 0 ? avgProgress / avgCost : 0,
      cost: avgCost,
    };
  } // fn: getSubgenMetrics

  /**
   * Selects the next subgenerator index based on the UCB1 policy
   */
  public override next(ctx: InputSchedulerNextContext): number {
    this._ensureStats(ctx.subgens.length);

    const candidates = this._getAvailableCandidateIndices(ctx);
    if (candidates.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    // 1. Cold-start check: Pick any unvisited ready candidate (score = +Infinity)
    const unvisited = candidates.filter((i) => this._stats[i].picks === 0);
    if (unvisited.length > 0) {
      const selectedIdx =
        unvisited[Math.floor(this._prng() * unvisited.length)];
      this._lastSelectedSubgenIndex = selectedIdx;
      return selectedIdx;
    }

    // 2. Compute empirical productivity for each candidate and find max for normalization
    const productivities = candidates.map((i) => {
      const metrics = this.getSubgenMetrics(i);
      return metrics.productivity;
    });
    const maxProductivity = Math.max(...productivities, 1e-6);

    // 3. Calculate UCB1 score for each candidate
    let bestScore = -Infinity;
    let bestCandidates: number[] = [];
    const logTotal = Math.log(Math.max(this._totalPicks, 1));

    candidates.forEach((subgenIdx, idx) => {
      const s = this._stats[subgenIdx];
      const normalizedMu = productivities[idx] / maxProductivity;
      const explorationBonus = this._c * Math.sqrt((2 * logTotal) / s.picks);
      const ucbScore = normalizedMu + explorationBonus;

      if (ucbScore > bestScore + 1e-9) {
        bestScore = ucbScore;
        bestCandidates = [subgenIdx];
      } else if (Math.abs(ucbScore - bestScore) <= 1e-9) {
        bestCandidates.push(subgenIdx);
      }
    });

    // 4. Break ties with PRNG
    const selectedIdx =
      bestCandidates[Math.floor(this._prng() * bestCandidates.length)];
    this._lastSelectedSubgenIndex = selectedIdx;
    return selectedIdx;
  } // fn: next

  /**
   * Updates statistics for the last selected subgenerator based on execution feedback
   */
  public override onInputFeedback(
    measurements: BaseMeasurement[],
    cost: number,
    measures: readonly AbstractMeasure[]
  ): void {
    if (this._lastSelectedSubgenIndex < 0) {
      return;
    }

    this._ensureStats(this._lastSelectedSubgenIndex + 1);
    const s = this._stats[this._lastSelectedSubgenIndex];

    let weightedProgress = 0;
    measurements.forEach((measurement, m) => {
      const measure = measures[m];
      if (measure) {
        if (measure.name !== measurement.name) {
          throw new Error(
            `Expected feedback for measure "${measure.name}" at offset ${String(
              m
            )} but received "${measurement.name}" instead.`
          );
        }
        weightedProgress += measure.delta(measurement) * measure.weight;
      }
    });

    s.picks++;
    s.totalProgress += weightedProgress;
    s.totalCost += cost;
    this._totalPicks++;
  } // fn: onInputFeedback

  /**
   * Ensures stats data structures are allocated for the specified subgens
   */
  protected _ensureStats(subgenCount: number): void {
    while (this._stats.length < subgenCount) {
      this._stats.push({ picks: 0, totalProgress: 0, totalCost: 0 });
    }
  } // fn: _ensureStats
} // class: Ucb1Scheduler

/**
 * Running UCB metrics for a single subgenerator
 */
interface SubgenUcbStats {
  picks: number;
  totalProgress: number;
  totalCost: number;
}
