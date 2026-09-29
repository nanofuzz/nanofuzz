import { AbstractInputScheduler } from "./AbstractInputScheduler";
import { InputSchedulerNextContext, InputSchedulerType } from "./Types";

/**
 * Round-robin subgenerator scheduler.
 *
 * References:
 *   L. Kleinrock,
 *   “Analysis of a time-shared processor†,”
 *   Naval Research Logistics Quarterly, vol. 11, no. 1, pp. 59–73,
 *   Mar. 1964, doi: 10.1002/nav.3800110105.
 *
 * Sequentially selects the next available subgenerator ("now") in cyclic order.
 */
export class RoundRobinScheduler extends AbstractInputScheduler {
  protected _cursor = -1; // cursor tracking the last chosen subgenerator index

  /**
   * Returns the scheduler type identifier
   */
  public override get type(): InputSchedulerType {
    return "round-robin";
  } // property: get type

  /**
   * Selects the next subgenerator index sequentially in round-robin order.
   */
  public override next(ctx: InputSchedulerNextContext): number {
    const candidateIndices = this._getAvailableCandidateIndices(ctx);
    if (candidateIndices.length === 0) {
      throw new Error(
        `Cannot generate the next input: no subgens are available (out of ${ctx.subgens.length} subgens configured)`
      );
    }

    // Find the next candidate strictly after _cursor, otherwise wrap to beginning
    const nextCandidate = candidateIndices.find((idx) => idx > this._cursor);
    const selectedIdx =
      nextCandidate !== undefined ? nextCandidate : candidateIndices[0];

    this._cursor = selectedIdx;
    this._lastSelectedSubgenIndex = selectedIdx;
    return selectedIdx;
  } // fn: next
} // class: RoundRobinScheduler
