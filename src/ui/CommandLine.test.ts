import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";
import * as zod from "zod/v4";
import * as Config from "../Config";
import { FuzzStopReason, FuzzTestResults } from "../fuzzer/Fuzzer";
import { CodeCoverageMeasureStats } from "../fuzzer/measures/AbstractCoverageMeasure";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import { AiInputGenerator } from "../fuzzer/generators/AiInputGenerator";
import { createCacheKey } from "../fuzzer/adapters/LlmCacheManager";
import { prompt } from "../fuzzer/adapters/LlmAdapter";
import { runCliInProcess } from "./CommandLine";

async function runCli(
  args: string[]
): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origConsoleLog = console.log;
  const origConsoleInfo = console.info;
  const origConsoleError = console.error;

  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void
  ): boolean => {
    stdout += String(chunk);
    if (typeof encodingOrCallback === "function") {
      return origStdoutWrite.bind(process.stdout)(chunk, encodingOrCallback);
    }
    if (typeof encodingOrCallback === "string") {
      return origStdoutWrite.bind(process.stdout)(
        chunk,
        encodingOrCallback,
        callback
      );
    }
    return origStdoutWrite.bind(process.stdout)(chunk);
  };

  process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void
  ): boolean => {
    stderr += String(chunk);
    if (typeof encodingOrCallback === "function") {
      return origStderrWrite.bind(process.stderr)(chunk, encodingOrCallback);
    }
    if (typeof encodingOrCallback === "string") {
      return origStderrWrite.bind(process.stderr)(
        chunk,
        encodingOrCallback,
        callback
      );
    }
    return origStderrWrite.bind(process.stderr)(chunk);
  };

  console.log = (...a: unknown[]) => {
    stdout += a.map(String).join(" ") + "\n";
  };
  console.info = (...a: unknown[]) => {
    stdout += a.map(String).join(" ") + "\n";
  };
  console.error = (...a: unknown[]) => {
    stderr += a.map(String).join(" ") + "\n";
  };

  try {
    Config.clearOverrides();
    const status = await runCliInProcess(args);
    return { status, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.info = origConsoleInfo;
    console.error = origConsoleError;
  }
}

describe("cli:", () => {
  let tmpDir: string;
  let originalTimeout: number;

  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-cli-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore residual file lock cleanup errors on Windows
      }
    }
  });

  it("returns exit code 0 for --help and --version", async () => {
    const helpRes = await runCli(["--help"]);
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain("Usage: nanofuzz");

    const versionRes = await runCli(["--version"]);
    expect(versionRes.status).toBe(0);
    expect(versionRes.stdout).toContain("NaNofuzz");
  });

  it("--output-file: check matching parameters for TypeScript", async () => {
    const outputFile = path.join(tmpDir, "ts_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";
    const seed = "ts_cli_seed_123";
    const maxTests = 2;
    const maxRuntime = 5000;
    const maxDupeInputs = 500;
    const fnTimeout = 300;

    const res = await runCli([
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

  it("--output-file: check matching parameter set for Python", async () => {
    const outputFile = path.join(tmpDir, "py_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.py";
    const targetFn = "greeting";
    const seed = "py_cli_seed_456";
    const maxTests = 2;
    const maxRuntime = 4000;

    const res = await runCli([
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

  it("--no-* flags: measures and generators", async () => {
    const outputFile = path.join(tmpDir, "disabled_flags_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = await runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--no-coverage-measure",
      "--no-failed-test-measure",
      "--no-ai-input-generator",
      "--no-mutation-input-generator",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_no_flags",
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

  it("--no-random-input-generator", async () => {
    const outputFile = path.join(tmpDir, "no_rnd_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = await runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--no-random-input-generator",
      "--no-ai-input-generator",
      "--no-mutation-input-generator",
      "--max-tests",
      "10",
      "--seed",
      "cli_seed_no_rnd",
    ]);

    expect(res.status).toBe(3); // Exit code 3 when 0 tests run
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );

    expect(
      outputData.env.options.generators.RandomInputGenerator.enabled
    ).toBeFalse();
    expect(
      outputData.env.options.generators.AiInputGenerator.enabled
    ).toBeFalse();
    expect(
      outputData.env.options.generators.MutationInputGenerator.enabled
    ).toBeFalse();
  });

  it("--cig-* flags: composite input generator parameters", async () => {
    const outputFile = path.join(tmpDir, "cig_flags_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = await runCli([
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
      "1",
      "--seed",
      "cli_seed_cig_flags",
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

  it("--cig-stats-checkpoints flag enables checkpoints tracking in output stats", async () => {
    const outputFile = path.join(tmpDir, "cig_checkpoints_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = await runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--cig-stats-checkpoints",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_cig_checkpoints",
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

  it("--ai-cache-*: cache miss in replay-error mode", async () => {
    const outputFile = path.join(tmpDir, "ai_cache_miss_output.json5");
    const cacheFile = path.join(tmpDir, "cli_llm_cache_miss.json");
    const targetFile = path.resolve(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const targetFn = "testCoverageOneFile";

    const res = await runCli([
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
      "1",
      "--seed",
      "cli_seed_ai_cache_miss",
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

  it("--ai-cache-*: cache hit in replay-error mode", async () => {
    const outputFile = path.join(tmpDir, "ai_cache_hit_output.json5");
    const cacheFile = path.join(tmpDir, "cli_llm_cache_hit.json");
    const targetFile = path.resolve(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const targetFn = "testCoverageOneFile";
    const provider = "gemini";
    const modelName = "gemini-flash";
    const seed = "cli_seed_ai_cache_hit";

    // Pre-seed cache entry for testCoverageOneFile
    const program = ProgramFactory.fromFile(targetFile);
    const fn = program.functionsExported[targetFn];
    const aiGen = new AiInputGenerator(fn, seed, new Map(), program.src);
    aiGen.onRunStart(true);
    const [schema, directives] = aiGen["_getInputsSchema"](fn.getLang());
    const numRequested = aiGen["_getRequestedInputCount"]();
    const promptText = prompt.genInputs(
      fn,
      directives,
      new Map(),
      program.src,
      numRequested
    );
    const schemaJson = JSON.stringify(zod.toJSONSchema(schema));
    const key = createCacheKey(provider, modelName, [promptText], schemaJson);

    const seededEntry = {
      key,
      request: { provider, modelName, prompt: [promptText], schemaJson },
      response: {
        text: JSON.stringify({
          programInputs: [
            { s: "replay-cached-input-1" },
            { s: "replay-cached-input-2" },
            { s: "replay-cached-input-3" },
            { s: "replay-cached-input-4" },
            { s: "replay-cached-input-5" },
          ],
        }),
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

    const res = await runCli([
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
      "1",
      "--seed",
      seed,
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

  it("--max-failures: stops fuzzing after reaching maximum allowed failures", async () => {
    const outputFile = path.join(tmpDir, "max_failures_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testStandardVoidReturnException";
    const maxFailures = 2;

    const res = await runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--max-failures",
      maxFailures.toString(),
      "--max-tests",
      "100",
      "--seed",
      "cli_seed_max_failures",
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

  it("--max-failures: stop fuzzing python put after 1 failure", async () => {
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
      const res = await runCli([
        pyFile,
        targetFn,
        "--max-runtime",
        "300000",
        "--max-failures",
        "1",
        "--max-tests",
        "10",
        "--seed",
        "cli_seed_py_max_failures",
      ]);

      expect(res.status).toBe(1);
      expect(res.stdout).toContain("Stopped for reason: maxFailures.");
    } finally {
      if (fs.existsSync(pyFile)) {
        try {
          fs.rmSync(pyFile, {
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch {
          // Ignore residual file lock cleanup errors on Windows
        }
      }
    }
  });

  it("--output-file: includes coverage counters", async () => {
    const outputFile = path.join(tmpDir, "cov_counters_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const res = await runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--no-property-oracle",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_cov_counters",
    ]);

    expect(res.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    type OutputDataWithCoverage = FuzzTestResults & {
      stats: {
        measures: {
          CodeCoverageMeasure?: CodeCoverageMeasureStats;
        };
      };
      results: (FuzzTestResults["results"][number] & {
        coverageMeasure?: {
          current?: unknown;
          accum?: unknown;
          accumDelta?: unknown;
          globalDelta?: unknown;
        };
      })[];
    };

    const outputData = JSON5.parse<OutputDataWithCoverage>(
      fs.readFileSync(outputFile, "utf8")
    );

    expect(outputData.stats.measures.CodeCoverageMeasure).toBeDefined();
    const cov = outputData.stats.measures.CodeCoverageMeasure;
    expect(cov).toBeDefined();
    if (cov) {
      expect(cov.counters).toBeDefined();
      expect(typeof cov.counters.statementsTotal).toBe("number");
      expect(typeof cov.counters.statementsCovered).toBe("number");
      expect(typeof cov.counters.functionsTotal).toBe("number");
      expect(typeof cov.counters.functionsCovered).toBe("number");
      expect(typeof cov.counters.branchesTotal).toBe("number");
      expect(typeof cov.counters.branchesCovered).toBe("number");
      expect(Array.isArray(cov.files)).toBeTrue();
      expect(cov.files.length).toBeGreaterThan(0);
    }

    // Verify results[].coverageMeasure only retains `current` (accum/accumDelta/globalDelta omitted)
    expect(outputData.results.length).toBeGreaterThan(0);
    for (const r of outputData.results) {
      if (r.coverageMeasure) {
        expect(r.coverageMeasure.current).toBeDefined();
        expect(r.coverageMeasure.accum).toBeUndefined();
        expect(r.coverageMeasure.accumDelta).toBeUndefined();
        expect(r.coverageMeasure.globalDelta).toBeUndefined();
      }
    }
  });

  it("--debug: `*` scope", async () => {
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const resDefault = await runCli([
      targetFile,
      targetFn,
      "--debug",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_debug_default",
    ]);
    expect(resDefault.status).toBe(0);
  });

  it("--debug: `runners` scope", async () => {
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const resRunners = await runCli([
      targetFile,
      targetFn,
      "--debug",
      "runners",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_debug_runners",
    ]);
    expect(resRunners.status).toBe(0);
  });

  it("--debug: `ai` scope", async () => {
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    const resAi = await runCli([
      targetFile,
      targetFn,
      "--debug",
      "ai",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_debug_ai",
    ]);
    expect(resAi.status).toBe(0);
  });

  /**
   * Commented out so the cache clear does not step on other running tests
   *
  it("--clear-compile-cache: clears compiler cache prior to testing", () => {
    const outputFile = path.join(tmpDir, "clear_cache_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    // First run to populate cache
    const res1 = runCli([
      targetFile,
      targetFn,
      "--max-tests",
      "5",
    ]);
    expect(res1.status).toBe(0);

    // Second run with --clear-compile-cache flag
    const res2 = runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--clear-compile-cache",
      "--max-tests",
      "5",
    ]);

    expect(res2.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );
    expect(outputData.results.length).toBeGreaterThan(0);
  });
  */
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
