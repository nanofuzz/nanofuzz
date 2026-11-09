#!/usr/bin/env node

/**
 * NaNofuzz Agent Benchmark Matrix Orchestrator
 *
 * Runs and tracks the evaluation matrix (engines x invariant sources x replicates)
 * with pre-randomized sequencing, live console turn/tool/phase feedback, automated
 * settings injection, repo isolation/hygiene, and telemetry harvesting.
 *
 * Seed: qwertonyuiop
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

// ============================================================================
// Configuration & Constants
// ============================================================================

const SEED = "qwertonyuiop";
const TARGET_REPO = path.resolve(
  "/Users/mcd2/git/cmumatt/nanofuzz/test-repos/fandango"
);
const REPORTS_DIR = path.resolve(
  "/Users/mcd2/git/cmumatt/nanofuzz/bug-reports/python"
);
const TELEMETRY_DIR = path.join(REPORTS_DIR, "telemetry");
const WS_SETTINGS_PATH = path.join(TARGET_REPO, ".vscode", "settings.json");
const USER_SETTINGS_PATH = path.join(
  os.homedir(),
  "Library/Application Support/Code/User/settings.json"
);
const TRANSCRIPTS_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Code/User/workspaceStorage/ce37efcb06c6ce3fc55a129d9e770193/GitHub.copilot-chat/transcripts"
);

const ENGINES = ["nanofuzz", "hypothesis", "hypofuzz"];
const SOURCES = ["tests", "docs", "all"];

const PRESCRIBED_TARGET_SCOPE = [
  "TreeValue",
  "DerivationTree",
  "Fandango",
  "_distance_norm",
  "make_def",
];

// ============================================================================
// Seeded PRNG & Schedule Generation
// ============================================================================

function seededShuffle(arr, seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  }
  let s = h >>> 0;
  const rnd = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const res = [...arr];
  for (let i = res.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [res[i], res[j]] = [res[j], res[i]];
  }
  return res;
}

function generateSchedule(replicates = 1, seed = SEED) {
  const reps = Array.from({ length: replicates }, (_, i) => i + 1);
  const runs = [];
  let id = 1;
  for (const rep of reps) {
    for (const eng of ENGINES) {
      for (const src of SOURCES) {
        const repSuffix = replicates > 1 ? ` rep${rep}` : ` rep${rep}`;
        const reportFilename = `fandango fuzzer ${eng}+${src}${repSuffix} v6.md`;
        runs.push({
          id: id++,
          replicate: rep,
          engine: eng,
          source: src,
          targetScope: PRESCRIBED_TARGET_SCOPE,
          reportFilename,
          reportPath: path.join(REPORTS_DIR, reportFilename),
          status: "pending",
          bugsFound: 0,
          durationSeconds: null,
          completedAt: null,
        });
      }
    }
  }

  const shuffled = seededShuffle(runs, seed);
  shuffled.forEach((r, idx) => {
    r.sequence = idx + 1;
  });
  return shuffled;
}

function getStateFilePath(totalRuns) {
  return path.resolve(
    process.cwd(),
    `benchmark_state_${totalRuns}_${SEED}.json`
  );
}

function loadOrInitState(totalRuns = 9) {
  const stateFile = getStateFilePath(totalRuns);
  if (fs.existsSync(stateFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (Array.isArray(data) && data.length === totalRuns) {
        for (const item of data) {
          if (fs.existsSync(item.reportPath) && item.status !== "completed") {
            item.status = "completed";
            item.bugsFound = countBugsInReport(item.reportPath);
          }
        }
        return data;
      }
    } catch {}
  }

  const replicates = totalRuns === 27 ? 3 : 1;
  const schedule = generateSchedule(replicates, SEED);
  saveState(schedule, totalRuns);
  return schedule;
}

function saveState(schedule, totalRuns) {
  const stateFile = getStateFilePath(totalRuns || schedule.length);
  const tmpFile = `${stateFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(schedule, null, 2), "utf8");
  fs.renameSync(tmpFile, stateFile);
}

// ============================================================================
// Target Repo Isolation & Hygiene
// ============================================================================

export function cleanTargetRepo() {
  if (!fs.existsSync(TARGET_REPO)) return;
  try {
    execSync("git checkout -- .", { cwd: TARGET_REPO, stdio: "ignore" });
    execSync("git clean -fd", { cwd: TARGET_REPO, stdio: "ignore" });
    execSync("git checkout -q d06277caa78a64816e74afc3085be193c64cf434", {
      cwd: TARGET_REPO,
      stdio: "ignore",
    });
  } catch {}

  // Clean /tmp IPC files
  try {
    const tmpFiles = fs.readdirSync("/tmp");
    for (const f of tmpFiles) {
      if (f.startsWith("nanofuzz_pbt_") || f.startsWith("nanofuzz_")) {
        try {
          fs.unlinkSync(path.join("/tmp", f));
        } catch {}
      }
    }
  } catch {}
}

// ============================================================================
// Settings Management
// ============================================================================

function updateSettingInFile(filePath, key, valRepr) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `{\n  "${key}": ${valRepr}\n}\n`, "utf8");
    return;
  }

  const text = fs.readFileSync(filePath, "utf8");
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pat = new RegExp(
    `("${escaped}"\\s*:\\s*)(?:\\[[^\\]]*\\]|"[^"]*"|true|false|\\d+|null)`
  );
  let newText;
  if (pat.test(text)) {
    newText = text.replace(pat, `$1${valRepr}`);
  } else {
    newText = text.replace(/(\n?\s*\}\s*)$/, `,\n  "${key}": ${valRepr}$1`);
  }
  fs.writeFileSync(filePath, newText, "utf8");
}

export function applySettings(engine, source) {
  const scopeRepr = JSON.stringify(PRESCRIBED_TARGET_SCOPE, null, 2).replace(
    /\n/g,
    "\n  "
  );

  // 1. Workspace settings
  updateSettingInFile(
    WS_SETTINGS_PATH,
    "nanofuzz.experimental.findBugs.tool",
    JSON.stringify(engine)
  );
  updateSettingInFile(
    WS_SETTINGS_PATH,
    "nanofuzz.experimental.findBugs.invariantSource",
    JSON.stringify(source)
  );
  updateSettingInFile(
    WS_SETTINGS_PATH,
    "nanofuzz.experimental.findBugs.targetScope",
    scopeRepr
  );

  // 2. User settings
  if (fs.existsSync(USER_SETTINGS_PATH)) {
    updateSettingInFile(
      USER_SETTINGS_PATH,
      "nanofuzz.experimental.findBugs.tool",
      JSON.stringify(engine)
    );
    updateSettingInFile(
      USER_SETTINGS_PATH,
      "nanofuzz.experimental.findBugs.invariantSource",
      JSON.stringify(source)
    );
    updateSettingInFile(
      USER_SETTINGS_PATH,
      "nanofuzz.experimental.findBugs.targetScope",
      scopeRepr
    );
  }
}

// ============================================================================
// Prompt Formatter (Clean — Target Repo & Report Location Only)
// ============================================================================

export function formatPrompt(run) {
  const reportRel = `../nanofuzz/bug-reports/python/${run.reportFilename}`;
  return [
    `Target Repository: ${TARGET_REPO}`,
    "",
    `Use NaNofuzz to find bugs in fandango fuzzer for Python located at ${TARGET_REPO}.`,
    `(do not look at '../nanofuzz/bug-reports'; after the find_bugs workflow completes, save your bug report to '${reportRel}')`,
  ].join("\n");
}

function countBugsInReport(reportPath) {
  if (!fs.existsSync(reportPath)) return 0;
  try {
    const content = fs.readFileSync(reportPath, "utf8");
    let count = 0;
    for (const line of content.split("\n")) {
      const s = line.trim();
      if (
        s.startsWith("### BUG-") ||
        s.startsWith("### Bug ") ||
        s.startsWith("## BUG-")
      ) {
        count++;
      } else if (s.startsWith("| BUG-") || s.startsWith("| **BUG-")) {
        count++;
      }
    }
    return count > 0 ? count : 1;
  } catch {
    return 1;
  }
}

/**
 * Harvests and extracts structured telemetry for the completed session.
 */
function harvestSessionTelemetry(run, transcriptPath) {
  if (!fs.existsSync(TELEMETRY_DIR)) {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  }

  const baseName = run.reportFilename.replace(/\.md$/, "");
  const telemetryJsonPath = path.join(
    TELEMETRY_DIR,
    `${baseName}.telemetry.json`
  );

  let toolEvents = [];
  let sessionId = null;

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (
            data.type === "tool.execution_start" &&
            data.data?.toolName?.startsWith("nanofuzz_")
          ) {
            toolEvents.push({
              tool: data.data.toolName,
              args: data.data.arguments,
              timestamp: data.timestamp,
            });
            if (data.data.toolName === "nanofuzz_findBugs") {
              const sp = data.data.arguments?.statePayload;
              if (sp?.sessionId) sessionId = sp.sessionId;
            }
          }
        } catch {}
      }
    } catch {}
  }

  const telemetryPayload = {
    sequence: run.sequence,
    replicate: run.replicate,
    engine: run.engine,
    source: run.source,
    targetScope: run.targetScope,
    reportFilename: run.reportFilename,
    sessionId: sessionId || "unknown",
    durationSeconds: run.durationSeconds,
    completedAt: run.completedAt,
    bugsFound: run.bugsFound,
    transcriptFile: transcriptPath ? path.basename(transcriptPath) : null,
    nanofuzzEventCount: toolEvents.length,
    events: toolEvents,
  };

  fs.writeFileSync(
    telemetryJsonPath,
    JSON.stringify(telemetryPayload, null, 2),
    "utf8"
  );
  console.log(
    `📊 Harvested telemetry: ${path.relative(process.cwd(), telemetryJsonPath)} (${toolEvents.length} events)`
  );
}

// ============================================================================
// Live Console Feedback & Watchdog
// ============================================================================

function findNewestTranscript(sinceMs = 0) {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return null;
  const files = fs
    .readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fp = path.join(TRANSCRIPTS_DIR, f);
      const stat = fs.statSync(fp);
      return { fp, mtimeMs: stat.mtimeMs };
    })
    .filter((item) => item.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.length > 0 ? files[0].fp : null;
}

export async function watchRun(
  run,
  totalRuns,
  pollIntervalMs = 2500,
  maxTimeoutMs = 1800000
) {
  const startTime = Date.now();
  const reportPath = run.reportPath;
  let activeTranscriptPath = null;
  let transcriptBytesRead = 0;
  let currentPhase = "init";
  let lastActionTime = Date.now();
  let lastHeartbeat = Date.now();

  const seqStr = String(run.sequence).padStart(2, "0");
  const totalStr = String(totalRuns).padStart(2, "0");
  const prefix = `[Run ${seqStr}/${totalStr}]`;

  console.log(`\n${prefix} 🔭 Monitoring agent progress...`);
  console.log(`${prefix} 📄 Awaiting report: ${run.reportFilename}`);

  while (Date.now() - startTime < maxTimeoutMs) {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const ss = String(elapsedSec % 60).padStart(2, "0");
    const timeStr = `${mm}m ${ss}s`;

    // 1. Check for report file completion
    if (fs.existsSync(reportPath)) {
      const stat = fs.statSync(reportPath);
      if (stat.size > 500) {
        const text = fs.readFileSync(reportPath, "utf8");
        if (
          text.includes("# ") &&
          (text.includes("BUG-") ||
            text.includes("Bug") ||
            text.includes("Summary"))
        ) {
          const bugs = countBugsInReport(reportPath);
          run.status = "completed";
          run.durationSeconds = elapsedSec;
          run.completedAt = new Date().toISOString();
          run.bugsFound = bugs;

          // Harvest structured session telemetry before repo cleaning
          harvestSessionTelemetry(run, activeTranscriptPath);

          console.log(
            `\n================================================================================`
          );
          console.log(
            `✅ ${prefix} COMPLETED in ${timeStr}! Found ${bugs} bug(s).`
          );
          console.log(`📄 Saved to: ${reportPath}`);
          console.log(`🧹 Cleaning target repository...`);
          cleanTargetRepo();
          console.log(
            `================================================================================\n`
          );
          return true;
        }
      }
    }

    // 2. Locate active transcript if not yet identified
    if (!activeTranscriptPath) {
      activeTranscriptPath = findNewestTranscript(startTime - 60000);
      if (activeTranscriptPath) {
        transcriptBytesRead = 0;
      }
    }

    // 3. Tail active transcript file for live agent turn & tool events
    if (activeTranscriptPath && fs.existsSync(activeTranscriptPath)) {
      const stat = fs.statSync(activeTranscriptPath);
      if (stat.size > transcriptBytesRead) {
        const fd = fs.openSync(activeTranscriptPath, "r");
        const buf = Buffer.alloc(stat.size - transcriptBytesRead);
        fs.readSync(fd, buf, 0, buf.length, transcriptBytesRead);
        fs.closeSync(fd);
        transcriptBytesRead = stat.size;

        const lines = buf.toString("utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === "tool.execution_start") {
              lastActionTime = Date.now();
              const tool = data.data?.toolName;
              const args = data.data?.arguments || {};

              if (tool === "nanofuzz_findBugs") {
                const nextP = args.phase || currentPhase;
                const sp = args.statePayload || {};
                const stage = sp.stage ? ` [Stage: ${sp.stage}]` : "";
                const fn = sp.functionName ? ` (fn: ${sp.functionName})` : "";
                currentPhase = nextP;
                console.log(
                  `  ${prefix} ⏱ ${timeStr} ━━ Phase: ${currentPhase}${stage}${fn}`
                );
              } else if (tool === "nanofuzz_fuzzFunction") {
                const fn = args.functionName || "";
                const maxTests =
                  args.maxTests === 0
                    ? "continuous (maxTests=0)"
                    : `${args.maxTests} tests`;
                const timeoutSec = Math.round((args.timeoutMs || 0) / 1000);
                console.log(
                  `  ${prefix} ⏱ ${timeStr} ── ⚡ Fuzzing: ${fn} (${maxTests}, timeout=${timeoutSec}s)`
                );
              } else if (tool === "nanofuzz_listTargets") {
                const rel = (args.filePath || "")
                  .split("/")
                  .slice(-2)
                  .join("/");
                console.log(
                  `  ${prefix} ⏱ ${timeStr} ── 🎯 Scanning targets: ${rel}`
                );
              } else if (
                tool === "create_file" ||
                tool === "replace_string_in_file"
              ) {
                const rel = (args.filePath || "")
                  .split("/")
                  .slice(-2)
                  .join("/");
                console.log(`  ${prefix} ⏱ ${timeStr} ── ✍️  Writing: ${rel}`);
              } else if (tool === "read_file") {
                const rel = (args.filePath || "")
                  .split("/")
                  .slice(-2)
                  .join("/");
                console.log(`  ${prefix} ⏱ ${timeStr} ── 📖 Reading: ${rel}`);
              }
            }
          } catch {}
        }
      }
    }

    // 4. Heartbeat status indicator every 20s if no tool logged
    if (Date.now() - lastHeartbeat >= 20000) {
      const idleSec = Math.floor((Date.now() - lastActionTime) / 1000);
      const idleNotice =
        idleSec > 45 ? ` (awaiting LLM response: ${idleSec}s)` : "";
      console.log(
        `  ${prefix} ⏱ ${timeStr} .. [Phase: ${currentPhase}]${idleNotice}`
      );
      lastHeartbeat = Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.log(
    `\n❌ ${prefix} EXCEEDED TIMEOUT (30 minutes). Cleaning repository.`
  );
  run.status = "timeout";
  cleanTargetRepo();
  return false;
}

// ============================================================================
// Actions & CLI Commands
// ============================================================================

export function showPlan(schedule) {
  const total = schedule.length;
  console.log("=".repeat(80));
  console.log(`BENCHMARK SCHEDULE: ${total} RUNS (Seed: '${SEED}')`);
  console.log(`Target Repo: ${TARGET_REPO}`);
  console.log(`Prescribed Scope: ${PRESCRIBED_TARGET_SCOPE.join(", ")}`);
  console.log("=".repeat(80));
  console.log(
    `Seq | Rep | Engine     | Source | Status    | Destination Report`
  );
  console.log("-".repeat(80));
  for (const r of schedule) {
    const icon =
      r.status === "completed" ? "✅" : r.status === "running" ? "⏳" : "⚪";
    const seq = String(r.sequence).padStart(2, "0");
    const rep = String(r.replicate).padStart(3, " ");
    const eng = r.engine.padEnd(10, " ");
    const src = r.source.padEnd(6, " ");
    const st = `${icon} ${r.status}`.padEnd(9, " ");
    console.log(
      `${seq}  | ${rep} | ${eng} | ${src} | ${st} | ${r.reportFilename}`
    );
  }
  console.log("=".repeat(80));
}

export function showSummary(schedule) {
  const completed = schedule.filter((r) => r.status === "completed");
  console.log("\n### 📊 Benchmark Matrix Summary\n");
  console.log(
    `- **Total Runs**: ${schedule.length} | **Completed**: ${completed.length} | **Pending**: ${schedule.length - completed.length}`
  );
  console.log(`- **Randomization Seed**: \`${SEED}\`\n`);
  console.log(
    "| Seq | Replicate | Engine | Invariant Source | Duration | Bugs Found | Status |"
  );
  console.log(
    "| :-: | :-------: | :----: | :--------------: | :------: | :--------: | :----: |"
  );
  for (const r of schedule) {
    const dur = r.durationSeconds
      ? `${Math.floor(r.durationSeconds / 60)}m ${r.durationSeconds % 60}s`
      : "—";
    const bugs = r.status === "completed" ? r.bugsFound : "—";
    const seq = String(r.sequence).padStart(2, "0");
    console.log(
      `| ${seq} | Rep ${r.replicate} | \`${r.engine}\` | \`${r.source}\` | ${dur} | ${bugs} | ${r.status} |`
    );
  }
  console.log("");
}

export function prepareRun(schedule, seqNum, totalRuns) {
  const run = schedule.find((r) => r.sequence === seqNum);
  if (!run) {
    throw new Error(
      `Run with sequence ${seqNum} not found (valid: 1..${schedule.length}).`
    );
  }

  cleanTargetRepo();
  applySettings(run.engine, run.source);
  run.status = "running";
  saveState(schedule, totalRuns);

  const seqStr = String(run.sequence).padStart(2, "0");
  const totalStr = String(totalRuns).padStart(2, "0");

  console.log("\n" + "=".repeat(80));
  console.log(
    `🚀 PREPARED TASK [${seqStr}/${totalStr}]: Replicate ${run.replicate} (Engine: ${run.engine} | Source: ${run.source})`
  );
  console.log("=".repeat(80));
  console.log("\n👉 Paste this exact prompt into your Copilot Chat session:\n");
  console.log("-".repeat(80));
  console.log(formatPrompt(run));
  console.log("-".repeat(80) + "\n");

  return run;
}

export function markCompleted(schedule, seqNum, totalRuns) {
  const run = schedule.find((r) => r.sequence === seqNum);
  if (!run) throw new Error(`Run sequence ${seqNum} not found.`);
  run.status = "completed";
  run.bugsFound = countBugsInReport(run.reportPath);
  run.completedAt = new Date().toISOString();
  cleanTargetRepo();
  saveState(schedule, totalRuns);
  console.log(
    `[OK] Run ${seqNum} marked completed (${run.bugsFound} bugs). Target repo cleaned.`
  );
}

async function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

async function runInteractive(schedule, totalRuns) {
  const pending = schedule.filter((r) => r.status !== "completed");
  if (pending.length === 0) {
    console.log("[ALL COMPLETE] All runs are completed!");
    showSummary(schedule);
    return;
  }

  console.log(
    `[START] Interactive execution for ${pending.length} pending task(s) of ${totalRuns}.`
  );
  for (const run of pending) {
    prepareRun(schedule, run.sequence, totalRuns);
    await promptUser(
      "Press [Enter] once you have pasted the prompt to begin live console monitoring..."
    );
    const success = await watchRun(run, totalRuns);
    saveState(schedule, totalRuns);
    if (!success) {
      const retry = (
        await promptUser(
          `Run ${run.sequence} timed out. Retry this run? [y/N]: `
        )
      )
        .trim()
        .toLowerCase();
      if (retry === "y") {
        prepareRun(schedule, run.sequence, totalRuns);
        await watchRun(run, totalRuns);
        saveState(schedule, totalRuns);
      }
    }
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const isFull =
    args.includes("--full") ||
    args.includes("--replicates=3") ||
    args.includes("-27");
  const totalRuns = isFull ? 27 : 9;

  if (args.includes("--clean")) {
    cleanTargetRepo();
    console.log("[CLEAN] Target repo cleaned.");
    return;
  }

  const schedule = loadOrInitState(totalRuns);

  if (args.includes("--plan") || args.includes("--status")) {
    showPlan(schedule);
    return;
  }

  if (args.includes("--summary")) {
    showSummary(schedule);
    return;
  }

  const prepIdx = args.findIndex((a) => a === "--prepare");
  if (prepIdx !== -1 && args[prepIdx + 1]) {
    const seq = parseInt(args[prepIdx + 1], 10);
    prepareRun(schedule, seq, totalRuns);
    return;
  }

  const watchIdx = args.findIndex((a) => a === "--watch");
  if (watchIdx !== -1 && args[watchIdx + 1]) {
    const seq = parseInt(args[watchIdx + 1], 10);
    const run = schedule.find((r) => r.sequence === seq);
    if (!run) {
      console.error(`Run sequence ${seq} not found.`);
      process.exit(1);
    }
    await watchRun(run, totalRuns);
    saveState(schedule, totalRuns);
    return;
  }

  const compIdx = args.findIndex((a) => a === "--complete");
  if (compIdx !== -1 && args[compIdx + 1]) {
    const seq = parseInt(args[compIdx + 1], 10);
    markCompleted(schedule, seq, totalRuns);
    return;
  }

  if (args.includes("--interactive") || args.includes("-i")) {
    await runInteractive(schedule, totalRuns);
    return;
  }

  // Default: display schedule and quick start
  showPlan(schedule);
  console.log(
    `\nDefault mode: 9 runs (3x3 smoke test). Pass '--full' for 27 runs.`
  );
  console.log("\nCommands:");
  console.log(
    "  yarn benchmark --interactive   # Guided live loop for all pending runs"
  );
  console.log(
    "  yarn benchmark --prepare 1     # Setup environment & get prompt for Run 1"
  );
  console.log(
    "  yarn benchmark --watch 1       # Live-monitor Run 1 until completion"
  );
  console.log(
    "  yarn benchmark --summary       # Print summary table of completed runs"
  );
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
