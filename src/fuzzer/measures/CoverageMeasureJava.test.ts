import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ChildProcess from "node:child_process";
import * as Config from "../../Config";
import { CoverageMeasure } from "./CoverageMeasure";
import { JavaRunner } from "../runners/java/JavaRunner";
import { extractJavaStaticCoverage } from "../runners/java/JavaHarness";
import { JavaCompiler } from "../compilers/java/JavaCompiler";
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

describe("fuzzer/measures/CoverageMeasure: Java", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-javacov-test-")
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

  it("extracts static coverage from Java source (statements, functions, branches)", () => {
    const src = `public class MathAbs {
    public static int abs(int x) {
        int res = x;
        if (x < 0) {
            res = -x;
        } else {
            res = x;
        }
        return res;
    }
}
`;
    const { staticCov, branchSpecs } = extractJavaStaticCoverage(
      src,
      "/test/MathAbs.java"
    );

    expect(Object.keys(staticCov.statementMap).length).toBe(3);
    expect(Object.keys(staticCov.fnMap).length).toBe(1);
    expect(staticCov.fnMap["0"].name).toBe("abs");
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(2);
    expect(branchSpecs.length).toBe(1);
    expect(branchSpecs[0].hasElse).toBeTrue();
  });

  it("extracts branches with bypass exits for if without else", () => {
    const src = `public class Clamp {
    public static int clampPositive(int n) {
        int val = n;
        if (val < 0) {
            val = 0;
        }
        return val;
    }
}
`;
    const { staticCov, branchSpecs } = extractJavaStaticCoverage(
      src,
      "/test/Clamp.java"
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    const branch = staticCov.branchMap["0"];
    expect(branch.locations.length).toBe(2);
    expect(branchSpecs.length).toBe(1);
    expect(branchSpecs[0].hasElse).toBeFalse();
  });

  it("extracts switch branches for each switch rule/case", () => {
    const src = `public class Classifier {
    public static String classify(int n) {
        switch (n) {
            case 0 -> { return "zero"; }
            case 1 -> { return "one"; }
            default -> { return "other"; }
        }
    }
}
`;
    const { staticCov, branchSpecs } = extractJavaStaticCoverage(
      src,
      "/test/Classifier.java"
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(3);
    expect(branchSpecs[0].armCount).toBe(3);
  });

  it("tracks dynamic line, function, and branch coverage during JavaRunner execution", async () => {
    const javaPath = path.join(tempDir, "AbsTest.java");
    const javaCode = `public class AbsTest {
    public static int abs(int x) {
        int res = x;
        if (x < 0) {
            res = -x;
        } else {
            res = x;
        }
        return res;
    }
}
`;
    fs.writeFileSync(javaPath, javaCode);

    const program = ProgramFactory.fromFile(javaPath, "java");
    const fnDef = program.functionsExported["abs"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(javaPath, "abs", env);
    await runner.onRunStart();

    const measure = new CoverageMeasure();
    measure.onRunStart([runner], env);

    // Initial static coverage should be registered in runner
    expect(runner.coverageInfo).toBeDefined();

    // Run with negative input (hits if branch: then-block)
    measure.onBeforeNextTestExecution();
    const resNegative = await runner.run([-5], 5000);
    expect(resNegative.result.tag).toBe("value");
    if (resNegative.result.tag === "value") {
      expect(resNegative.result.value).toBe(5);
    }

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

    // Run with positive input (hits else branch, introducing new coverage)
    measure.onBeforeNextTestExecution();
    const resPositive = await runner.run([10], 5000);
    expect(resPositive.result.tag).toBe("value");
    if (resPositive.result.tag === "value") {
      expect(resPositive.result.value).toBe(10);
    }

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
    expect(currentSummary2.statements.covered).toBeGreaterThan(0);
    expect(currentSummary2.functions.covered).toBe(1);
    expect(currentSummary2.branches.covered).toBe(1);

    // Finalize run and verify overall coverage
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
          testingRuns: 2,
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
          total: 2,
          oracles: {
            heuristic: { pass: 2, fail: 0, unknown: 0 },
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

  it("tracks multi-file coverage across local classes in project scope", async () => {
    const helperPath = path.join(tempDir, "MathHelper.java");
    const entryPath = path.join(tempDir, "Calculator.java");

    fs.writeFileSync(
      helperPath,
      `public class MathHelper {
    public static int helperOp(int y) {
        if (y > 10) {
            return y * 2;
        } else {
            return y + 1;
        }
    }
}
`
    );

    fs.writeFileSync(
      entryPath,
      `public class Calculator {
    public static int calculate(int x) {
        if (x > 0) {
            return MathHelper.helperOp(x);
        } else {
            return 0;
        }
    }
}
`
    );

    const program = ProgramFactory.fromFile(entryPath, "java");
    const fnDef = program.functionsExported["calculate"];
    const env = createTestEnv(fnDef);

    const runner = new JavaRunner(entryPath, "calculate", env);
    await runner.onRunStart();

    // Verify both files are registered in coverageInfo
    expect(runner.coverageInfo).toBeDefined();
    const covInfo = runner.coverageInfo!;
    const registeredFiles = Object.keys(covInfo);
    expect(
      registeredFiles.some((f) => f.includes("Calculator.java"))
    ).toBeTrue();
    expect(
      registeredFiles.some((f) => f.includes("MathHelper.java"))
    ).toBeTrue();

    const measure = new CoverageMeasure();
    measure.onRunStart([runner], env);

    // Run with x = 15 (hits x > 0 in Calculator.java and y > 10 in MathHelper.java)
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

    // Finalize run and verify multi-file coverage metrics
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
      f.path.includes("Calculator.java")
    );
    const helperStats = finalStats.files.find((f) =>
      f.path.includes("MathHelper.java")
    );
    expect(entryStats).toBeDefined();
    expect(helperStats).toBeDefined();

    expect(entryStats!.counters.functionsCovered).toBe(1);
    expect(helperStats!.counters.functionsCovered).toBe(1);
    expect(helperStats!.counters.branchesCovered).toBe(1);

    await runner.onRunEnd();
  });

  it("coverage scope: 'project static' vs 'project directimports static' for Java", async () => {
    const depDir = path.join(tempDir, "ext_dep");
    const appDir = path.join(tempDir, "my_app");
    fs.mkdirSync(path.join(depDir, "src", "com", "ext"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "src", "com", "app"), { recursive: true });

    const squareJava = path.join(depDir, "src", "com", "ext", "Square.java");
    fs.writeFileSync(
      squareJava,
      `package com.ext;

public class Square {
    public static int square(int x) {
        if (x > 0) {
            return x * x;
        } else {
            return 0;
        }
    }
}
`
    );

    const depClasses = path.join(depDir, "classes");
    fs.mkdirSync(depClasses, { recursive: true });
    const javac = JavaCompiler.resolveJavac() ?? "javac";
    ChildProcess.execSync(`"${javac}" -g -d "${depClasses}" "${squareJava}"`);

    const mainJava = path.join(appDir, "src", "com", "app", "MainApp.java");
    fs.writeFileSync(
      mainJava,
      `package com.app;

import com.ext.Square;

public class MainApp {
    public static int compute(int n) {
        return Square.square(n) + 1;
    }
}
`
    );

    const program = ProgramFactory.fromFile(mainJava, "java");
    const fnDef = program.functionsExported["compute"];
    const env = createTestEnv(fnDef);

    try {
      // Default 'project static' scope
      Config.override("nanofuzz.fuzzer.coverageScope", "project static");
      const runnerProject = new JavaRunner(
        mainJava,
        "compute",
        env,
        {},
        { extraClasspath: [depClasses] }
      );
      await runnerProject.onRunStart();
      const resProject = await runnerProject.run([4], 5000);
      expect(resProject.result.tag).toBe("value");
      if (resProject.result.tag === "value") {
        expect(resProject.result.value).toBe(17);
      }
      expect(runnerProject.coverageInfo).toBeDefined();
      const projectFiles = Object.keys(runnerProject.coverageInfo!);
      expect(projectFiles.some((f) => f.includes("MainApp.java"))).toBeTrue();
      // External dependency should NOT be in project scope
      expect(projectFiles.some((f) => f.includes("Square.java"))).toBeFalse();
      await runnerProject.onRunEnd();

      // 'project directimports static' scope
      Config.override(
        "nanofuzz.fuzzer.coverageScope",
        "project directimports static"
      );
      const runnerImports = new JavaRunner(
        mainJava,
        "compute",
        env,
        {},
        { extraClasspath: [depClasses] }
      );
      await runnerImports.onRunStart();
      const resImports = await runnerImports.run([4], 5000);
      expect(resImports.result.tag).toBe("value");
      if (resImports.result.tag === "value") {
        expect(resImports.result.value).toBe(17);
      }
      expect(runnerImports.coverageInfo).toBeDefined();
      const importFiles = Object.keys(runnerImports.coverageInfo!);
      // Both MainApp.java AND Square.java should be present
      expect(importFiles.some((f) => f.includes("MainApp.java"))).toBeTrue();
      expect(importFiles.some((f) => f.includes("Square.java"))).toBeTrue();

      // Verify dynamic hits recorded for external class
      const extFile = importFiles.find((f) => f.includes("Square.java"));
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
  const res: FuzzTestResult = {
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
  return res;
} // fn: createDummyResult
