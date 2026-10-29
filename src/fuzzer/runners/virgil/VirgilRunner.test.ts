import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as ProgramFactory from "../../analysis/ProgramFactory";
import { RunnerFactory } from "../RunnerFactory";
import { VirgilRunner } from "./VirgilRunner";
import { VirgilHost } from "./VirgilHost";
import { VirgilCompiler } from "../../compilers/virgil/VirgilCompiler";
import { FuzzEnv } from "../../Types";
import { ArgDef } from "../../analysis/ArgDef";
import { FunctionDef } from "../../analysis/FunctionDef";
import * as Parser from "../../adapters/ParserAdapter";

import { getDefaultFuzzExecutionOptions } from "../../FuzzerFactory";

function createRunnerTestEnv(fnDef: FunctionDef): FuzzEnv {
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

describe("fuzzer/runners/virgil/VirgilRunner: ", () => {
  let tempDir: string;

  beforeAll(async () => {
    await Parser.init();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-v3run-test-")
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

  it("RunnerFactory returns VirgilRunner for .v3 modules", () => {
    const v3File = path.join(tempDir, "test.v3");
    fs.writeFileSync(v3File, "def add(a: int, b: int) -> int { return a + b; }\n");

    const program = ProgramFactory.fromFile(v3File, "virgil");
    const fnDef = program.functionsExported["add"];
    expect(fnDef).toBeDefined();

    const env = createRunnerTestEnv(fnDef);

    const runner = RunnerFactory(env, v3File, "add");
    expect(runner).toBeDefined();
    expect(runner instanceof VirgilRunner).toBeTrue();
    expect(runner.filename).toBe(v3File);
    expect(runner.name).toBe("add");
  });

  it("VirgilHost spawns child process with standard streams", () => {
    const host = new VirgilHost(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    expect(host.isActive).toBeTrue();
    host.kill();
    expect(host.isActive).toBeFalse();
  });

  it("VirgilRunner lifecycle: onRunStart builds harness and initializes static coverage", async () => {
    const v3File = path.join(tempDir, "math.v3");
    fs.writeFileSync(
      v3File,
      `def clamp(x: int) -> int {
    if (x < 0) return 0;
    return x;
}\n`
    );

    const program = ProgramFactory.fromFile(v3File, "virgil");
    const fnDef = program.functionsExported["clamp"];
    const env = createRunnerTestEnv(fnDef);

    const runner = new VirgilRunner(v3File, "clamp", env);
    await runner.onRunStart();

    expect(runner.coverageInfo).toBeDefined();
    const cov =
      runner.coverageInfo![v3File] ??
      runner.coverageInfo![v3File.replace(/\\/g, "/")] ??
      runner.coverageInfo![fs.realpathSync(v3File)];
    expect(cov).toBeDefined();
    expect(Object.keys(cov.fnMap).length).toBe(1);
    expect(cov.fnMap["0"].name).toBe("clamp");
    expect(Object.keys(cov.branchMap).length).toBe(1);

    await runner.onRunEnd();
  });

  it("gated execution: executes target function if v3c is available", async () => {
    const v3c = VirgilCompiler.resolveV3c();
    if (!v3c) {
      pending("v3c compiler not found in environment");
      return;
    }

    const v3File = path.join(tempDir, "compute.v3");
    fs.writeFileSync(
      v3File,
      `def square(n: int) -> int {
    return n * n;
}\n`
    );

    const program = ProgramFactory.fromFile(v3File, "virgil");
    const fnDef = program.functionsExported["square"];
    const env = createRunnerTestEnv(fnDef);

    const runner = new VirgilRunner(v3File, "square", env);
    await runner.onRunStart();
    const result = await runner.run([5], 1000);
    expect(result).toBeDefined();
    await runner.onRunEnd();
  });
});
