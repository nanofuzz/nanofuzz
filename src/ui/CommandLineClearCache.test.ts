/**
 * Tests CLI `--clear-compile-cache`, which wipes all compiler caches.
 * Must run first in isolation (Phase 0 in test.cjs) so it does not delete
 * active build directories while other test suites compile in parallel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";
import { FuzzTestResults } from "../fuzzer/Types";
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

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(" ") + "\n";
  };
  console.info = (...args: unknown[]) => {
    stdout += args.map(String).join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    stderr += args.map(String).join(" ") + "\n";
  };

  try {
    const effectiveArgs = [...args];
    if (
      !effectiveArgs.includes("--workers") &&
      !effectiveArgs.includes("-w") &&
      !effectiveArgs.includes("--help") &&
      !effectiveArgs.includes("-h") &&
      !effectiveArgs.includes("--version") &&
      !effectiveArgs.includes("-V")
    ) {
      effectiveArgs.push("--workers", "1");
    }
    if (
      !effectiveArgs.includes("--no-progress-bar") &&
      !effectiveArgs.includes("--help") &&
      !effectiveArgs.includes("-h") &&
      !effectiveArgs.includes("--version") &&
      !effectiveArgs.includes("-V")
    ) {
      effectiveArgs.push("--no-progress-bar");
    }
    const status = await runCliInProcess(effectiveArgs);
    return { status, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.info = origConsoleInfo;
    console.error = origConsoleError;
  }
}

describe("CommandLine: --clear-compile-cache isolated", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nanofuzz-cli-cache-")
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("outputs Compile and Instrument messages below Target and above Inputs with --clear-compile-cache", async () => {
    const targetFile = path.join(tmpDir, "compile_order_target.ts");
    fs.writeFileSync(
      targetFile,
      `export function sampleFn(x: number): number {\n  return x * 2;\n}\n`,
      "utf8"
    );

    const res = await runCli([
      targetFile,
      "sampleFn",
      "--clear-compile-cache",
      "--max-tests",
      "1",
      "--seed",
      "cli_compile_order_test",
    ]);

    expect(res.status).toBe(0);
    const targetIdx = res.stdout.indexOf("Target:");
    const cacheClearedIdx = res.stdout.indexOf(" - Compile cache cleared");
    const compileIdx = res.stdout.indexOf(" - Compile...:");
    const instrumentIdx = res.stdout.indexOf(" - Instrument:");
    const inputsIdx = res.stdout.indexOf("Inputs:");
    const onlineIdx = res.stdout.indexOf("Online:");

    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(cacheClearedIdx).toBeGreaterThan(targetIdx);
    expect(compileIdx).toBeGreaterThan(cacheClearedIdx);
    expect(instrumentIdx).toBeGreaterThan(compileIdx);
    expect(inputsIdx).toBeGreaterThan(instrumentIdx);
    expect(onlineIdx).toBeGreaterThan(inputsIdx);
  });

  it("executes --clear-compile-cache and produces valid test results", async () => {
    const outputFile = path.join(tmpDir, "clear_cache_output.json5");
    const targetFile = "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts";
    const targetFn = "testCoverageOneFile";

    // First run to populate cache
    const res1 = await runCli([targetFile, targetFn, "--max-tests", "5"]);
    expect(res1.status).toBe(0);

    // Second run with --clear-compile-cache flag
    const res2 = await runCli([
      targetFile,
      targetFn,
      "--output-file",
      outputFile,
      "--output-results",
      "all",
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
});
