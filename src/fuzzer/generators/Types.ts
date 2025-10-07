import { BaseMeasurement } from "../measures/Types";
import { ArgValueType } from "../analysis/typescript/Types";

// !!!!!!
export type InputAndSource = {
  tick: number;
  value: ArgValueType[];
  source: {
    subgen: string;
    tick?: number;
  };
};

// !!!!!!
export type ScoredInput = {
  tick: number;
  input: InputAndSource;
  score: number;
  cost: number;
  measurements: BaseMeasurement[];
};
