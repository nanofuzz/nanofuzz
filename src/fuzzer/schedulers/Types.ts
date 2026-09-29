import { AbstractInputGenerator } from "../generators/AbstractInputGenerator";
import { AbstractMeasure } from "../measures/AbstractMeasure";
import { NextableStatus } from "../generators/Types";

export type InputSchedulerType =
  | "mab"
  | "random"
  | "round-robin"
  | "ucb1"
  | "thompson"
  | "ewma";

/**
 * Context passed to the scheduler when selecting the next subgenerator.
 */
export interface InputSchedulerNextContext {
  tick: number;
  subgens: readonly AbstractInputGenerator[];
  activeSubgens: readonly boolean[];
  measures: readonly AbstractMeasure[];
}

/**
 * Diagnostic checkpoint recorded during subgenerator selection.
 */
export interface SchedulerCheckpoint {
  tick: number;
  gens: Record<
    string,
    {
      active: boolean;
      nextable: NextableStatus;
      productivity: number;
      cost: number;
      selected?: true;
    }
  >;
  scheduler: InputSchedulerType;
}
