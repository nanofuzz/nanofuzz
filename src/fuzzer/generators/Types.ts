import { BaseMeasurement } from "../measures/AbstractMeasure";
import { ArgValueType } from "../analysis/typescript/Types";
import { SupportedInputGenerators } from "fuzzer/Types";

/**
 * Concrete input values and their source
 */
export type InputAndSource = {
  tick: number;
  value: ArgValueType[];
  source: {
    subgen: SupportedInputGenerators | "injected";
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
  interestingReasons: string[];
};
