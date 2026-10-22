import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CoverageMeasure } from "./CoverageMeasure";
import { RustRunner } from "../runners/rust/RustRunner";
import { instrumentRustSource } from "../runners/rust/RustHarness";
import { ArgDef } from "../analysis/ArgDef";
import { FunctionDef } from "../analysis/FunctionDef";
import * as ProgramFactory from "../analysis/ProgramFactory";
import * as Parser from "../adapters/ParserAdapter";
import {
  FuzzEnv,
  FuzzStopReason,
  FuzzTestResult,
  FuzzTestResults,
} from "../Types";
import { getDefaultFuzzExecutionOptions } from "../FuzzerFactory";

describe("fuzzer/measures/CoverageMeasure: Rust", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-rustcov-test-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("extracts static coverage from Rust source (statements, functions, branches)", () => {
    const src = `pub fn abs(x: i32) -> i32 {
    let mut res = x;
    if x < 0 {
        res = -x;
    } else {
        res = x;
    }
    res
}
`;
    const { staticCov, instrumentedSrc } = instrumentRustSource(
      src,
      "/test/abs.rs"
    );

    expect(Object.keys(staticCov.statementMap).length).toBe(3);
    expect(Object.keys(staticCov.fnMap).length).toBe(1);
    expect(staticCov.fnMap["0"].name).toBe("abs");
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(2);

    expect(instrumentedSrc).toContain("nanofuzz_runtime::coverage::hit_stmt");
    expect(instrumentedSrc).toContain("nanofuzz_runtime::coverage::hit_fn");
    expect(instrumentedSrc).toContain("nanofuzz_runtime::coverage::hit_branch");
  });

  it("extracts branches with bypass exits for if without else", () => {
    const src = `pub fn clamp_positive(n: i32) -> i32 {
    let mut val = n;
    if val < 0 {
        val = 0;
    }
    val
}
`;
    const { staticCov, instrumentedSrc } = instrumentRustSource(
      src,
      "/test/clamp.rs"
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    const branch = staticCov.branchMap["0"];
    expect(branch.locations.length).toBe(2);
    expect(instrumentedSrc).toContain(
      "else { nanofuzz_runtime::coverage::hit_branch(0, 0, 1); }"
    );
  });

  it("extracts match branches for each match arm", () => {
    const src = `pub fn classify(n: i32) -> &'static str {
    match n {
        0 => "zero",
        1..=10 => "small",
        _ => "large",
    }
}
`;
    const { staticCov, branchArms } = instrumentRustSource(
      src,
      "/test/classify.rs"
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(3);
    expect(branchArms[0]).toEqual([0, 3]);
  });

  it("instruments source with a specified fileId for multi-file coverage", () => {
    const src = `pub fn helper(x: i32) -> i32 {
    if x > 0 {
        x + 1
    } else {
        x - 1
    }
}
`;
    const { instrumentedSrc } = instrumentRustSource(
      src,
      "/test/helper.rs",
      42
    );
    expect(instrumentedSrc).toContain(
      "nanofuzz_runtime::coverage::hit_fn(42, 0);"
    );
    expect(instrumentedSrc).toContain(
      "nanofuzz_runtime::coverage::hit_stmt(42,"
    );
    expect(instrumentedSrc).toContain(
      "nanofuzz_runtime::coverage::hit_branch(42, 0, 0);"
    );
    expect(instrumentedSrc).toContain(
      "nanofuzz_runtime::coverage::hit_branch(42, 0, 1);"
    );
  });

  it("tracks dynamic line, function, and branch coverage during RustRunner execution", async () => {
    const rsPath = path.join(tempDir, "abs.rs");
    const rsCode = `pub fn abs(x: i32) -> i32 {
    let mut res = x;
    if x < 0 {
        res = -x;
    } else {
        res = x;
    }
    res
}
`;
    fs.writeFileSync(rsPath, rsCode);

    const program = ProgramFactory.fromFile(rsPath, "rust");
    const fnDef = program.functionsExported["abs"];
    const env = createTestEnv(fnDef);

    const runner = new RustRunner(rsPath, "abs", env);
    await runner.onRunStart();

    const measure = new CoverageMeasure();
    measure.onRunStart([runner], env);

    // Initial static coverage should be registered in measure
    expect(runner.coverageInfo).toBeDefined();

    // 1. Run with negative input (hits if branch: then-block)
    measure.onBeforeNextTestExecution();
    const resNegative = await runner.run([-5], 5000);
    expect(resNegative.result.tag).toBe("value");

    const measurement1 = measure.measure(
      {
        tick: 0,
        value: [{ tag: "ArgValueTypeWrapped", value: [-5] }],
        source: { type: "generator", generator: "RandomInputGenerator" },
      },
      createDummyResult()
    );

    const currentSummary1 =
      measurement1.coverageMeasure.current.getCoverageSummary();
    expect(currentSummary1.statements.total).toBeGreaterThan(0);
    expect(currentSummary1.statements.covered).toBeGreaterThan(0);
    expect(currentSummary1.functions.covered).toBe(1);
    expect(currentSummary1.branches.covered).toBe(1);

    // 2. Run with positive input (hits else branch, introducing new global coverage)
    measure.onBeforeNextTestExecution();
    const resPositive = await runner.run([10], 5000);
    expect(resPositive.result.tag).toBe("value");

    const measurement2 = measure.measure(
      {
        tick: 1,
        value: [{ tag: "ArgValueTypeWrapped", value: [10] }],
        source: { type: "generator", generator: "RandomInputGenerator" },
      },
      createDummyResult()
    );

    const currentSummary2 =
      measurement2.coverageMeasure.current.getCoverageSummary();
    expect(currentSummary2.branches.covered).toBe(1);
    expect(measurement2.coverageMeasure.globalDelta).toBeGreaterThan(0);

    // 3. Finalize run and verify cumulative coverage across both runs
    const dummyGenStats = {
      counters: { inputsGenerated: 2, dupesGenerated: 0, dupeTicks: [] },
      timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
    };
    const resultsStub: FuzzTestResults = {
      toolVersion: "0.0.0",
      env,
      stopReason: FuzzStopReason.MAXTESTS,
      interesting: { inputs: [] },
      results: [],
      stats: {
        counters: {
          testingRuns: 1,
          inputsGenerated: 2,
          dupesGenerated: 0,
          inputsInjected: 0,
          erroredTests: 0,
          passedTests: 2,
          inputsSkipped: 0,
          inputsInterrupted: 0,
          failedTests: 0,
        },
        timers: {
          total: 10,
          compile: 0,
          instrument: 0,
          put: 10,
          val: 0,
          gen: 0,
          transform: 0,
          measure: 0,
        },
        outcomes: {
          total: 0,
          oracles: {
            heuristic: { pass: 0, fail: 0, unknown: 0 },
            human: { fail: 0, unknown: 0, pass: 0 },
            property: { fail: 0, unknown: 0, pass: 0 },
          },
          exceptions: 0,
          timeouts: 0,
          categories: {
            ok: 2,
            badValue: 0,
            timeout: 0,
            exception: 0,
            skip: 0,
            disagree: 0,
            failure: 0,
          },
        },
        generators: {
          RandomInputGenerator: dummyGenStats,
          MutationInputGenerator: dummyGenStats,
          AiInputGenerator: dummyGenStats,
          UserInputGenerator: dummyGenStats,
        },
        measures: {},
      },
    };

    measure.onRunEnd(resultsStub);
    const finalStats = await resultsStub.stats.measures.CodeCoverageMeasure!();
    expect(finalStats.counters.statementsCovered).toBe(
      finalStats.counters.statementsTotal
    );
    expect(finalStats.counters.functionsCovered).toBe(1);
    expect(finalStats.counters.branchesCovered).toBe(2);
    expect(finalStats.counters.branchesTotal).toBe(2);

    await runner.onRunEnd();
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

function createTestEnv(fnDef: FunctionDef): FuzzEnv {
  return {
    function: fnDef,
    options: {
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: 100,
      maxDupeInputs: 50,
      maxFailures: 0,
      fnTimeout: 100,
      suiteTimeout: 0,
      useImplicit: true,
      useHuman: false,
      useProperty: false,
      useTransformer: false,
      measures: {
        CoverageMeasure: { enabled: true, weight: 1 },
        FailedTestMeasure: { enabled: true, weight: 1 },
      },
      generators: {
        RandomInputGenerator: { enabled: true },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: false },
        UserInputGenerator: { enabled: false },
      },
    },
    executionOptions: getDefaultFuzzExecutionOptions(),
    validators: [],
    transformers: [],
    userGenerators: [],
  };
} // fn: createTestEnv

function createDummyResult(): FuzzTestResult {
  return {
    pinned: false,
    inputGenerated: {
      tick: 0,
      value: [],
      source: { type: "generator", generator: "RandomInputGenerator" },
    },
    input: [],
    output: [],
    exception: false,
    skipped: false,
    timeout: false,
    passedImplicit: "pass",
    passedHuman: "unknown",
    passedValidator: "pass",
    passedValidators: [],
    harnessErrors: [],
    timers: { gen: 0, transform: 0, run: 0 },
    category: "ok",
    interestingReasons: [],
  };
} // fn: createDummyResult
