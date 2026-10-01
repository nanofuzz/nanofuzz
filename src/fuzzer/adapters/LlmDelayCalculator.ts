/**
 * Calculator and parser for perturbing recorded LLM response latencies when
 * replaying cached responses in NaNofuzz.
 *
 * Supported space-separated token syntax:
 * - Fixed delay: '0', '500ms', '1.5s'
 * - Windowed delay: '100..500ms', '0.1s..0.5s'
 * - Scaling: '0.5x', '2x'
 * - Offset: '+100ms', '-50ms'
 * - Jitter: '~20%', '~50ms'
 * - Clamping: '[50..500ms]'
 * - Compositions: Space-delimited tokens (e.g. '0.5x +50ms ~20% [50..500ms]')
 *
 * Conflict Resolution:
 * - 'fixed' and 'window' are mutually exclusive base generators.
 * - Inverted ranges and negative limits throw errors.
 * - Computed effective delays are floored at 0 ms.
 */
export class LlmDelayCalculator {
  /**
   * Parses a delay perturbation specification string into a configuration.
   */
  public static parse(spec?: string): LlmCacheDelayConfig {
    if (!spec) {
      return {};
    }

    const trimmed = spec.trim();
    if (
      !trimmed ||
      trimmed === "1x" ||
      trimmed === "default" ||
      trimmed === "none"
    ) {
      return {};
    }

    const config: LlmCacheDelayConfig = {};

    // Split by whitespace, ignoring spaces inside brackets
    const tokens: string[] = [];
    let current = "";
    let inBracket = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "[") {
        inBracket = true;
        current += ch;
      } else if (ch === "]") {
        inBracket = false;
        current += ch;
      } else if (/\s/.test(ch) && !inBracket) {
        if (current.trim()) tokens.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) tokens.push(current.trim());

    for (const token of tokens) {
      if (token.startsWith("[") && token.endsWith("]")) {
        const range = parseRangeMs(token);
        config.minMs = range.minMs;
        config.maxMs = range.maxMs;
      } else if (token.includes("..")) {
        config.window = parseRangeMs(token);
      } else if (
        token.startsWith("~") ||
        token.startsWith("±") ||
        token.startsWith("+-") ||
        token.endsWith("%")
      ) {
        config.jitter = parseJitter(token);
      } else if (
        token.toLowerCase().endsWith("x") &&
        !isNaN(parseFloat(token.slice(0, -1)))
      ) {
        config.scale = parseFloat(token.slice(0, -1));
      } else if (token.startsWith("+") || token.startsWith("-")) {
        config.offsetMs = parseDurationMs(token);
      } else {
        config.fixedMs = parseDurationMs(token);
      }
    }

    LlmDelayCalculator.validate(config);
    return config;
  } // fn: parse

  /**
   * Validates parsed configuration for semantic conflicts.
   */
  public static validate(config: LlmCacheDelayConfig): void {
    if (config.fixedMs !== undefined && config.window !== undefined) {
      throw new Error(
        `Conflicting base delay: cannot specify both 'fixed' and 'window'`
      );
    }

    if (config.fixedMs !== undefined && config.fixedMs < 0) {
      throw new Error(`Fixed delay cannot be negative (${config.fixedMs}ms)`);
    }

    if (config.window !== undefined) {
      if (config.window.minMs < 0 || config.window.maxMs < 0) {
        throw new Error(
          `Window delay bounds cannot be negative ([${config.window.minMs}..${config.window.maxMs}]ms)`
        );
      }
      if (config.window.minMs > config.window.maxMs) {
        throw new Error(
          `Window minimum (${config.window.minMs}ms) cannot be greater than window maximum (${config.window.maxMs}ms)`
        );
      }
    }

    if (config.scale !== undefined && config.scale < 0) {
      throw new Error(`Scale factor cannot be negative (${config.scale})`);
    }

    if (config.jitter !== undefined && config.jitter.value < 0) {
      throw new Error(
        `Jitter value cannot be negative (${config.jitter.value})`
      );
    }

    if (config.minMs !== undefined && config.minMs < 0) {
      throw new Error(
        `Minimum delay bound cannot be negative (${config.minMs}ms)`
      );
    }

    if (config.maxMs !== undefined && config.maxMs < 0) {
      throw new Error(
        `Maximum delay bound cannot be negative (${config.maxMs}ms)`
      );
    }

    if (
      config.minMs !== undefined &&
      config.maxMs !== undefined &&
      config.minMs > config.maxMs
    ) {
      throw new Error(
        `Minimum delay bound (${config.minMs}ms) cannot be greater than maximum delay bound (${config.maxMs}ms)`
      );
    }
  } // fn: validate

  /**
   * Calculates the effective delay in milliseconds for a replayed response.
   */
  public static calculate(
    recordedDelayMs: number,
    config?: LlmCacheDelayConfig,
    randomFn: () => number = Math.random
  ): number {
    if (!config) {
      return Math.max(0, Math.round(recordedDelayMs));
    }

    // 1. Base Delay Selection
    let d: number;
    if (config.fixedMs !== undefined) {
      d = config.fixedMs;
    } else if (config.window !== undefined) {
      const u = randomFn();
      d = config.window.minMs + u * (config.window.maxMs - config.window.minMs);
    } else {
      d = recordedDelayMs;
    }

    // 2. Scale Factor
    if (config.scale !== undefined) {
      d *= config.scale;
    }

    // 3. Additive Offset
    if (config.offsetMs !== undefined) {
      d += config.offsetMs;
    }

    // 4. Jitter Perturbation
    if (config.jitter !== undefined) {
      const u = randomFn() * 2 - 1; // [-1, 1]
      if (config.jitter.type === "percent") {
        d *= 1 + u * config.jitter.value;
      } else {
        d += u * config.jitter.value;
      }
    }

    // 5. Clamping Bounds
    if (config.minMs !== undefined) {
      d = Math.max(config.minMs, d);
    }
    if (config.maxMs !== undefined) {
      d = Math.min(config.maxMs, d);
    }

    // 6. Non-negative Floor & Integer Rounding
    return Math.max(0, Math.round(d));
  } // fn: calculate
} // class: LlmDelayCalculator

// ----------------------------------- Types ---------------------------------- //

/**
 * LLM Cache Delay Perturbation Configuration
 */
export type LlmCacheDelayConfig = {
  fixedMs?: number;
  window?: { minMs: number; maxMs: number };
  scale?: number;
  offsetMs?: number;
  jitter?: { type: "percent" | "absolute"; value: number };
  minMs?: number;
  maxMs?: number;
};

// ------------------------------ Helper Functions ----------------------------- //

/**
 * Parses duration strings like "500ms", "1.5s", "500" into milliseconds.
 */
export function parseDurationMs(val: string): number {
  const trimmed = val.trim();
  if (!trimmed) {
    throw new Error(`Empty duration string`);
  }

  const lower = trimmed.toLowerCase();
  if (lower.endsWith("ms")) {
    const num = parseFloat(lower.slice(0, -2));
    if (isNaN(num)) {
      throw new Error(`Invalid duration in milliseconds: '${trimmed}'`);
    }
    return num;
  }

  if (lower.endsWith("s")) {
    const num = parseFloat(lower.slice(0, -1));
    if (isNaN(num)) {
      throw new Error(`Invalid duration in seconds: '${trimmed}'`);
    }
    return num * 1000;
  }

  const num = parseFloat(trimmed);
  if (isNaN(num)) {
    throw new Error(`Invalid duration number: '${trimmed}'`);
  }
  return num;
} // fn: parseDurationMs

/**
 * Parses range strings like "100..500ms" or "0.1s..0.5s" into { minMs, maxMs }.
 */
export function parseRangeMs(val: string): { minMs: number; maxMs: number } {
  const cleaned = val.trim().replace(/^\[/, "").replace(/\]$/, "");
  const parts = cleaned.split("..");
  if (parts.length !== 2) {
    throw new Error(
      `Invalid range format '${val}'. Expected format 'min..max' (e.g., '100..500ms')`
    );
  }
  const minMs = parseDurationMs(parts[0]);
  const maxMs = parseDurationMs(parts[1]);
  return { minMs, maxMs };
} // fn: parseRangeMs

/**
 * Parses jitter strings like "20%", "~20%", "±10%", "50ms", "~50ms", "±50ms".
 */
export function parseJitter(val: string): {
  type: "percent" | "absolute";
  value: number;
} {
  let cleaned = val.trim();
  if (cleaned.startsWith("±")) {
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith("+-")) {
    cleaned = cleaned.slice(2).trim();
  } else if (cleaned.startsWith("~")) {
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1).trim();
  }

  if (cleaned.endsWith("%")) {
    const pct = parseFloat(cleaned.slice(0, -1));
    if (isNaN(pct)) {
      throw new Error(`Invalid jitter percentage: '${val}'`);
    }
    return { type: "percent", value: pct / 100 };
  }

  const ms = parseDurationMs(cleaned);
  return { type: "absolute", value: ms };
} // fn: parseJitter
