import * as ChildProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";
import { FuzzStopReason, FuzzTestResults } from "../fuzzer/Fuzzer";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import { AiInputGenerator } from "../fuzzer/generators/AiInputGenerator";
import { createCacheKey } from "../fuzzer/adapters/LlmCacheManager";
import { prompt } from "../fuzzer/adapters/LlmAdapter";

function runCli(args: string[]): ChildProcess.SpawnSyncReturns<string> {
  const cliScript = path.resolve(__dirname, "../../build/cli/cli.cjs");
  return ChildProcess.spawnSync(process.execPath, [cliScript, ...args], {
    encoding: "utf8",
    cwd: path.resolve(__dirname, "../.."),
    shell: process.platform === "win32",
  });
}

describe("cli:", () => {
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

    const res = runCli([
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
    ]);

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

    const res = runCli([
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
    ]);

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

    const res = runCli([
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
    ]);

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

    const res = runCli([
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
    ]);

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    expect(outputData.results.length).toBeGreaterThan(0);

    // Verify composite generator config recorded in output stats
    const cigStats = outputData.stats.generators.CompositeInputGenerator;
    expect(cigStats?.config).toBeDefined();
    expect(cigStats?.config?.lookbackWindow).toBe(300);
    expect(cigStats?.config?.chunkSize).toBe(10);
    expect(cigStats?.config?.explorationChance).toBe(0.2);
    expect(cigStats?.config?.initialFocus).toBe(150);
    expect(cigStats?.config?.focusDecay).toBe(2);
    expect(cigStats?.checkpoints).toEqual([]);
  });

  it("--cig-stats-checkpoints flag enables checkpoints tracking in output stats", () => {
    const outputFile = path.join(tmpDir, "cig_checkpoints_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--cig-stats-checkpoints",
      "--max-tests",
      "10",
    ]);

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    const cigStats = outputData.stats.generators.CompositeInputGenerator;
    expect(cigStats?.checkpoints).toBeDefined();
    expect(cigStats?.checkpoints?.length).toBeGreaterThan(0);
  });

  it("--ai-cache-*: cache miss in replay-error mode", () => {
    const outputFile = path.join(tmpDir, "ai_cache_miss_output.json5");
    const cacheFile = path.join(tmpDir, "cli_llm_cache_miss.json");
    const targetFile = path.resolve(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const targetFn = "testCoverageOneFile";

    const res = runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--model-provider",
      "gemini",
      "--model-name",
      "gemini-flash",
      "--model-key",
      "test-key",
      "--ai-cache-mode",
      "replay-error",
      "--ai-cache-file",
      cacheFile,
      "--max-tests",
      "5",
    ]);

    if (res.status !== 0) {
      console.error("CLI STDOUT:", res.stdout);
      console.error("CLI STDERR:", res.stderr);
    }

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    const aiGenStats = outputData.stats.generators.AiInputGenerator?.gen;
    expect(aiGenStats).toBeDefined();
    expect(aiGenStats?.cache?.mode).toBe("replay-error");
    expect(aiGenStats?.cache?.calls).toBeGreaterThanOrEqual(1);
    expect(aiGenStats?.cache?.misses).toBeGreaterThanOrEqual(1);
    expect(aiGenStats?.cache?.failures).toBeGreaterThanOrEqual(1);
    expect(aiGenStats?.calls.failed).toBeGreaterThanOrEqual(1);
  });

  it("--ai-cache-*: cache hit in replay-error mode", () => {
    const outputFile = path.join(tmpDir, "ai_cache_hit_output.json5");
    const cacheFile = path.join(tmpDir, "cli_llm_cache_hit.json");
    const targetFile = path.resolve(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const targetFn = "testCoverageOneFile";
    const provider = "gemini";
    const modelName = "gemini-flash";

    // Pre-seed cache entry for testCoverageOneFile
    const program = ProgramFactory.fromFile(targetFile);
    const fn = program.functionsExported[targetFn];
    const aiGen = new AiInputGenerator(fn, "seed", new Map());
    const [schema, directives] = aiGen["_getInputsSchema"](fn.getLang());
    const promptText = prompt.genInputs(fn, directives, new Map());
    const schemaJson = JSON.stringify(schema.toJSONSchema());
    const key = createCacheKey(provider, modelName, [promptText], schemaJson);

    const seededEntry = {
      key,
      request: { provider, modelName, prompt: [promptText], schemaJson },
      response: {
        text: JSON.stringify({ programInputs: [{ s: "replay-cached-input" }] }),
        stats: {
          tokensSent: 100,
          tokensSentCost: { amt: 0.001, unit: "USD" },
          tokensReceived: 50,
          tokensReceivedCost: { amt: 0.001, unit: "USD" },
        },
      },
      delayMs: 10,
      recordedAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON5.stringify([seededEntry], null, 2),
      "utf8"
    );

    const res = runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--model-provider",
      provider,
      "--model-name",
      modelName,
      "--model-key",
      "test-key",
      "--ai-cache-mode",
      "replay-error",
      "--ai-cache-file",
      cacheFile,
      "--max-tests",
      "5",
    ]);

    if (res.status !== 0) {
      console.error("CLI STDOUT:", res.stdout);
      console.error("CLI STDERR:", res.stderr);
    }

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    const aiGenStats = outputData.stats.generators.AiInputGenerator?.gen;

    expect(aiGenStats).toBeDefined();
    expect(aiGenStats?.cache?.mode).toBe("replay-error");
    expect(aiGenStats?.cache?.calls).toBe(1);
    expect(aiGenStats?.cache?.hits).toBe(1);
    expect(aiGenStats?.cache?.misses).toBe(0);
    expect(aiGenStats?.calls.sent).toBe(1);
  });

  it("--max-failures: stops fuzzing after reaching maximum allowed failures", () => {
    const outputFile = path.join(tmpDir, "max_failures_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testStandardVoidReturnException";
    const maxFailures = 2;

    const res = runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--max-failures",
      maxFailures.toString(),
      "--max-tests",
      "100",
    ]);

    expect(res.status).toBe(1);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    expect(outputData.env.options.maxFailures).toBe(maxFailures);
    expect(outputData.stopReason).toBe(FuzzStopReason.MAXFAILURES);
    expect(outputData.results.length).toBe(maxFailures);
    expect(outputData.stats.counters.failedTests).toBe(maxFailures);
  });

  it("--max-failures: stop fuzzing python put after 1 failure", () => {
    const pyFile = path.join(
      tmpDir,
      `pbt_test_${Math.random().toString(36).substring(2, 9)}.py`
    );
    const targetFn = "test_range_max_exclusive_rejects_boundary";
    fs.writeFileSync(
      pyFile,
      `
def ${targetFn}(n: int) -> int:
    raise Exception("boundary error")
`,
      "utf8"
    );

    try {
      const res = runCli([
        pyFile,
        targetFn,
        "--max-runtime",
        "300000",
        "--max-failures",
        "1",
      ]);

      expect(res.status).toBe(1);
      expect(res.stdout).toContain("Stopped for reason: maxFailures.");
    } finally {
      if (fs.existsSync(pyFile)) {
        fs.rmSync(pyFile, { force: true });
      }
    }
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
