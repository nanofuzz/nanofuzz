import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as Config from "../../Config";
import { VirgilRunner } from "../runners/virgil/VirgilRunner";
import { instrumentVirgilSource } from "../runners/virgil/VirgilHarness";
import { ArgDef } from "../analysis/ArgDef";
import { FunctionDef } from "../analysis/FunctionDef";
import * as ProgramFactory from "../analysis/ProgramFactory";
import * as Parser from "../adapters/ParserAdapter";
import { FuzzEnv } from "../Types";

describe("fuzzer/measures/CoverageMeasure: Virgil", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-v3cov-test-")
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
    Config.clearOverrides();
  });

  it("extracts static coverage from Virgil source (statements, functions, branches)", () => {
    const src = `def abs_val(x: int) -> int {
    var res: int = x;
    if (x < 0) {
        return -x;
    } else {
        return res;
    }
}
`;
    const { staticCov, instrumentedSrc } = instrumentVirgilSource(
      src,
      "/test/abs.v3"
    );

    expect(Object.keys(staticCov.statementMap).length).toBeGreaterThan(0);
    expect(Object.keys(staticCov.fnMap).length).toBe(1);
    expect(staticCov.fnMap["0"].name).toBe("abs_val");
    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    expect(staticCov.branchMap["0"].locations.length).toBe(2);

    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_stmt");
    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_fn");
    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_branch");
  });

  it("extracts branches with bypass exits for if without else", () => {
    const src = `def clamp_positive(n: int) -> int {
    var val: int = n;
    if (val < 0) {
        return 0;
    }
    return val;
}
`;
    const { staticCov, instrumentedSrc } = instrumentVirgilSource(
      src,
      "/test/clamp.v3"
    );

    expect(Object.keys(staticCov.branchMap).length).toBe(1);
    const branch = staticCov.branchMap["0"];
    expect(branch.locations.length).toBe(2);
    expect(instrumentedSrc).toContain(
      "else { NanofuzzCoverage.hit_branch(0, 0, 1); }"
    );
  });

  it("instruments source with specified fileId for multi-file coverage", () => {
    const src = `def helper(x: int) -> int {
    if (x > 0) return x + 1;
    return x - 1;
}
`;
    const { instrumentedSrc } = instrumentVirgilSource(
      src,
      "/test/helper.v3",
      42
    );

    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_fn(42, 0);");
    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_stmt(42,");
    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_branch(42, 0, 0);");
    expect(instrumentedSrc).toContain("NanofuzzCoverage.hit_branch(42, 0, 1);");
  });

  it("coverage scope: 'project static' includes all source files in the workspace", async () => {
    const wsDir = path.join(tempDir, "workspace");
    const srcDir = path.join(wsDir, "src");
    const subDir = path.join(srcDir, "util");
    fs.mkdirSync(subDir, { recursive: true });

    // Mark workspace with a git marker
    fs.mkdirSync(path.join(wsDir, ".git"), { recursive: true });

    const mainV3 = path.join(srcDir, "main.v3");
    const utilV3 = path.join(subDir, "math_util.v3");

    fs.writeFileSync(
      mainV3,
      `def compute(n: int) -> int {
    if (n > 0) return n * 2;
    return 0;
}
`
    );
    fs.writeFileSync(
      utilV3,
      `def square(x: int) -> int {
    return x * x;
}
`
    );

    const program = ProgramFactory.fromFile(mainV3, "virgil");
    const fnDef = program.functionsExported["compute"];
    const env = createTestEnv(fnDef);

    Config.override("nanofuzz.fuzzer.coverageScope", "project static");
    const runner = new VirgilRunner(mainV3, "compute", env);
    await runner.onRunStart();

    expect(runner.coverageInfo).toBeDefined();
    const covFiles = Object.keys(runner.coverageInfo!);

    // Project scope must include main.v3 AND sub-directory util/math_util.v3
    expect(covFiles.some((f) => f.includes("main.v3"))).toBeTrue();
    expect(covFiles.some((f) => f.includes("math_util.v3"))).toBeTrue();

    await runner.onRunEnd();
  });

  it("coverage scope: 'project directimports static' vendors external imports but excludes language built-ins", async () => {
    const wsDir = path.join(tempDir, "app_project");
    const extDir = path.join(tempDir, "ExtLib");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });

    fs.mkdirSync(path.join(wsDir, ".git"), { recursive: true });

    const appV3 = path.join(wsDir, "app.v3");
    fs.writeFileSync(
      appV3,
      `import component System;
import component Virgil;
import component ExtLib;

def run_app(x: int) -> int {
    if (x > 10) return x;
    return 0;
}
`
    );

    const extV3 = path.join(extDir, "ExtLib.v3");
    fs.writeFileSync(
      extV3,
      `component ExtLib {
    def helper() -> int { return 100; }
}
`
    );

    const program = ProgramFactory.fromFile(appV3, "virgil");
    const fnDef = program.functionsExported["run_app"];
    const env = createTestEnv(fnDef);

    // 1. 'project static' (without directimports): ExtLib should NOT be present
    Config.override("nanofuzz.fuzzer.coverageScope", "project static");
    const runnerProject = new VirgilRunner(appV3, "run_app", env);
    await runnerProject.onRunStart();
    expect(runnerProject.coverageInfo).toBeDefined();
    const projFiles = Object.keys(runnerProject.coverageInfo!);
    expect(projFiles.some((f) => f.includes("app.v3"))).toBeTrue();
    expect(projFiles.some((f) => f.includes("ExtLib.v3"))).toBeFalse();
    await runnerProject.onRunEnd();

    // 2. 'project directimports static': ExtLib SHOULD be present, but System and Virgil are excluded
    Config.override(
      "nanofuzz.fuzzer.coverageScope",
      "project directimports static"
    );
    const runnerDirect = new VirgilRunner(appV3, "run_app", env);
    await runnerDirect.onRunStart();
    expect(runnerDirect.coverageInfo).toBeDefined();
    const directFiles = Object.keys(runnerDirect.coverageInfo!);
    expect(directFiles.some((f) => f.includes("app.v3"))).toBeTrue();
    expect(directFiles.some((f) => f.includes("ExtLib.v3"))).toBeTrue();
    // Built-ins must never appear as covered files
    expect(directFiles.some((f) => f.includes("System"))).toBeFalse();
    expect(directFiles.some((f) => f.includes("Virgil"))).toBeFalse();
    await runnerDirect.onRunEnd();
  });
});

import { getDefaultFuzzExecutionOptions } from "../FuzzerFactory";

function createTestEnv(fnDef: FunctionDef): FuzzEnv {
  return {
    function: fnDef,
    options: {
      argDefaults: ArgDef.getDefaultOptions(),
      maxTests: 10,
      maxDupeInputs: 5,
      maxFailures: 0,
      fnTimeout: 500,
      suiteTimeout: 1000,
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
}
