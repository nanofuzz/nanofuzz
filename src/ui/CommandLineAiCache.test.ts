import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";
import * as zod from "zod/v4";
import * as Config from "../Config";
import { FuzzTestResults } from "../fuzzer/Fuzzer";
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

describe("cli: ai cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    Config.clearOverrides();
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-cli-ai-cache-test-")
    );
  });

  afterEach(() => {
    Config.clearOverrides();
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
      "--no-random-input-generator",
      "--no-mutation-input-generator",
      "--max-tests",
      "1",
      "--seed",
      "cli_seed_ai_cache_miss",
    ]);

    if (res.status !== 3) {
      console.error("CLI STDOUT:", res.stdout);
      console.error("CLI STDERR:", res.stderr);
    }

    expect(res.status).toBe(3);
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

    Config.override("nanofuzz.ai.provider", provider);
    Config.override("nanofuzz.ai.model", modelName);
    Config.override("nanofuzz.ai.apiKey", "test-key");
    Config.override("nanofuzz.ai.backfeedPriorInputs", true);

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

    const seededInputs = Array.from({ length: numRequested }, (_, i) => ({
      s: `s${i.toString().padStart(3, "0")}`,
    }));

    const seededEntry = {
      key,
      request: { provider, modelName, prompt: [promptText], schemaJson },
      response: {
        text: JSON.stringify({
          programInputs: seededInputs,
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
      JSON5.stringify(
        {
          toolVersion: "NaNofuzz v0.4.0",
          recordings: [seededEntry],
        },
        null,
        2
      ),
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
      "--no-random-input-generator",
      "--no-mutation-input-generator",
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

  it("--ai-cache-delay: validates and perturbs delay", async () => {
    const targetFile = path.resolve(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const targetFn = "testCoverageOneFile";

    // Invalid delay spec should fail CLI option parsing
    const resInvalid = await runCli([
      targetFile,
      targetFn,
      "--ai-cache-delay",
      "invalid-delay-xyz",
    ]);
    expect(resInvalid.status).not.toBe(0);
    expect(resInvalid.stderr).toContain("Invalid ai cache delay");

    // Conflicting fixed and window delay should fail CLI option parsing
    const resConflict = await runCli([
      targetFile,
      targetFn,
      "--ai-cache-delay",
      "100ms 50..200ms",
    ]);
    expect(resConflict.status).not.toBe(0);
    expect(resConflict.stderr).toContain("Conflicting base delay");

    // Valid composed delay rule executes cleanly in replay-error mode
    const outputFile = path.join(tmpDir, "ai_delay_output.json5");
    const cacheFile = path.join(tmpDir, "cli_llm_cache_delay.json");
    const provider = "gemini";
    const modelName = "gemini-flash";
    const seed = "cli_seed_ai_cache_delay";

    Config.override("nanofuzz.ai.provider", provider);
    Config.override("nanofuzz.ai.model", modelName);
    Config.override("nanofuzz.ai.apiKey", "test-key");
    Config.override("nanofuzz.ai.backfeedPriorInputs", true);

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
          programInputs: Array.from({ length: numRequested }, (_, i) => ({
            s: `s${i.toString().padStart(3, "0")}`,
          })),
        }),
        stats: {
          tokensSent: 100,
          tokensSentCost: { amt: 0.001, unit: "USD" },
          tokensReceived: 50,
          tokensReceivedCost: { amt: 0.001, unit: "USD" },
        },
      },
      delayMs: 30,
      recordedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      cacheFile,
      JSON5.stringify(
        {
          toolVersion: "NaNofuzz v0.4.0",
          recordings: [seededEntry],
        },
        null,
        2
      ),
      "utf8"
    );

    const resValid = await runCli([
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
      "--ai-cache-delay",
      "0.5x +10ms [15..45ms]",
      "--no-random-input-generator",
      "--no-mutation-input-generator",
      "--max-tests",
      "1",
      "--seed",
      seed,
    ]);

    expect(resValid.status).toBe(0);
    expect(fs.existsSync(outputFile)).toBeTrue();

    const outputData = JSON5.parse<FuzzTestResults>(
      fs.readFileSync(outputFile, "utf8")
    );
    const aiGenStats = outputData.stats.generators.AiInputGenerator?.gen;
    expect(aiGenStats?.cache?.mode).toBe("replay-error");
    expect(aiGenStats?.cache?.calls).toBe(1);
    expect(aiGenStats?.cache?.hits).toBe(1);
    expect(aiGenStats?.cache?.misses).toBe(0);
    expect(outputData.stats.timers.total).toBeGreaterThanOrEqual(15);
  });
});
