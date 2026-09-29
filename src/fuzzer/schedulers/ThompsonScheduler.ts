import * as Config from "../../Config";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Thompson Sampling (Bayesian Bandit) subgenerator scheduler.
 *
 * References:
 *   S. Agrawal and N. Goyal,
 *   “Analysis of Thompson Sampling for the Multi-armed Bandit Problem,”
 *   in Proceedings of the 25th Annual Conference on Learning Theory,
 *   JMLR Workshop and Conference Proceedings, Jun. 2012, p. 39.1-39.26.
 *   https://proceedings.mlr.press/v23/agrawal12.html
 *
 *   William R. Thompson.
 *   "On the Likelihood that One Unknown Probability Exceeds Another in View of the Evidence of Two Samples"
 *   Biometrika, 25(3/4): 285–294, 1933.
 *   doi: 10.2307/2332286
 *
 * Samples from each candidate generator's posterior productivity distribution
 * and selects the generator with the maximum sample.
 */
export class ThompsonScheduler extends AbstractInputScheduler {
  protected _priorVariance = 1.0; // Initial prior variance (sigma_0^2)
  protected _noiseVariance = 1.0; // Observation noise variance (sigma_v^2)
  protected _stats: SubgenThompsonStats[] = []; // Posterior parameters per subgen

  /**
   * Create a new Thompson Sampling scheduler
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
    return "thompson";
  } // property: get type

  /**
   * Thompson sampling requires execution feedback to update posterior distributions
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
    this._priorVariance = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.thompson.priorVariance",
      1.0
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
   * Selects the next subgenerator index by sampling from posterior distributions
   */
  public override next(ctx: InputSchedulerNextContext): number {
    this._ensureStats(ctx.subgens.length);

    const candidates = this._getAvailableCandidateIndices(ctx);
    if (candidates.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    let bestSample = -Infinity;
    let bestCandidates: number[] = [];

    for (const idx of candidates) {
      const s = this._stats[idx];
      const sample = this._samplePosterior(s);

      if (sample > bestSample + 1e-9) {
        bestSample = sample;
        bestCandidates = [idx];
      } else if (Math.abs(sample - bestSample) <= 1e-9) {
        bestCandidates.push(idx);
      }
    }

    const selectedIdx =
      bestCandidates[Math.floor(this._prng() * bestCandidates.length)];
    this._lastSelectedSubgenIndex = selectedIdx;
    return selectedIdx;
  } // fn: next

  /**
   * Updates posterior parameters for the selected subgenerator based on execution feedback
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

    const reward = cost > 0 ? weightedProgress / cost : 0;

    s.picks++;
    s.totalProgress += weightedProgress;
    s.totalCost += cost;
    s.sumRewards += reward;

    // Update Gaussian posterior parameters:
    // precision = 1/prior_var + n/noise_var
    // posterior_var = 1 / precision
    // posterior_mean = posterior_var * (sum_rewards / noise_var)
    const precision = 1.0 / this._priorVariance + s.picks / this._noiseVariance;
    s.posteriorVariance = 1.0 / precision;
    s.posteriorMean =
      s.posteriorVariance * (s.sumRewards / this._noiseVariance);
  } // fn: onInputFeedback

  /**
   * Samples a value from the subgenerator's Gaussian posterior distribution N(mu, sigma^2)
   */
  protected _samplePosterior(s: SubgenThompsonStats): number {
    const stdDev = Math.sqrt(s.posteriorVariance);
    // Box-Muller standard normal sample Z ~ N(0, 1) using seeded PRNG
    const u1 = Math.max(this._prng(), 1e-10);
    const u2 = this._prng();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

    return s.posteriorMean + stdDev * z;
  } // fn: _samplePosterior

  /**
   * Ensures stats data structures are allocated for the specified subgens
   */
  protected _ensureStats(subgenCount: number): void {
    while (this._stats.length < subgenCount) {
      this._stats.push({
        picks: 0,
        totalProgress: 0,
        totalCost: 0,
        sumRewards: 0,
        posteriorMean: 0,
        posteriorVariance: this._priorVariance,
      });
    }
  } // fn: _ensureStats
} // class: ThompsonScheduler

/**
 * Posterior parameters and running stats for a single subgenerator
 */
interface SubgenThompsonStats {
  picks: number;
  totalProgress: number;
  totalCost: number;
  sumRewards: number;
  posteriorMean: number;
  posteriorVariance: number;
}
