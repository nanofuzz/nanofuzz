import { BaseMeasurement } from "../measures/AbstractMeasure";
import { InputAndSource } from "../Types";

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

/**
 * AI Input Generator Statistics
 */
export interface InputGeneratorStatsAi extends InputGeneratorStats {
  inputs: {
    gen: number;
    invalid: number;
    invalidLater: number;
    inQueue: number;
  };
  calls: {
    sent: number;
    valid: number;
    invalid: number;
    failed: number;
    history: (
      | { success: true }
      | { discard: true }
      | { failure: true; message: string }
    )[];
  };
  tokens: {
    sent: number;
    received: number;
    sentCost?: { amt: number; unit: string };
    receivedCost?: { amt: number; unit: string };
  };
}

/**
 * Input-generator specific stats
 */
export type InputGeneratorStats = {
  [k: string]:
    | string
    | number
    | boolean
    | undefined
    | InputGeneratorStats
    | InputGeneratorStats[];
};
