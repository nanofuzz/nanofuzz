import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Random subgenerator scheduler.
 * Uniformly selects from active subgenerators that are immediately available ("now").
 */
export class RandomScheduler extends AbstractInputScheduler {
  /**
   * Returns the scheduler type identifier
   */
  public override get type(): InputSchedulerType {
    return "random";
  } // property: get type

  /**
   * Selects the next subgenerator index uniformly at random among "now" subgenerators.
   */
  public override next(ctx: InputSchedulerNextContext): number {
    const candidateIndices = this._getAvailableCandidateIndices(ctx);
    if (candidateIndices.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    const selectedIdx =
      candidateIndices[Math.floor(this._prng() * candidateIndices.length)];
    this._lastSelectedSubgenIndex = selectedIdx;
    return selectedIdx;
  } // fn: next
} // class: RandomScheduler
