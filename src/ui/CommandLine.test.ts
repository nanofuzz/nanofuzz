import * as ChildProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";
import { FuzzTestResults } from "../fuzzer/Fuzzer";

describe("cli: ", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-cli-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--output-file: check matching parameters for TypeScript", () => {
    const outputFile = path.join(tmpDir, "ts_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";
    const seed = "ts_cli_seed_123";
    const maxTests = 15;
    const maxRuntime = 5000;
    const maxDupeInputs = 500;
    const fnTimeout = 300;

    const res = ChildProcess.spawnSync(
      "yarn",
      [
        "nanofuzz",
        targetFile,
        targetFn,
        "--output-file",
        outputFile,
        "--max-tests",
        maxTests.toString(),
        "--max-runtime",
        maxRuntime.toString(),
        "--max-dupe-inputs",
        maxDupeInputs.toString(),
        "--fn-timeout",
        fnTimeout.toString(),
        "--seed",
        seed,
      ],
      {
        encoding: "utf8",
        cwd: path.resolve(__dirname, "../.."),
      }
    );

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    // Verify output matches target function
    const fnMeta = getFnNameAndModule(outputData.env.function);
    expect(fnMeta.name).toBe(targetFn);
    expect(fnMeta.module).toBe(path.resolve(targetFile));

    // Verify parameter set in output options matches CLI flags
    expect(outputData.env.options.maxTests).toBe(maxTests);
    expect(outputData.env.options.suiteTimeout).toBe(maxRuntime);
    expect(outputData.env.options.maxDupeInputs).toBe(maxDupeInputs);
    expect(outputData.env.options.fnTimeout).toBe(fnTimeout);
    expect(outputData.env.options.seed).toBe(seed);

    // Verify test results were produced
    expect(outputData.results.length).toBeGreaterThan(0);
    expect(outputData.results.length).toBeLessThanOrEqual(maxTests);
  });

  it("--output-file: check matching parameter set for Python", () => {
    const outputFile = path.join(tmpDir, "py_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.py";
    const targetFn = "greeting";
    const seed = "py_cli_seed_456";
    const maxTests = 10;
    const maxRuntime = 4000;

    const res = ChildProcess.spawnSync(
      "yarn",
      [
        "nanofuzz",
        targetFile,
        targetFn,
        "--output-file",
        outputFile,
        "--max-tests",
        maxTests.toString(),
        "--max-runtime",
        maxRuntime.toString(),
        "--seed",
        seed,
      ],
      {
        encoding: "utf8",
        cwd: path.resolve(__dirname, "../.."),
      }
    );

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const pyOutputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    // Verify output matches target function
    const fnMeta = getFnNameAndModule(pyOutputData.env.function);
    expect(fnMeta.name).toBe(targetFn);
    expect(fnMeta.module).toBe(path.resolve(targetFile));

    // Verify parameter set in output options matches CLI flags
    expect(pyOutputData.env.options.maxTests).toBe(maxTests);
    expect(pyOutputData.env.options.suiteTimeout).toBe(maxRuntime);
    expect(pyOutputData.env.options.seed).toBe(seed);

    // Verify test results were produced
    expect(pyOutputData.results.length).toBeGreaterThan(0);
    expect(pyOutputData.results.length).toBeLessThanOrEqual(maxTests);
  });

  it("--no-* flags: measures and generators", () => {
    const outputFile = path.join(tmpDir, "disabled_flags_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = ChildProcess.spawnSync(
      "yarn",
      [
        "nanofuzz",
        targetFile,
        targetFn,
        "--output-file",
        outputFile,
        "--no-coverage-measure",
        "--no-failed-test-measure",
        "--no-ai-input-generator",
        "--no-mutation-input-generator",
        "--max-tests",
        "10",
      ],
      {
        encoding: "utf8",
        cwd: path.resolve(__dirname, "../.."),
      }
    );

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    // Verify measures and generators options in output
    expect(outputData.env.options.measures.CoverageMeasure.enabled).toBeFalse();
    expect(
      outputData.env.options.measures.FailedTestMeasure.enabled
    ).toBeFalse();
    expect(
      outputData.env.options.generators.AiInputGenerator.enabled
    ).toBeFalse();
    expect(
      outputData.env.options.generators.MutationInputGenerator.enabled
    ).toBeFalse();
    expect(
      outputData.env.options.generators.RandomInputGenerator.enabled
    ).toBeTrue();

    expect(outputData.results.length).toBeGreaterThan(0);
  });

  it("--cig-* flags: composite input generator parameters", () => {
    const outputFile = path.join(tmpDir, "cig_flags_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = ChildProcess.spawnSync(
      "yarn",
      [
        "nanofuzz",
        targetFile,
        targetFn,
        "--output-file",
        outputFile,
        "--cig-input-lookback",
        "300",
        "--cig-input-chunk-size",
        "10",
        "--cig-randomness",
        "0.2",
        "--cig-input-focus",
        "150",
        "--cig-input-focus-decay",
        "2",
        "--max-tests",
        "10",
      ],
      {
        encoding: "utf8",
        cwd: path.resolve(__dirname, "../.."),
      }
    );

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    expect(outputData.results.length).toBeGreaterThan(0);
  });
});

function getFnNameAndModule(fnObj: unknown): {
  name?: string;
  module?: string;
} {
  if (typeof fnObj === "object" && fnObj !== null) {
    if (
      "_ref" in fnObj &&
      typeof fnObj._ref === "object" &&
      fnObj._ref !== null
    ) {
      const ref = fnObj._ref;
      const name =
        "name" in ref && typeof ref.name === "string" ? ref.name : undefined;
      const module =
        "module" in ref && typeof ref.module === "string"
          ? ref.module
          : undefined;
      return { name, module };
    }
    const name =
      "name" in fnObj && typeof fnObj.name === "string"
        ? fnObj.name
        : undefined;
    const module =
      "module" in fnObj && typeof fnObj.module === "string"
        ? fnObj.module
        : undefined;
    return { name, module };
  }
  return {};
}
