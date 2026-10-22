import {
  formatTestingStatus,
  formatWaitingStatus,
  formatCompilingStatus,
  formatInstrumentingStatus,
  formatTestingCompleteStatus,
  formatRunStatsSummary,
  formatRunSummary,
  formatExceptionAndStack,
  normalizeDisplayPath,
} from "./FuzzTextFormatter";
import {
  CurrentRunStats,
  FuzzStopReason,
  FuzzTestResults,
} from "../fuzzer/Types";
import { FuzzStats } from "../fuzzer/FuzzStats";
import { FunctionDef } from "../fuzzer/analysis/FunctionDef";
import { FunctionRef } from "../fuzzer/analysis/Types";
import { FuzzConfigStore } from "../fuzzer/FuzzConfigStore";

function createMockResults(stopReason: FuzzStopReason): FuzzTestResults {
  const fnRef: FunctionRef = {
    module: "test.ts",
    name: "myFn",
    src: "",
    lang: "typescript",
    startOffset: 0,
    endOffset: 0,
    isExported: true,
    isVoid: false,
    args: [],
  };
  const fnDef = FunctionDef.fromFunctionRef(fnRef);
  const stats = new FuzzStats(
    FuzzConfigStore.getDefaultFuzzOptions(),
    fnDef,
    [],
    [],
    [],
    {
      engine: "v1",
      workers: 1,
      outputResults: "all",
      precompile: false,
    }
  );
  const results = stats.results;
  results.stopReason = stopReason;
  results.stats.timers.total = 1240;
  return results;
} // fn: createMockResults

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
      inputsInterrupted: 0,
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

  it("formatRunSummary formats interrupted in-flight count and translates pause to interrupted", () => {
    const mockResults = createMockResults(FuzzStopReason.PAUSE);
    mockResults.stats.counters.inputsGenerated = 90;
    mockResults.stats.counters.passedTests = 85;
    mockResults.stats.counters.inputsSkipped = 5;
    mockResults.stats.counters.inputsInterrupted = 3;
    mockResults.stats.outcomes.total = 85;

    const summary = formatRunSummary(mockResults);
    expect(summary).toContain(
      " - Executed 85, skipped 5, interrupted 3 in-flight tests in 1240 ms this run. Stopped for reason: interrupted."
    );
  });

  it("formatRunSummary formats non-interrupted runs without interrupted count", () => {
    const mockResults = createMockResults(FuzzStopReason.MAXTESTS);
    mockResults.stats.counters.inputsGenerated = 10;
    mockResults.stats.counters.passedTests = 9;
    mockResults.stats.counters.inputsSkipped = 1;
    mockResults.stats.counters.inputsInterrupted = 0;
    mockResults.stats.outcomes.total = 9;

    const summary = formatRunSummary(mockResults);
    expect(summary).toContain(
      " - Executed 9 and skipped 1 tests in 1240 ms this run. Stopped for reason: maxTests."
    );
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
