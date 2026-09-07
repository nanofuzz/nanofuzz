const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Determine test files to run
function getTestFiles() {
  const args = process.argv.slice(2);

  // If specific files or filter keywords were passed via CLI args
  if (args.length > 0) {
    const allFiles = findTestFiles("src");
    return allFiles.filter((file) =>
      args.some((arg) => file.includes(arg) || path.basename(file) === arg)
    );
  }

  return findTestFiles("src");
}

// Find all test/spec files under a directory
function findTestFiles(dir) {
  const testPattern = /\.(test|spec)\.[tm]?[js]$/;
  const relativeFiles = fs.readdirSync(dir, { recursive: true });
  return relativeFiles
    .filter((f) => testPattern.test(f))
    .map((f) => path.join(dir, f));
}

// Prioritize known longer running test files to run early in the queue
function sortTestFiles(files) {
  const priority = [
    "FuzzerCoverageOneFile.test.ts",
    "FuzzerPython.test.ts",
    "FuzzerExamples1.test.ts",
    "FuzzerExamples2.test.ts",
    "FuzzerTypescript.test.ts",
    "ArgDef.test.ts",
    "CommandLine.test.ts",
    "TypescriptCoverageMeasure.test.ts",
    "PythonCoverageMeasure.test.ts",
  ];

  return [...files].sort((a, b) => {
    const pA = priority.findIndex((p) => a.includes(p));
    const pB = priority.findIndex((p) => b.includes(p));
    if (pA !== -1 && pB !== -1) return pA - pB;
    if (pA !== -1) return -1;
    if (pB !== -1) return 1;
    return a.localeCompare(b);
  });
}

// Run a single test file in a spawned Node process
function runTestFile(file) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const jasmineBin = path.resolve("./node_modules/jasmine/bin/jasmine.js");

    const child = spawn(
      process.execPath,
      ["--no-experimental-strip-types", jasmineBin, file],
      {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      const durationSec = (durationMs / 1000).toFixed(2);

      // Parse spec count if present in Jasmine output
      const specsMatch = stdout.match(/(\d+)\s+specs?,\s+(\d+)\s+failures?/i);
      const specs = specsMatch ? parseInt(specsMatch[1], 10) : 0;
      const failures = specsMatch
        ? parseInt(specsMatch[2], 10)
        : code !== 0
          ? 1
          : 0;

      resolve({
        file,
        code,
        durationMs,
        durationSec,
        specs,
        failures,
        stdout,
        stderr,
      });
    });
  });
}

async function main() {
  const rawFiles = getTestFiles();
  if (rawFiles.length === 0) {
    console.log("No test files found matching criteria.");
    process.exit(0);
  }

  const testFiles = sortTestFiles(rawFiles);

  // Use OS available parallelism (number of CPU cores) or JOBS env var
  const maxConcurrency = process.env.JOBS
    ? parseInt(process.env.JOBS, 10)
    : Math.max(
        1,
        os.availableParallelism ? os.availableParallelism() : os.cpus().length
      );

  const totalFiles = testFiles.length;
  console.log(
    `Running ${totalFiles} test file(s) in parallel using ${maxConcurrency} worker(s)...\n`
  );

  const overallStartTime = Date.now();
  const results = [];
  let completedCount = 0;
  let totalSpecsRun = 0;
  let totalFailures = 0;

  // Work queue worker pool
  async function worker() {
    while (testFiles.length > 0) {
      const file = testFiles.shift();
      const res = await runTestFile(file);
      results.push(res);
      completedCount++;
      totalSpecsRun += res.specs;
      totalFailures += res.failures;

      const statusTag = res.code === 0 ? "✓ PASS" : "❌ FAIL";
      const progress = `[${completedCount}/${totalFiles}]`;
      console.log(
        `${progress.padStart(7)} ${statusTag} ${res.file} (${res.durationSec}s)`
      );

      // Print output inline if test failed
      if (res.code !== 0) {
        console.error(`\n--- FAILURE OUTPUT: ${res.file} ---`);
        if (res.stdout) console.error(res.stdout);
        if (res.stderr) console.error(res.stderr);
        console.error(`--- END FAILURE OUTPUT ---\n`);
      }
    }
  }

  // Spawn initial set of worker loops
  const workers = Array.from(
    { length: Math.min(maxConcurrency, totalFiles) },
    () => worker()
  );

  await Promise.all(workers);

  const totalTimeSec = ((Date.now() - overallStartTime) / 1000).toFixed(2);
  const failedResults = results.filter((r) => r.code !== 0);

  console.log("\n" + "=".repeat(60));
  if (failedResults.length > 0) {
    console.error(
      `❌ TEST RUN FAILED: ${failedResults.length}/${totalFiles} file(s) failed.`
    );
    console.error(
      `Summary: ${totalSpecsRun} specs total, ${totalFailures} failed across ${totalFiles} files in ${totalTimeSec}s.\n`
    );
    process.exit(1);
  } else {
    console.log(`✅ ALL TESTS PASSED!`);
    console.log(
      `Summary: ${totalSpecsRun} specs total across ${totalFiles} files in ${totalTimeSec}s.\n`
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error running parallel tests:", err);
  process.exit(1);
});
