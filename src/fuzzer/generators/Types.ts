import { BaseMeasurement } from "../measures/AbstractMeasure";
import { ArgValueTypeWrapped } from "../analysis/typescript/Types";
import { SupportedInputGenerators } from "fuzzer/Types";

/**
 * Concrete input values and their source
 */
export type InputAndSource = {
  tick: number;
  value: ArgValueTypeWrapped[];
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
