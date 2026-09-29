import * as Config from "../../Config";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Exponentially Weighted Moving Average (EWMA) subgenerator scheduler.
 * Maintains an O(1) rolling productivity score per subgenerator using exponential decay:
 *   mu_i = alpha * reward + (1 - alpha) * mu_i
 */
export class EwmaScheduler extends AbstractInputScheduler {
  protected _alpha = 0.2; // Smoothing factor (weight of newest feedback)
  protected _exploration = 0.1; // Exploration chance (epsilon)
  protected _stats: SubgenEwmaStats[] = []; // Rolling EWMA metrics per subgen

  /**
   * Create a new EWMA input generator scheduler
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
    return "ewma";
  } // property: get type

  /**
   * EWMA scheduler requires execution feedback to update rolling averages
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
    this._alpha = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.ewma.alpha",
      0.2
    );
    this._exploration = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.ewma.exploration",
      0.1
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
    return {
      productivity: s.smoothedProductivity,
      cost: s.smoothedCost,
    };
  } // fn: getSubgenMetrics

  /**
   * Selects the next subgenerator index via productivity-weighted roulette wheel selection
   */
  public override next(ctx: InputSchedulerNextContext): number {
    this._ensureStats(ctx.subgens.length);

    const candidates = this._getAvailableCandidateIndices(ctx);
    if (candidates.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    let totalProductivity = 0;
    for (const idx of candidates) {
      totalProductivity += this._stats[idx].smoothedProductivity;
    }

    // Allocate baseline exploration space
    const addlChanceSpace =
      totalProductivity > 0 ? totalProductivity * this._exploration : 1.0;
    const addlChance = addlChanceSpace / candidates.length;

    // Roulette-wheel selection biased by rolling EWMA productivity
    const rnd = this._prng() * (totalProductivity + addlChanceSpace);
    let lbound = 0;
    let selectedIdx = -1;

    for (const idx of candidates) {
      lbound += this._stats[idx].smoothedProductivity + addlChance;
      if (lbound >= rnd) {
        selectedIdx = idx;
        break;
      }
    }

    if (selectedIdx === -1) {
      selectedIdx = candidates[candidates.length - 1];
    }

    this._lastSelectedSubgenIndex = selectedIdx;
    return selectedIdx;
  } // fn: next

  /**
   * Updates rolling EWMA productivity and cost for the selected subgenerator
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

    const instantReward = cost > 0 ? weightedProgress / cost : 0;

    if (s.picks === 0) {
      // First observation initializes the smoothed values directly
      s.smoothedProductivity = instantReward;
      s.smoothedCost = cost;
    } else {
      // Exponential moving average update
      s.smoothedProductivity =
        this._alpha * instantReward +
        (1.0 - this._alpha) * s.smoothedProductivity;
      s.smoothedCost =
        this._alpha * cost + (1.0 - this._alpha) * s.smoothedCost;
    }

    s.picks++;
  } // fn: onInputFeedback

  /**
   * Ensures stats data structures are allocated for the specified subgens
   */
  protected _ensureStats(subgenCount: number): void {
    while (this._stats.length < subgenCount) {
      this._stats.push({
        picks: 0,
        smoothedProductivity: 0,
        smoothedCost: 0,
      });
    }
  } // fn: _ensureStats
} // class: EwmaScheduler

/**
 * Rolling EWMA state for a single subgenerator
 */
interface SubgenEwmaStats {
  picks: number;
  smoothedProductivity: number;
  smoothedCost: number;
}
