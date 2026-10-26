import * as path from "node:path";
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
      " - Executed 85, skipped 5, interrupted 3 in-flight tests in 1240 ms"
    );
    expect(summary).toContain(
      "Testing finished. Stopped for reason: interrupted."
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
    expect(summary).toContain(" - Executed 9 and skipped 1 tests in 1240 ms");
    expect(summary).toContain(
      "Testing finished. Stopped for reason: maxTests."
    );
  });

  it("formatRunSummary hides injected count when 0 and shows when greater than 0", () => {
    const mockResultsZero = createMockResults(FuzzStopReason.MAXTESTS);
    mockResultsZero.stats.counters.inputsInjected = 0;
    mockResultsZero.stats.counters.inputsGenerated = 53;
    mockResultsZero.stats.counters.dupesGenerated = 0;

    const summaryZero = formatRunSummary(mockResultsZero);
    expect(summaryZero).toContain(" - Generated 53 inputs");
    expect(summaryZero).not.toContain("Injected");
    expect(summaryZero).not.toContain("dupes");

    const mockResultsNonZero = createMockResults(FuzzStopReason.MAXTESTS);
    mockResultsNonZero.stats.counters.inputsInjected = 4;
    mockResultsNonZero.stats.counters.inputsGenerated = 53;
    mockResultsNonZero.stats.counters.dupesGenerated = 3;

    const summaryNonZero = formatRunSummary(mockResultsNonZero);
    expect(summaryNonZero).toContain(
      " - Injected 4 and generated 53 inputs (3 were dupes)"
    );
  });

  it("formatRunSummary omits (0 were dupes) and omits and skipped 0 when none skipped or duped", () => {
    const mockResults = createMockResults(FuzzStopReason.MAXTESTS);
    mockResults.stats.counters.inputsInjected = 0;
    mockResults.stats.counters.inputsGenerated = 50;
    mockResults.stats.counters.dupesGenerated = 0;
    mockResults.stats.counters.inputsSkipped = 0;
    mockResults.stats.outcomes.total = 50;

    const summary = formatRunSummary(mockResults);
    expect(summary).toContain(" - Generated 50 inputs");
    expect(summary).not.toContain("dupes");
    expect(summary).toContain(" - Executed 50 tests in 1240 ms");
    expect(summary).not.toContain("skipped");
    expect(summary).not.toContain("this run");
  });

  it("formatRunSummary conditionally displays validator lines based on active status and presence", () => {
    const mockResults = createMockResults(FuzzStopReason.MAXTESTS);
    mockResults.stats.counters.inputsInjected = 0;
    mockResults.stats.counters.inputsGenerated = 53;
    mockResults.stats.counters.dupesGenerated = 3;
    mockResults.stats.counters.inputsSkipped = 0;
    mockResults.stats.outcomes.total = 50;
    mockResults.stats.outcomes.exceptions = 49;
    mockResults.stats.outcomes.timeouts = 0;
    mockResults.stats.counters.erroredTests = 0;
    mockResults.stats.outcomes.oracles.heuristic = {
      pass: 1,
      fail: 49,
      unknown: 0,
    };
    mockResults.stats.outcomes.oracles.human = { pass: 0, fail: 0, unknown: 0 };
    mockResults.stats.outcomes.oracles.property = {
      pass: 0,
      fail: 0,
      unknown: 0,
    };
    mockResults.env.validators = [];
    mockResults.env.options.useImplicit = true;
    mockResults.env.options.useHuman = true;
    mockResults.env.options.useProperty = true;

    // Property and human have no validators / no outcomes, heuristic has outcomes
    const summary1 = formatRunSummary(mockResults);
    expect(summary1).toContain(" - Generated 53 inputs (3 were dupes)");
    expect(summary1).toContain(" - Executed 50 tests in 1240 ms");
    expect(summary1).not.toContain("skipped");
    expect(summary1).not.toContain("this run");
    expect(summary1).toContain(
      "   - Tests with exceptions: 49, timeouts: 0, errors: 0"
    );
    expect(summary1).toContain(
      "   - Heuristic validator passed: 1, failed: 49"
    );
    expect(summary1).not.toContain("Human validator");
    expect(summary1).not.toContain("Property validator");
    expect(summary1).toContain(
      "Testing finished. Stopped for reason: maxTests."
    );

    // Activate property validators with validator ref and outcomes
    mockResults.env.validators = [
      {
        module: "test.ts",
        name: "myValidator",
        src: "",
        lang: "typescript",
        startOffset: 0,
        endOffset: 0,
        isExported: true,
        isVoid: false,
        args: [],
      },
    ];
    mockResults.stats.outcomes.oracles.property = {
      pass: 10,
      fail: 2,
      unknown: 0,
    };
    const summary2 = formatRunSummary(mockResults);
    expect(summary2).toContain("   - Property validator passed: 10, failed: 2");

    // Deactivate property validator option
    mockResults.env.options.useProperty = false;
    const summary3 = formatRunSummary(mockResults);
    expect(summary3).not.toContain("Property validator");

    // Activate human validator with outcomes
    mockResults.stats.outcomes.oracles.human = { pass: 5, fail: 1, unknown: 0 };
    const summary4 = formatRunSummary(mockResults);
    expect(summary4).toContain("   - Human validator passed: 5, failed: 1");

    // Deactivate human validator option
    mockResults.env.options.useHuman = false;
    const summary5 = formatRunSummary(mockResults);
    expect(summary5).not.toContain("Human validator");

    // Deactivate heuristic validator option
    mockResults.env.options.useImplicit = false;
    const summary6 = formatRunSummary(mockResults);
    expect(summary6).not.toContain("Heuristic validator");
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

  it("formatCompilingStatus and formatInstrumentingStatus normalize paths relative to cwd", () => {
    const cwdFile = path.join(process.cwd(), "src", "fuzzer", "Types.ts");
    const msgCompile = formatCompilingStatus({
      type: "compiling",
      file: cwdFile,
    });
    expect(msgCompile).toBe(" - Compile...: src/fuzzer/Types.ts");

    const cwdJsFile = path.join(process.cwd(), "src", "fuzzer", "Types.js");
    const msgInstrument = formatInstrumentingStatus({
      type: "instrumenting",
      file: cwdJsFile,
    });
    expect(msgInstrument).toBe(" - Instrument: src/fuzzer/Types.ts");
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
