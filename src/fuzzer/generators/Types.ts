import { BaseMeasurement } from "../measures/AbstractMeasure";
import { InputAndSource } from "../Types";

/**
 * LLM Cache Modes
 */
export type LlmCacheMode =
  | "passthrough"
  | "record"
  | "replay-record"
  | "replay-error"
  | "replay-passthrough";

/**
 * LLM Cache Entry
 */
export type LlmCacheEntry = {
  key: string;
  request: {
    provider: string;
    modelName: string;
    prompt: string[];
    schemaJson?: string;
  };
  response: LlmQueryResult;
  delayMs: number;
  recordedAt: string;
};

/**
 * LLM Cache Statistics
 */
export type LlmCacheStats = {
  mode: LlmCacheMode;
  calls: number;
  hits: number;
  misses: number;
  recorded: number;
  passedThroughUnrecorded: number;
  failures: number;
  live: {
    calls: number;
    tokensSent: number;
    tokensReceived: number;
    costUsd: number;
  };
  replayed: {
    calls: number;
    tokensSent: number;
    tokensReceived: number;
    costUsd: number;
  };
};

/**
 * LLM Query Result
 */
export type LlmQueryResult = {
  text: string;
  stats: {
    tokensSent: number;
    tokensSentCost: { amt: number; unit: string };
    tokensReceived: number;
    tokensReceivedCost: { amt: number; unit: string };
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
  cache?: LlmCacheStats;
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
