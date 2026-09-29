import * as Config from "../../Config";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * MOpt (Mutation Optimization) scheduler using Particle Swarm Optimization
 *
 * Based on the paper:
 *   C. Lyu et al., “MOPT: Optimized Mutation Scheduling for Fuzzers,”
 *   presented at the 28th USENIX Security Symposium (USENIX Security 19),
 *   2019, pp. 1949–1966.
 *
 * Uses a swarm of probability distribution particles navigating the
 * probability simplex over subgenerators to evaluate particle fitness
 * in pilot periods and updating velocities toward personal and global
 * best configurations:
 *   v_i = w * v_i + c1 * r1 * (P_best_i - x_i) + c2 * r2 * (G_best_i - x_i)
 */
export class MoptScheduler extends AbstractInputScheduler {
  protected _swarmSize = 5; // Number of particles in the swarm (S)
  protected _period = 50; // Evaluation period length in inputs (T)
  protected _w = 0.7; // Inertia weight
  protected _c1 = 1.4; // Cognitive acceleration coefficient
  protected _c2 = 1.4; // Social acceleration coefficient
  protected _minProb = 0.05; // Minimum exploration probability per generator

  protected _particles: Particle[] = [];
  protected _activeParticleIdx = 0;
  protected _ticksInCurrentPeriod = 0;
  protected _globalBestPos: number[] = [];
  protected _globalBestFitness = -1;

  // Running stats for getSubgenMetrics
  protected _subgenProgress: number[] = [];
  protected _subgenCost: number[] = [];

  /**
   * Create a new MOpt input generator scheduler
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
    return "mopt";
  } // property: get type

  /**
   * MOpt scheduler requires execution feedback to evaluate particle fitness and update PSO velocities
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
    this._swarmSize = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.mopt.swarmSize",
      5
    );
    this._period = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.mopt.period",
      50
    );
    this._w = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.mopt.inertia",
      0.7
    );
    this._minProb = Config.get<number>(
      "nanofuzz.generators.compositeScheduler.mopt.exploration",
      0.05
    );
  } // fn: _loadConfig

  /**
   * Returns productivity and cost metrics for a given subgenerator
   */
  public override getSubgenMetrics(subgenIndex: number): {
    productivity: number;
    cost: number;
  } {
    const cost = this._subgenCost[subgenIndex] ?? 0;
    const progress = this._subgenProgress[subgenIndex] ?? 0;
    return {
      productivity: cost > 0 ? progress / cost : 0,
      cost,
    };
  } // fn: getSubgenMetrics

  /**
   * Selects the next subgenerator index based on the active particle's distribution
   */
  public override next(ctx: InputSchedulerNextContext): number {
    this._ensureSwarm(ctx.subgens.length);

    const candidates = this._getAvailableCandidateIndices(ctx);
    if (candidates.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    // Step to the next particle when evaluation period T expires
    if (this._ticksInCurrentPeriod >= this._period) {
      this._updateParticleSwarm();
      this._activeParticleIdx =
        (this._activeParticleIdx + 1) % this._particles.length;
      this._ticksInCurrentPeriod = 0;
    }

    const currentParticle = this._particles[this._activeParticleIdx];

    // Compute normalized selection probabilities over currently active candidates
    let totalProb = 0;
    for (const idx of candidates) {
      totalProb += currentParticle.position[idx];
    }

    const rnd = this._prng() * totalProb;
    let cum = 0;
    let selectedIdx = candidates[0];

    for (const idx of candidates) {
      cum += currentParticle.position[idx];
      if (cum >= rnd) {
        selectedIdx = idx;
        break;
      }
    }

    this._lastSelectedSubgenIndex = selectedIdx;
    this._ticksInCurrentPeriod++;
    return selectedIdx;
  } // fn: next

  /**
   * Updates feedback stats for both the selected subgenerator and active particle
   */
  public override onInputFeedback(
    measurements: BaseMeasurement[],
    cost: number,
    measures: readonly AbstractMeasure[]
  ): void {
    if (this._lastSelectedSubgenIndex < 0 || this._particles.length === 0) {
      return;
    }

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

    // Update global subgen metrics
    this._subgenProgress[this._lastSelectedSubgenIndex] =
      (this._subgenProgress[this._lastSelectedSubgenIndex] ?? 0) +
      weightedProgress;
    this._subgenCost[this._lastSelectedSubgenIndex] =
      (this._subgenCost[this._lastSelectedSubgenIndex] ?? 0) + cost;

    // Attribute reward to active particle's current evaluation period
    const p = this._particles[this._activeParticleIdx];
    p.periodProgress += weightedProgress;
    p.periodCost += cost;
  } // fn: onInputFeedback

  /**
   * Updates particle positions and velocities using PSO dynamics at the end of period T
   */
  protected _updateParticleSwarm(): void {
    const p = this._particles[this._activeParticleIdx];
    const fitness = p.periodCost > 0 ? p.periodProgress / p.periodCost : 0;

    // 1. Update personal best
    if (fitness > p.personalBestFitness) {
      p.personalBestFitness = fitness;
      p.personalBestPos = [...p.position];
    }

    // 2. Update global swarm best
    if (fitness > this._globalBestFitness) {
      this._globalBestFitness = fitness;
      this._globalBestPos = [...p.position];
    }

    // 3. Update velocity and position
    const dim = p.position.length;
    for (let i = 0; i < dim; i++) {
      const r1 = this._prng();
      const r2 = this._prng();

      const cognitive = this._c1 * r1 * (p.personalBestPos[i] - p.position[i]);
      const social = this._c2 * r2 * (this._globalBestPos[i] - p.position[i]);

      p.velocity[i] = this._w * p.velocity[i] + cognitive + social;
      p.position[i] = Math.max(this._minProb, p.position[i] + p.velocity[i]);
    }

    // 4. Project position onto the probability simplex (sum = 1.0)
    const sum = p.position.reduce((a, b) => a + b, 0);
    for (let i = 0; i < dim; i++) {
      p.position[i] = p.position[i] / sum;
    }

    // Reset period counters for next time this particle is active
    p.periodProgress = 0;
    p.periodCost = 0;
  } // fn: _updateParticleSwarm

  /**
   * Initializes or expands particle swarm vectors for the number of subgenerators
   */
  protected _ensureSwarm(subgenCount: number): void {
    if (
      this._particles.length > 0 &&
      this._particles[0].position.length >= subgenCount
    ) {
      return;
    }

    this._particles = [];
    this._globalBestPos = Array(subgenCount).fill(1.0 / subgenCount);
    this._globalBestFitness = -1;

    for (let s = 0; s < this._swarmSize; s++) {
      // Random initial distribution on simplex
      const rawPos = Array.from({ length: subgenCount }, () =>
        Math.max(this._minProb, this._prng())
      );
      const sum = rawPos.reduce((a, b) => a + b, 0);
      const position = rawPos.map((v) => v / sum);
      const velocity = Array(subgenCount).fill(0);

      this._particles.push({
        position,
        velocity,
        personalBestPos: [...position],
        personalBestFitness: -1,
        periodProgress: 0,
        periodCost: 0,
      });
    }

    while (this._subgenProgress.length < subgenCount) {
      this._subgenProgress.push(0);
      this._subgenCost.push(0);
    }
  } // fn: _ensureSwarm
} // class: MoptScheduler

/**
 * State representing a single particle in the PSO swarm
 */
interface Particle {
  position: number[]; // Probability distribution across subgenerators
  velocity: number[]; // Velocity vector in probability space
  personalBestPos: number[]; // Personal best position
  personalBestFitness: number; // Highest fitness observed by this particle
  periodProgress: number; // Accumulated measure progress in current period T
  periodCost: number; // Accumulated cost in current period T
}
