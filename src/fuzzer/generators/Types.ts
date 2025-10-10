import { BaseMeasurement } from "../measures/AbstractMeasure";
import { ArgValueType } from "../analysis/typescript/Types";

/**
 * Concrete input values and their source
 */
export type InputAndSource = {
  tick: number;
  value: ArgValueType[];
  source: {
    subgen: string;
    tick?: number;
  };
};

/**
 * A scored input with its measurements
 */
export type ScoredInput = {
  tick: number;
  input: InputAndSource;
  score: number;
  cost: number;
  measurements: BaseMeasurement[];
};
