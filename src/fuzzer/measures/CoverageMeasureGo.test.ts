import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as Config from "../../Config";
import { CoverageMeasure } from "./CoverageMeasure";
import { GoRunner } from "../runners/go/GoRunner";
import { extractGoStaticCoverage } from "../runners/go/GoHarness";
import { ArgDef } from "../analysis/ArgDef";
import { FunctionDef } from "../analysis/FunctionDef";
import * as ProgramFactory from "../analysis/ProgramFactory";
import * as Parser from "../adapters/ParserAdapter";
import { FuzzEnv } from "../Types";
import { getDefaultFuzzExecutionOptions } from "../FuzzerFactory";

describe("fuzzer/measures/CoverageMeasure: Go", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-gocov-test-")
    );
  });

  afterEach(() => {
    Config.clearOverrides();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("extracts static coverage from Go source (statements, functions, branches)", () => {
    const src = `package mathutil

func Abs(x int) int {
    res := x
    if x < 0 {
        res = -x
    } else {
        res = x
    }
    return res
}
`;
    const { staticCov, branchSpecs } = extractGoStaticCoverage(
      src,
      "/test/abs.go",
      0
    );

    expect(Object.keys(staticCov.statementMap).length).toBeGreaterThanOrEqual(
      3
    );
    expect(Object.keys(staticCov.fnMap).length).toBe(1);
    expect(staticCov.fnMap["0"].name).toBe("Abs");
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(2);
    expect(branchSpecs.length).toBe(1);
    expect(branchSpecs[0].armCount).toBe(2);
  });

  it("extracts branches with bypass exits for if without else", () => {
    const src = `package mathutil

func Clamp(n int) int {
    val := n
    if val < 0 {
        val = 0
    }
    return val
}
`;
    const { staticCov, branchSpecs } = extractGoStaticCoverage(
      src,
      "/test/clamp.go",
      0
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(2);
    expect(branchSpecs[0].armCount).toBe(2);
  });

  it("extracts switch branches for each switch case", () => {
    const src = `package mathutil

func Classify(n int) string {
    switch n {
    case 0:
        return "zero"
    case 1:
        return "one"
    default:
        return "other"
    }
}
`;
    const { staticCov, branchSpecs } = extractGoStaticCoverage(
      src,
      "/test/classify.go",
      0
    );
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(3);
    expect(branchSpecs[0].armCount).toBe(3);
  });

  it("tracks dynamic line, function, and branch coverage during GoRunner execution", async () => {
    const goPath = path.join(tempDir, "abs_test.go");
    const goCode = `package abs

func Abs(x int) int {
    res := x
    if x < 0 {
        res = -x
    } else {
        res = x
    }
    return res
}
`;
    fs.writeFileSync(goPath, goCode);

    const program = ProgramFactory.fromFile(goPath, "go");
    const fnDef = program.functionsExported["Abs"];
    const env = createTestEnv(fnDef);

    const runner = new GoRunner(goPath, "Abs", env);
    await runner.onRunStart();

    const measure = new CoverageMeasure();
    measure.onRunStart([runner], env);

    expect(runner.staticCoverage).toBeDefined();

    // First execution: x < 0 -> hits branch 0
    const resNeg = await runner.run([-5]);
    expect(resNeg.result.tag).toBe("value");
    if (resNeg.result.tag === "value") {
      expect(resNeg.result.value).toBe(5);
    }

    const dynCov1 = runner.lastRunCoverage;
    expect(dynCov1).toBeDefined();

    // Second execution: x >= 0 -> hits branch 1
    const resPos = await runner.run([10]);
    expect(resPos.result.tag).toBe("value");
    if (resPos.result.tag === "value") {
      expect(resPos.result.value).toBe(10);
    }

    const dynCov2 = runner.lastRunCoverage;
    expect(dynCov2).toBeDefined();

    runner.killHost();
  });

  it("captures package init() statements in static coverage when static scope is enabled", async () => {
    const goPath = path.join(tempDir, "init_scope_test.go");
    const goCode = `package initscope

var InitCount = 0

func init() {
    InitCount = 100
}

func Value() int {
    return InitCount
}
`;
    fs.writeFileSync(goPath, goCode);

    const program = ProgramFactory.fromFile(goPath, "go");
    const fnDef = program.functionsExported["Value"];
    const env = createTestEnv(fnDef);

    // 1. With static in coverageScope (default: "project static")
    Config.override("nanofuzz.fuzzer.coverageScope", "project static");
    const runnerStatic = new GoRunner(goPath, "Value", env);
    await runnerStatic.onRunStart();

    const staticCov = runnerStatic.staticCoverage;
    expect(staticCov).toBeDefined();
    const fileCovStatic = Object.values(staticCov!)[0];
    // At least one statement in init() was hit during static package initialization
    const stmtHitValues = Object.values(fileCovStatic.s);
    expect(stmtHitValues.some((hits) => hits > 0)).toBeTrue();
    runnerStatic.killHost();

    // 2. Without static in coverageScope
    Config.override("nanofuzz.fuzzer.coverageScope", "project");
    const runnerNoStatic = new GoRunner(goPath, "Value", env);
    await runnerNoStatic.onRunStart();

    const noStaticCov = runnerNoStatic.staticCoverage;
    expect(noStaticCov).toBeDefined();
    const fileCovNoStatic = Object.values(noStaticCov!)[0];
    // When static scope is disabled, initial statement hits remain 0
    const noStaticHits = Object.values(fileCovNoStatic.s);
    expect(noStaticHits.every((hits) => hits === 0)).toBeTrue();
    runnerNoStatic.killHost();
  });

  it("instruments all project Go source files across subdirectories in project scope", async () => {
    // Project root with go.mod
    const projDir = path.join(tempDir, "multidir_project");
    fs.mkdirSync(path.join(projDir, "subpkg"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "go.mod"),
      "module multidir_project\n\ngo 1.22\n"
    );

    const mainFile = path.join(projDir, "main.go");
    fs.writeFileSync(
      mainFile,
      `package main

func Compute(x int) int {
    if x > 0 {
        return Helper(x)
    }
    return 0
}
`
    );

    const subFile = path.join(projDir, "subpkg", "helper.go");
    fs.writeFileSync(
      subFile,
      `package subpkg

func Helper(n int) int {
    return n * 2
}
`
    );

    const program = ProgramFactory.fromFile(mainFile, "go");
    const fnDef = program.functionsExported["Compute"];
    const env = createTestEnv(fnDef);

    const runner = new GoRunner(mainFile, "Compute", env);
    await runner.onRunStart();

    // Verify static coverage map contains both root and subdirectory files
    const staticCov = runner.staticCoverage;
    expect(staticCov).toBeDefined();
    const coveredPaths = Object.keys(staticCov!);
    expect(coveredPaths.some((p) => p.endsWith("main.go"))).toBeTrue();
    expect(coveredPaths.some((p) => p.endsWith("helper.go"))).toBeTrue();

    // Run compute and verify dynamic coverage covers both files
    const res = await runner.run([5]);
    expect(res.result.tag).toBe("value");
    if (res.result.tag === "value") {
      expect(res.result.value).toBe(10);
    }

    const lastCov = runner.lastRunCoverage;
    expect(lastCov).toBeDefined();
    const dynPaths = Object.keys(lastCov!);
    expect(dynPaths.some((p) => p.endsWith("helper.go"))).toBeTrue();

    runner.killHost();
  });

  it("coverage scope: 'project static' vs 'project directimports static' for Go", async () => {
    const depDir = path.join(tempDir, "ext_dep");
    const appDir = path.join(tempDir, "my_app");
    fs.mkdirSync(depDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });

    fs.writeFileSync(
      path.join(depDir, "go.mod"),
      "module example.com/ext_dep\n\ngo 1.22\n"
    );
    fs.writeFileSync(
      path.join(depDir, "dep.go"),
      `package ext_dep

func Square(x int) int {
    if x > 0 {
        return x * x
    }
    return 0
}
`
    );

    fs.writeFileSync(
      path.join(appDir, "go.mod"),
      "module example.com/my_app\n\ngo 1.22\n\nrequire example.com/ext_dep v0.0.0\nreplace example.com/ext_dep => ../ext_dep\n"
    );
    const mainGo = path.join(appDir, "main.go");
    fs.writeFileSync(
      mainGo,
      `package main

import (
    "example.com/ext_dep"
)

func Compute(n int) int {
    return ext_dep.Square(n) + 1
}
`
    );

    const program = ProgramFactory.fromFile(mainGo, "go");
    const fnDef = program.functionsExported["Compute"];
    const env = createTestEnv(fnDef);

    try {
      // 1. Default 'project static' scope
      Config.override("nanofuzz.fuzzer.coverageScope", "project static");
      const runnerProject = new GoRunner(mainGo, "Compute", env);
      await runnerProject.onRunStart();
      const resProject = await runnerProject.run([4]);
      expect(resProject.result.tag).toBe("value");
      if (resProject.result.tag === "value") {
        expect(resProject.result.value).toBe(17);
      }
      expect(runnerProject.coverageInfo).toBeDefined();
      const projectFiles = Object.keys(runnerProject.coverageInfo!);
      expect(projectFiles.some((f) => f.includes("main.go"))).toBeTrue();
      // External dependency should NOT be in project scope
      expect(projectFiles.some((f) => f.includes("ext_dep"))).toBeFalse();
      runnerProject.killHost();

      // 2. 'project directimports static' scope
      Config.override(
        "nanofuzz.fuzzer.coverageScope",
        "project directimports static"
      );
      const runnerImports = new GoRunner(mainGo, "Compute", env);
      await runnerImports.onRunStart();
      const resImports = await runnerImports.run([4]);
      expect(resImports.result.tag).toBe("value");
      if (resImports.result.tag === "value") {
        expect(resImports.result.value).toBe(17);
      }
      expect(runnerImports.coverageInfo).toBeDefined();
      const importFiles = Object.keys(runnerImports.coverageInfo!);
      // Both main.go AND ext_dep/dep.go should be present
      expect(importFiles.some((f) => f.includes("main.go"))).toBeTrue();
      expect(importFiles.some((f) => f.includes("ext_dep"))).toBeTrue();

      // Verify dynamic hits recorded for external module
      const extFile = importFiles.find((f) => f.includes("ext_dep"));
      expect(extFile).toBeDefined();
      const extCov = runnerImports.coverageInfo![extFile!];
      expect(Object.values(extCov.s).some((h) => h > 0)).toBeTrue();
      expect(extCov.b["0"]).toEqual([1, 0]);

      runnerImports.killHost();
    } finally {
      Config.override("nanofuzz.fuzzer.coverageScope", "project static");
    }
  });
});

function createTestEnv(fnDef: FunctionDef): FuzzEnv {
  return {
    function: fnDef,
    validators: [],
    transformers: [],
    userGenerators: [],
    executionOptions: getDefaultFuzzExecutionOptions(),
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
        FailedTestMeasure: { enabled: false, weight: 1 },
      },
      generators: {
        RandomInputGenerator: { enabled: true },
        MutationInputGenerator: { enabled: false },
        AiInputGenerator: { enabled: false },
        UserInputGenerator: { enabled: false },
      },
    },
  };
} // fn: createTestEnv
