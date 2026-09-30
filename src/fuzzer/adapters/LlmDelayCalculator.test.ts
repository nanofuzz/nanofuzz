import {
  LlmDelayCalculator,
  parseDurationMs,
  parseRangeMs,
  parseJitter,
} from "./LlmDelayCalculator";

describe("src/fuzzer/adapters/LlmDelayCalculator:", () => {
  describe("parseDurationMs", () => {
    it("parses milliseconds, seconds, and plain numbers", () => {
      expect(parseDurationMs("500ms")).toBe(500);
      expect(parseDurationMs("500MS")).toBe(500);
      expect(parseDurationMs("1.5s")).toBe(1500);
      expect(parseDurationMs("0.2s")).toBe(200);
      expect(parseDurationMs("0")).toBe(0);
      expect(parseDurationMs("250")).toBe(250);
      expect(parseDurationMs("+100ms")).toBe(100);
      expect(parseDurationMs("-50ms")).toBe(-50);
    });

    it("throws on invalid duration strings", () => {
      expect(() => parseDurationMs("")).toThrowError(/Empty duration/);
      expect(() => parseDurationMs("abcms")).toThrowError(/Invalid duration/);
      expect(() => parseDurationMs("abcs")).toThrowError(/Invalid duration/);
      expect(() => parseDurationMs("invalid")).toThrowError(/Invalid duration/);
    });
  });

  describe("parseRangeMs", () => {
    it("parses valid ranges", () => {
      expect(parseRangeMs("100..500ms")).toEqual({ minMs: 100, maxMs: 500 });
      expect(parseRangeMs("[100..500ms]")).toEqual({ minMs: 100, maxMs: 500 });
      expect(parseRangeMs("0.1s..0.5s")).toEqual({ minMs: 100, maxMs: 500 });
    });

    it("throws on invalid ranges", () => {
      expect(() => parseRangeMs("100-500")).toThrowError(/Invalid range/);
      expect(() => parseRangeMs("100..")).toThrowError(/Empty duration/);
    });
  });

  describe("parseJitter", () => {
    it("parses percent and absolute jitter", () => {
      expect(parseJitter("20%")).toEqual({ type: "percent", value: 0.2 });
      expect(parseJitter("±10%")).toEqual({ type: "percent", value: 0.1 });
      expect(parseJitter("+-15%")).toEqual({ type: "percent", value: 0.15 });
      expect(parseJitter("~20%")).toEqual({ type: "percent", value: 0.2 });
      expect(parseJitter("50ms")).toEqual({ type: "absolute", value: 50 });
      expect(parseJitter("±50ms")).toEqual({ type: "absolute", value: 50 });
      expect(parseJitter("+-100ms")).toEqual({ type: "absolute", value: 100 });
      expect(parseJitter("~50ms")).toEqual({ type: "absolute", value: 50 });
    });

    it("throws on invalid jitter", () => {
      expect(() => parseJitter("abc%")).toThrowError(/Invalid jitter/);
    });
  });

  describe("LlmDelayCalculator.parse", () => {
    it("returns empty config for empty/default strings", () => {
      expect(LlmDelayCalculator.parse()).toEqual({});
      expect(LlmDelayCalculator.parse("")).toEqual({});
      expect(LlmDelayCalculator.parse("1x")).toEqual({});
      expect(LlmDelayCalculator.parse("default")).toEqual({});
      expect(LlmDelayCalculator.parse("none")).toEqual({});
    });

    it("parses individual token options", () => {
      expect(LlmDelayCalculator.parse("0")).toEqual({ fixedMs: 0 });
      expect(LlmDelayCalculator.parse("500ms")).toEqual({ fixedMs: 500 });
      expect(LlmDelayCalculator.parse("1.5s")).toEqual({ fixedMs: 1500 });
      expect(LlmDelayCalculator.parse("0.5x")).toEqual({ scale: 0.5 });
      expect(LlmDelayCalculator.parse("2x")).toEqual({ scale: 2 });
      expect(LlmDelayCalculator.parse("+100ms")).toEqual({ offsetMs: 100 });
      expect(LlmDelayCalculator.parse("-50ms")).toEqual({ offsetMs: -50 });
      expect(LlmDelayCalculator.parse("100..500ms")).toEqual({
        window: { minMs: 100, maxMs: 500 },
      });
      expect(LlmDelayCalculator.parse("~20%")).toEqual({
        jitter: { type: "percent", value: 0.2 },
      });
      expect(LlmDelayCalculator.parse("~50ms")).toEqual({
        jitter: { type: "absolute", value: 50 },
      });
      expect(LlmDelayCalculator.parse("[50..500ms]")).toEqual({
        minMs: 50,
        maxMs: 500,
      });
    });

    it("parses composed space-delimited expressions", () => {
      const parsed = LlmDelayCalculator.parse("0.5x +50ms ~10% [20..500ms]");
      expect(parsed).toEqual({
        scale: 0.5,
        offsetMs: 50,
        jitter: { type: "percent", value: 0.1 },
        minMs: 20,
        maxMs: 500,
      });

      const parsedFixedWithModifiers =
        LlmDelayCalculator.parse("200ms 2x -50ms");
      expect(parsedFixedWithModifiers).toEqual({
        fixedMs: 200,
        scale: 2,
        offsetMs: -50,
      });
    });

    it("throws on conflicting or invalid options", () => {
      // fixed and window conflict
      expect(() => LlmDelayCalculator.parse("200ms 100..500ms")).toThrowError(
        /Conflicting base delay/
      );

      // inverted window
      expect(() => LlmDelayCalculator.parse("500..100ms")).toThrowError(
        /Window minimum .* cannot be greater than window maximum/
      );

      // negative scale
      expect(() => LlmDelayCalculator.parse("-2x")).toThrowError(
        /Scale factor cannot be negative/
      );

      // inverted min/max bounds
      expect(() => LlmDelayCalculator.parse("[500..100ms]")).toThrowError(
        /Minimum delay bound .* cannot be greater than maximum/
      );
    });
  });

  describe("LlmDelayCalculator.calculate", () => {
    it("returns recorded delay unchanged by default", () => {
      expect(LlmDelayCalculator.calculate(150)).toBe(150);
      expect(LlmDelayCalculator.calculate(0)).toBe(0);
      expect(LlmDelayCalculator.calculate(-50)).toBe(0);
    });

    it("applies fixed delay", () => {
      expect(LlmDelayCalculator.calculate(150, { fixedMs: 0 })).toBe(0);
      expect(LlmDelayCalculator.calculate(150, { fixedMs: 500 })).toBe(500);
      expect(LlmDelayCalculator.calculate(0, { fixedMs: 300 })).toBe(300);
    });

    it("applies windowed delay using PRNG", () => {
      const config = { window: { minMs: 100, maxMs: 500 } };
      expect(LlmDelayCalculator.calculate(150, config, () => 0)).toBe(100);
      expect(LlmDelayCalculator.calculate(150, config, () => 0.5)).toBe(300);
      expect(LlmDelayCalculator.calculate(150, config, () => 1)).toBe(500);
    });

    it("applies scale factor", () => {
      expect(LlmDelayCalculator.calculate(200, { scale: 0.5 })).toBe(100);
      expect(LlmDelayCalculator.calculate(200, { scale: 2 })).toBe(400);
      expect(LlmDelayCalculator.calculate(200, { scale: 0 })).toBe(0);
    });

    it("applies offset and floors at 0", () => {
      expect(LlmDelayCalculator.calculate(200, { offsetMs: 50 })).toBe(250);
      expect(LlmDelayCalculator.calculate(200, { offsetMs: -50 })).toBe(150);
      expect(LlmDelayCalculator.calculate(200, { offsetMs: -300 })).toBe(0);
    });

    it("applies percent jitter", () => {
      const config = { jitter: { type: "percent" as const, value: 0.2 } };
      // u = randomFn() * 2 - 1 -> for 0, u = -1 -> 1000 * (1 - 0.2) = 800
      expect(LlmDelayCalculator.calculate(1000, config, () => 0)).toBe(800);
      // for 0.5, u = 0 -> 1000 * 1 = 1000
      expect(LlmDelayCalculator.calculate(1000, config, () => 0.5)).toBe(1000);
      // for 1, u = 1 -> 1000 * (1 + 0.2) = 1200
      expect(LlmDelayCalculator.calculate(1000, config, () => 1)).toBe(1200);
    });

    it("applies absolute jitter", () => {
      const config = { jitter: { type: "absolute" as const, value: 100 } };
      // u = randomFn() * 2 - 1 -> for 0, u = -1 -> 500 - 100 = 400
      expect(LlmDelayCalculator.calculate(500, config, () => 0)).toBe(400);
      // for 0.5, u = 0 -> 500 + 0 = 500
      expect(LlmDelayCalculator.calculate(500, config, () => 0.5)).toBe(500);
      // for 1, u = 1 -> 500 + 100 = 600
      expect(LlmDelayCalculator.calculate(500, config, () => 1)).toBe(600);
    });

    it("applies min and max clamping", () => {
      expect(LlmDelayCalculator.calculate(50, { minMs: 100, maxMs: 500 })).toBe(
        100
      );
      expect(
        LlmDelayCalculator.calculate(600, { minMs: 100, maxMs: 500 })
      ).toBe(500);
      expect(
        LlmDelayCalculator.calculate(300, { minMs: 100, maxMs: 500 })
      ).toBe(300);
    });

    it("applies composition in canonical pipeline order: base -> scale -> offset -> jitter -> clamp", () => {
      // 1. base = 1000ms
      // 2. scale = 0.5 -> 500ms
      // 3. offset = +100ms -> 600ms
      // 4. jitter = 10% with randomFn() = 1 (u = +1) -> 600 * 1.1 = 660ms
      // 5. clamp [100..500ms] -> clamped to 500ms
      const config = {
        scale: 0.5,
        offsetMs: 100,
        jitter: { type: "percent" as const, value: 0.1 },
        minMs: 100,
        maxMs: 500,
      };
      expect(LlmDelayCalculator.calculate(1000, config, () => 1)).toBe(500);

      // Without clamp triggering:
      const config2 = {
        scale: 0.5,
        offsetMs: 100,
        jitter: { type: "percent" as const, value: 0.1 },
        minMs: 100,
        maxMs: 1000,
      };
      expect(LlmDelayCalculator.calculate(1000, config2, () => 1)).toBe(660);
      expect(LlmDelayCalculator.calculate(1000, config2, () => 0.5)).toBe(600);
      expect(LlmDelayCalculator.calculate(1000, config2, () => 0)).toBe(540);
    });

    it("applies fixed base with composition", () => {
      // fixed = 200ms -> scale = 2x -> 400ms -> offset = -50ms -> 350ms
      const config = {
        fixedMs: 200,
        scale: 2,
        offsetMs: -50,
      };
      expect(LlmDelayCalculator.calculate(9999, config)).toBe(350);
    });
  });
});
