import {
  formatTestingStatus,
  formatWaitingStatus,
  formatCompilingStatus,
  formatInstrumentingStatus,
  formatTestingCompleteStatus,
  formatRunStatsSummary,
  formatExceptionAndStack,
  normalizeDisplayPath,
} from "./FuzzTextFormatter";
import { CurrentRunStats } from "../fuzzer/Types";

describe("ui/FuzzTextFormatter", () => {
  const emptyStats: CurrentRunStats = {
    counters: {
      inputsInjected: 0,
      inputsGenerated: 10,
      dupesGenerated: 2,
      dupesSequential: 0,
      erroredTests: 0,
      failedTests: 1,
      passedTests: 9,
      inputsSkipped: 1,
    },
    outcomes: {
      total: 10,
      exceptions: 0,
      timeouts: 0,
      categories: {
        ok: 9,
        badValue: 1,
        timeout: 0,
        exception: 0,
        skip: 1,
        disagree: 0,
        failure: 0,
      },
      oracles: {
        heuristic: { pass: 10, fail: 0, unknown: 0 },
        human: { pass: 0, fail: 0, unknown: 10 },
        property: { pass: 9, fail: 1, unknown: 0 },
      },
      firstFailure: undefined,
    },
    timers: {
      startTime: 0,
      startGenTime: 0,
    },
  };

  it("formatRunStatsSummary formats passed, failed, and skipped counts", () => {
    const summary = formatRunStatsSummary(emptyStats);
    expect(summary).toContain("Passed: 9");
    expect(summary).toContain("Failed: 1");
    expect(summary).toContain("Skipped: 1");
  });

  it("formatTestingStatus formats input execution message", () => {
    const msg = formatTestingStatus({
      type: "testing",
      fnName: "myTarget",
      lang: "typescript",
      inputs: [42, "hello"],
      stats: emptyStats,
      pct: 50,
      stillInjecting: false,
      isCancelled: false,
    });
    expect(msg).toContain("Testing new input# 11: myTarget(42,");
    expect(msg).toContain("Passed: 9");
  });

  it("formatWaitingStatus formats waiting message for pending generators", () => {
    const msg = formatWaitingStatus({
      type: "waiting-for-generator",
      pendingGenerators: ["AI", "Mutation"],
      stats: emptyStats,
      pct: 0,
    });
    expect(msg).toContain("Waiting for AI, Mutation input generator...");
    expect(msg).toContain("Passed: 9");
  });

  it("formatCompilingStatus formats compilation message", () => {
    const msg = formatCompilingStatus({
      type: "compiling",
      file: "/path/to/foo.ts",
    });
    expect(msg).toBe(" - Compile...: /path/to/foo.ts");
  });

  it("formatInstrumentingStatus formats instrumentation message", () => {
    const msg = formatInstrumentingStatus({
      type: "instrumenting",
      file: "/path/to/foo.ts",
    });
    expect(msg).toBe(" - Instrument: /path/to/foo.ts");
  });

  it("formatTestingCompleteStatus formats completion message", () => {
    const msg = formatTestingCompleteStatus({
      type: "testing-complete",
      cancelled: false,
      pct: 100,
    });
    expect(msg).toBe("Testing finished.");
  });

  it("normalizeDisplayPath strips temporary compilation directories", () => {
    const norm = normalizeDisplayPath(
      "/tmp/nanofuzz/tsc/inst-abcd1234/src/foo.ts",
      "/tmp/nanofuzz/tsc"
    );
    expect(norm).toContain("src");
    expect(norm).toContain("foo.ts");
  });

  it("formatExceptionAndStack extracts message and formatted stack lines", () => {
    const res = formatExceptionAndStack(
      "Some error",
      "Error: Some error\n    at foo (bar.ts:1:1)"
    );
    expect(res.excLine).toContain("Some error");
    expect(res.stackLines.length).toBeGreaterThan(0);
  });
});
