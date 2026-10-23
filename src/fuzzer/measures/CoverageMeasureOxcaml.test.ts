import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as Config from "../../Config";
import { CoverageMeasure } from "./CoverageMeasure";
import { OxcamlRunner } from "../runners/oxcaml/OxcamlRunner";
import { instrumentOxcamlSource } from "../runners/oxcaml/OxcamlHarness";
import { OxcamlCompiler } from "../compilers/oxcaml/OxcamlCompiler";
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

describe("fuzzer/measures/CoverageMeasure: OCaml / OxCaml", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-oxcamlcov-test-")
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

  it("extracts static coverage from OCaml source (statements, functions, branches)", () => {
    const src = `let abs_val (x : int) : int =
  let res = x in
  if x < 0 then
    -x
  else
    res
`;
    const { staticCov, instrumentedSrc } = instrumentOxcamlSource(
      src,
      "/test/abs.ml"
    );

    expect(Object.keys(staticCov.statementMap).length).toBeGreaterThan(0);
    expect(Object.keys(staticCov.fnMap).length).toBe(1);
    expect(staticCov.fnMap["0"].name).toBe("abs_val");
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(2);

    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_stmt");
    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_fn");
    expect(instrumentedSrc).toContain("Nanofuzz_runtime.Coverage.hit_branch");
  });

  it("extracts branches with bypass exits for if without else", () => {
    const src = `let clamp_positive (n : int) : unit =
  if n < 0 then
    print_string "negative"
`;
    const { staticCov, instrumentedSrc } = instrumentOxcamlSource(
      src,
      "/test/clamp.ml"
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    const branch = staticCov.branchMap["0"];
    expect(branch.locations.length).toBe(2);
    expect(instrumentedSrc).toContain(
      "else (Nanofuzz_runtime.Coverage.hit_branch 0 0 1; ())"
    );
  });

  it("extracts pattern match branches for each match arm", () => {
    const src = `let classify (n : int) : string =
  match n with
  | 0 -> "zero"
  | 1 -> "one"
  | _ -> "other"
`;
    const { staticCov, branchArms } = instrumentOxcamlSource(
      src,
      "/test/classify.ml"
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(3);
    expect(branchArms[0]).toEqual([0, 3]);
  });

  it("tracks dynamic line, function, and branch coverage during OxcamlRunner execution", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const mlPath = path.join(tempDir, "abs.ml");
    const mlCode = `let abs_fn (x : int) : int =
  if x < 0 then
    -x
  else
    x
`;
    fs.writeFileSync(mlPath, mlCode);

    const program = ProgramFactory.fromFile(mlPath, "oxcaml");
    const fnDef = program.functionsExported["abs_fn"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(mlPath, "abs_fn", env);
    await runner.onRunStart();

    const measure = new CoverageMeasure();
    measure.onRunStart([runner], env);

    // Initial static coverage should be registered in measure
    expect(runner.coverageInfo).toBeDefined();

    // 1. Run with negative input (hits then branch: -x)
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

  it("tracks multi-file coverage across local modules in project scope", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const entryPath = path.join(tempDir, "entry.ml");
    const helperPath = path.join(tempDir, "math_helper.ml");

    fs.writeFileSync(
      helperPath,
      `let helper_op (y : int) : int =
  if y > 10 then
    y * 2
  else
    y + 1
`
    );

    fs.writeFileSync(
      entryPath,
      `let calculate (x : int) : int =
  if x > 0 then
    Math_helper.helper_op x
  else
    0
`
    );

    const program = ProgramFactory.fromFile(entryPath, "oxcaml");
    const fnDef = program.functionsExported["calculate"];
    const env = createTestEnv(fnDef);

    const runner = new OxcamlRunner(entryPath, "calculate", env);
    await runner.onRunStart();

    // Verify both files are registered in coverageInfo
    expect(runner.coverageInfo).toBeDefined();
    const covInfo = runner.coverageInfo!;
    const registeredFiles = Object.keys(covInfo);
    expect(registeredFiles.some((f) => f.includes("entry.ml"))).toBeTrue();
    expect(
      registeredFiles.some((f) => f.includes("math_helper.ml"))
    ).toBeTrue();

    const measure = new CoverageMeasure();
    measure.onRunStart([runner], env);

    // Run with x = 15 (hits x > 0 in entry.ml, and y > 10 in math_helper.ml)
    measure.onBeforeNextTestExecution();
    const res = await runner.run([15], 5000);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(30);
    }

    const measurement = measure.measure(
      {
        tick: 0,
        value: [{ tag: "ArgValueTypeWrapped", value: [15] }],
        source: { type: "generator", generator: "RandomInputGenerator" },
      },
      createDummyResult()
    );

    const summary = measurement.coverageMeasure.current.getCoverageSummary();
    expect(summary.functions.covered).toBe(2);
    expect(summary.statements.covered).toBeGreaterThanOrEqual(2);

    // Finalize run and verify multi-file coverage in CodeCoverageMeasureStats
    const dummyGenStats = {
      counters: { inputsGenerated: 1, dupesGenerated: 0, dupeTicks: [] },
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
          inputsGenerated: 1,
          dupesGenerated: 0,
          inputsInjected: 0,
          erroredTests: 0,
          passedTests: 1,
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
          total: 1,
          oracles: {
            heuristic: { pass: 1, fail: 0, unknown: 0 },
            human: { fail: 0, unknown: 0, pass: 0 },
            property: { fail: 0, unknown: 0, pass: 0 },
          },
          exceptions: 0,
          timeouts: 0,
          categories: {
            ok: 1,
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
    expect(finalStats.files.length).toBe(2);

    const entryStats = finalStats.files.find((f) =>
      f.path.includes("entry.ml")
    );
    const helperStats = finalStats.files.find((f) =>
      f.path.includes("math_helper.ml")
    );
    expect(entryStats).toBeDefined();
    expect(helperStats).toBeDefined();

    expect(entryStats!.counters.functionsCovered).toBe(1);
    expect(helperStats!.counters.functionsCovered).toBe(1);
    expect(helperStats!.counters.branchesCovered).toBe(1);

    await runner.onRunEnd();
  });

  it("coverage scope: 'project static' vs 'project directimports static' for OCaml", async () => {
    const duneBin = OxcamlCompiler.resolveDune();
    if (!duneBin) {
      pending("Dune not found in environment");
      return;
    }

    const depDir = path.join(tempDir, "ext_dep");
    const appDir = path.join(tempDir, "my_app");
    fs.mkdirSync(depDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });

    fs.writeFileSync(path.join(depDir, "dune"), `(library\n (name ext_dep))\n`);
    fs.writeFileSync(
      path.join(depDir, "ext_dep.ml"),
      `let square (x : int) : int =
  if x > 0 then
    x * x
  else
    0
`
    );

    fs.writeFileSync(
      path.join(appDir, "dune"),
      `(executable\n (name main)\n (libraries ext_dep))\n`
    );
    const mainMl = path.join(appDir, "main.ml");
    fs.writeFileSync(
      mainMl,
      `let compute (n : int) : int =
  Ext_dep.square n + 1
`
    );

    const program = ProgramFactory.fromFile(mainMl, "oxcaml");
    const fnDef = program.functionsExported["compute"];
    const env = createTestEnv(fnDef);

    try {
      // Default 'project static' scope
      Config.override("nanofuzz.fuzzer.coverageScope", "project static");
      const runnerProject = new OxcamlRunner(mainMl, "compute", env);
      await runnerProject.onRunStart();
      const resProject = await runnerProject.run([4], 5000);
      expect(resProject.result.tag).toBe("value");
      if (resProject.result.tag === "value") {
        expect(resProject.result.value).toBe(17);
      }
      expect(runnerProject.coverageInfo).toBeDefined();
      const projectFiles = Object.keys(runnerProject.coverageInfo!);
      expect(projectFiles.some((f) => f.includes("main.ml"))).toBeTrue();
      // External dependency should not be in project scope
      expect(projectFiles.some((f) => f.includes("ext_dep"))).toBeFalse();
      await runnerProject.onRunEnd();

      // 'project directimports static' scope
      Config.override(
        "nanofuzz.fuzzer.coverageScope",
        "project directimports static"
      );
      const runnerImports = new OxcamlRunner(mainMl, "compute", env);
      await runnerImports.onRunStart();
      const resImports = await runnerImports.run([4], 5000);
      expect(resImports.result.tag).toBe("value");
      if (resImports.result.tag === "value") {
        expect(resImports.result.value).toBe(17);
      }
      expect(runnerImports.coverageInfo).toBeDefined();
      const importFiles = Object.keys(runnerImports.coverageInfo!);
      // Both main.ml and ext_dep/ext_dep.ml should be present
      expect(importFiles.some((f) => f.includes("main.ml"))).toBeTrue();
      expect(importFiles.some((f) => f.includes("ext_dep.ml"))).toBeTrue();

      // Verify dynamic hits recorded for external library
      const extFile = importFiles.find((f) => f.includes("ext_dep.ml"));
      expect(extFile).toBeDefined();
      const extCov = runnerImports.coverageInfo![extFile!];
      expect(Object.values(extCov.f).some((h) => h > 0)).toBeTrue();
      expect(Object.values(extCov.s).some((h) => h > 0)).toBeTrue();
      expect(extCov.b["0"]).toEqual([1, 0]);

      await runnerImports.onRunEnd();
    } finally {
      Config.override("nanofuzz.fuzzer.coverageScope", "project static");
    }
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
