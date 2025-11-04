import { BaseMeasurement } from "../measures/AbstractMeasure";
import { InputAndSource } from "fuzzer/Types";

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
