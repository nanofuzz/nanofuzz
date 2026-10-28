import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

    expect(Object.keys(staticCov.statementMap).length).toBeGreaterThanOrEqual(3);
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
