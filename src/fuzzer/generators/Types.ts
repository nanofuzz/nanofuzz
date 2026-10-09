import { BaseMeasurement } from "../measures/AbstractMeasure";
import { InputAndSource } from "../Types";

/**
 * Tri-state availability status for input generators:
 * - "now!": high-priority input is immediately available in memory (e.g. pinned/human inputs)
 * - "now": input is immediately available in memory
 * - "soon": input generation is in-flight asynchronously (e.g. LLM call)
 * - false: generator is exhausted and no background work is pending
 */
export type NextableStatus = "now!" | "now" | "soon" | false;

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
 * LLM Cache File Header & Payload
 */
export type LlmCacheFile = {
  toolVersion: string;
  recordings: LlmCacheEntry[];
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

/**
 * Thrown when autonomous input generation is suppressed (e.g., when reaching the
 * sequential duplicate input threshold or when all input generators are disabled)
 * and all injected/pinned inputs have already been exhausted.
 *
 * This dedicated error subclass allows fuzzer engines to cleanly differentiate normal
 * input generator exhaustion from internal generator bugs, arity mismatches, or crashes.
 */
export class GeneratorExhaustedError extends Error {
  public constructor(
    message: string = "Injected inputs exhausted and input generators are suppressed."
  ) {
    super(message);
    this.name = "GeneratorExhaustedError";
  } // fn: constructor
} // class: GeneratorExhaustedError
