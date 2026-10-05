import seedrandom from "seedrandom";
import { AbstractMeasure, BaseMeasurement } from "../measures/AbstractMeasure";
import { FuzzTestResults } from "../Fuzzer";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Abstract class of an input generator scheduler
 */
export abstract class AbstractInputScheduler {
  protected _prng; // pseudo random number generator
  protected _rngSeed?: string; // seed for pseudo random number generator
  protected _lastSelectedSubgenIndex = -1; // last selected subgen index

  /**
   * Create a new input generator scheduler
   *
   * @param `rngSeed` seed for pseudo random number generator
   */
  public constructor(rngSeed: string | undefined) {
    this._rngSeed = rngSeed;
    this._prng =
      rngSeed && rngSeed.length > 0 ? seedrandom(rngSeed) : seedrandom();
  } // fn: constructor

  /**
   * Returns the input scheduler's name
   */
  public get name(): string {
    return this.constructor.name;
  } // property: get name

  /**
   * Returns the input scheduler's human-readable name
   */
  public get humanName(): string {
    return this.name.replace("Scheduler", "");
  } // property: get humanName

  /**
   * Returns the scheduler type identifier ("mab", "random", "round-robin")
   */
  public abstract get type(): InputSchedulerType;

  /**
   * Whether this scheduler consumes input execution feedback.
   * Defaults to false; overridden by stateful/adaptive schedulers (e.g. MAB).
   */
  public get needsFeedback(): boolean {
    return false;
  } // property: get needsFeedback

  /**
   * Selects the index of the next subgenerator among active generators reporting "now".
   */
  public abstract next(ctx: InputSchedulerNextContext): number;

  /**
   * Returns metrics (productivity and cost) for a given subgenerator index.
   * Default returns zeros for non-metric schedulers.
   */
  public getSubgenMetrics(_subgenIndex: number): {
    productivity: number;
    cost: number;
  } {
    return { productivity: 0, cost: 0 };
  } // fn: getSubgenMetrics

  /**
   * Receives feedback for the last generated input.
   * Only called if `needsFeedback === true`.
   */
  public onInputFeedback(
    _measurements: BaseMeasurement[],
    _cost: number,
    _measures: readonly AbstractMeasure[]
  ): void {
    // Default no-op
  } // fn: onInputFeedback

  /**
   * Lifecycle hook when a test run starts or resumes
   */
  public onRunStart(): void {
    // Default no-op
  } // fn: onRunStart

  /**
   * Lifecycle hook when a test run completes
   */
  public onRunEnd(_results?: FuzzTestResults): void {
    // Default no-op
  } // fn: onRunEnd

  /**
   * Helper to get candidate indices of subgens that are active and ready ("now")
   */
  protected _getAvailableCandidateIndices(
    ctx: InputSchedulerNextContext
  ): number[] {
    const candidates: number[] = [];
    for (let i = 0; i < ctx.subgens.length; i++) {
      if (ctx.activeSubgens[i] && ctx.subgens[i].nextable() === "now") {
        candidates.push(i);
      }
    }
    return candidates;
  } // fn: _getAvailableCandidateIndices
} // class: AbstractInputScheduler
