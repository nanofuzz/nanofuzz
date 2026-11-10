import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as Config from "../Config";
import { isKeyedObject } from "../Util";
import { sessionManager } from "./FindBugsSessionManager";
import { formatDuration } from "./FuzzTextFormatter";
import { clearCachedRawResultsForPath } from "./Agent";

// ============================================================================
// Configuration
// ============================================================================

const SEED = "qwertonyuiop";
const WORKSPACE_ROOT = resolveWorkspaceRoot();
const SOURCE_REPO = resolveSourceRepo();

const BENCHMARK_DIR = path.join(WORKSPACE_ROOT, "benchmark");
const WORKTREES_DIR = path.join(BENCHMARK_DIR, "worktrees");
const RESULTS_DIR = path.join(BENCHMARK_DIR, "results");
const REPORTS_DIR = RESULTS_DIR;
const TELEMETRY_DIR = path.join(RESULTS_DIR, "telemetry");

const SCORING_SHEETS_DIR = path.join(RESULTS_DIR, "scoring_sheets");
const DATA_CSV_PATH = path.join(RESULTS_DIR, "data.csv");
const SURVEY_RESPONSES_CSV_PATH = path.join(
  RESULTS_DIR,
  "survey_responses.csv"
);
const STATE_JSON_PATH = path.join(RESULTS_DIR, "benchmark_state.json");
const RUBRIC_JSON_PATH = path.join(
  WORKSPACE_ROOT,
  "benchmark",
  "scripts",
  "ground_truth_rubric.json"
);

const rubricData = loadBenchmarkRubric(RUBRIC_JSON_PATH);
export const TARGET_NAME = rubricData.targetMetadata.name;
export const TARGET_COMMIT = rubricData.targetMetadata.commit;
export const TARGET_VERSION = rubricData.targetMetadata.version;
export const BENCHMARK_TASKS = rubricData.tasks;
export type BenchmarkTaskName = string;
export const GROUND_TRUTH_BUGS = rubricData.groundTruthBugs;
export const ALL_GROUND_TRUTH_BUG_IDS = rubricData.allGroundTruthBugIds;

export const CONCURRENCY_LANES = getAutoConcurrencyLanes();
export const MAX_DEEP_FUZZ_SLOTS = getAutoDeepFuzzSlots();

const ENGINES = ["nanofuzz", "hypothesis", "hypofuzz"] as const;
const SOURCES = ["tests", "docs", "all"] as const;

export interface BenchmarkRunSpec {
  participant: string; // e.g. "P01", "P02", ...
  sequence: number;
  replicate: number;
  task: BenchmarkTaskName;
  engine: (typeof ENGINES)[number];
  source: (typeof SOURCES)[number];
  targetScope: string[];
  reportFilename: string;
  reportPath: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let activeCts: vscode.CancellationTokenSource | undefined;

function getOutput(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("NaNofuzz Benchmark");
  }
  return outputChannel;
}

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  getOutput().appendLine(`[${ts}] ${msg}`);
} // fn: log

/**
 * Appends unformatted raw text to the output channel.
 *
 * @param msg raw string message to append
 */
function logRaw(msg: string): void {
  getOutput().appendLine(msg);
} // fn: logRaw

/**
 * Cancels any actively running benchmark matrix session.
 */
export function cancelBenchmarkMatrix(): void {
  if (activeCts) {
    activeCts.cancel();
    activeCts.dispose();
    activeCts = undefined;
    dashboardTracker.dispose();
    log("[CANCEL] Benchmark run cancelled by user.");
    cleanTargetRepo();
    vscode.window.showInformationMessage("NaNofuzz Benchmark cancelled.");
  } else {
    vscode.window.showInformationMessage(
      "No active NaNofuzz Benchmark to cancel."
    );
  }
} // fn: cancelBenchmarkMatrix

// ============================================================================
// Deterministic Seeded Shuffle
// ============================================================================

function seededShuffle<T>(arr: T[], seedStr: string): T[] {
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
    const tmp = res[i];
    res[i] = res[j];
    res[j] = tmp;
  }
  return res;
}

export function generateBenchmarkSchedule(
  replicates: 1 | 3 = 1
): BenchmarkRunSpec[] {
  const reps = Array.from({ length: replicates }, (_, i) => i + 1);
  const runs: Omit<BenchmarkRunSpec, "sequence" | "participant">[] = [];

  for (const rep of reps) {
    for (const eng of ENGINES) {
      for (const src of SOURCES) {
        for (const task of BENCHMARK_TASKS) {
          const reportFilename = `${TARGET_NAME} ${eng}+${src}+${task} rep${rep} v6.md`;
          runs.push({
            replicate: rep,
            task,
            engine: eng,
            source: src,
            targetScope: [task], // Explicit single entrypoint task
            reportFilename,
            reportPath: path.join(REPORTS_DIR, reportFilename),
          });
        }
      }
    }
  }

  const shuffled = seededShuffle(runs, SEED);
  return shuffled.map((r, idx) => {
    const seq = idx + 1;
    const participant = `P${String(seq).padStart(2, "0")}`;
    return {
      ...r,
      sequence: seq,
      participant,
    };
  });
}

// ============================================================================
// State Checkpointing & Resumption
// ============================================================================

export interface BenchmarkScheduleItemState {
  participant: string;
  sequence: number;
  replicate: number;
  task: BenchmarkTaskName;
  engine: (typeof ENGINES)[number];
  source: (typeof SOURCES)[number];
  reportFilename: string;
  status: "pending" | "running" | "completed" | "failed";
  completedAt?: string;
  durationSec?: number;
  score?: string;
  bugsElicited?: number;
  taskBugCount?: number;
  error?: string;
}

/**
 * Discovers previously completed participants from state file and disk telemetry.
 *
 * @returns map of participant ID to its completed schedule item state
 */
export function loadCompletedParticipants(): Map<
  string,
  BenchmarkScheduleItemState
> {
  const completed = new Map<string, BenchmarkScheduleItemState>();

  // Recover from benchmark_state.json if present
  if (fs.existsSync(STATE_JSON_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_JSON_PATH, "utf8"));
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && item.participant && item.status === "completed") {
          completed.set(item.participant, item);
        }
      }
    }
  }

  // Discover from telemetry JSON files on disk (ground truth completed runs)
  if (fs.existsSync(TELEMETRY_DIR)) {
    const files = fs.readdirSync(TELEMETRY_DIR);
    for (const file of files) {
      if (!file.endsWith(".telemetry.json")) continue;
      const filePath = path.join(TELEMETRY_DIR, file);
      const t = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const hasDeep =
        Array.isArray(t.fuzzRuns) &&
        t.fuzzRuns.some(
          (r: { suiteTimeout?: number; maxTests?: number }) =>
            (r.suiteTimeout ?? 0) >= 300000 &&
            (r.maxTests === 0 || r.maxTests === Number.MAX_SAFE_INTEGER)
        );
      if (
        t &&
        t.participant &&
        !t.error &&
        t.success !== false &&
        hasDeep &&
        !completed.has(t.participant)
      ) {
        const taskName = t.task;
        const taskBugs = GROUND_TRUTH_BUGS[taskName] || [];
        const taskBugCount =
          Array.isArray(t.evalResults) && t.evalResults.length > 0
            ? t.evalResults.length
            : taskBugs.length;
        const bugsElicited =
          Array.isArray(t.evalResults) && t.evalResults.length > 0
            ? t.evalResults.filter(
                (r: { elicited: number }) => r.elicited === 1
              ).length
            : 0;
        const score =
          taskBugCount > 0 ? (bugsElicited / taskBugCount).toFixed(3) : "0.000";
        completed.set(t.participant, {
          participant: t.participant,
          sequence: t.sequence,
          replicate: t.replicate,
          task: t.task,
          engine: t.engine,
          source: t.source,
          reportFilename: t.reportFilename,
          status: "completed",
          completedAt: t.completedAt,
          durationSec: t.durationSeconds,
          score,
          bugsElicited,
          taskBugCount,
        });
      }
    }
  }

  return completed;
} // fn: loadCompletedParticipants

/**
 * Persists the current matrix schedule status to benchmark_state.json.
 *
 * @param schedule full list of benchmark runs
 * @param completedMap map of participant IDs that have finished
 */
export function saveBenchmarkState(
  schedule: BenchmarkRunSpec[],
  completedMap: Map<string, BenchmarkScheduleItemState>
): void {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const stateList: BenchmarkScheduleItemState[] = schedule.map((s) => {
    const done = completedMap.get(s.participant);
    if (done && done.status === "completed") {
      return done;
    }
    return {
      participant: s.participant,
      sequence: s.sequence,
      replicate: s.replicate,
      task: s.task,
      engine: s.engine,
      source: s.source,
      reportFilename: s.reportFilename,
      status: "pending",
    };
  });
  fs.writeFileSync(STATE_JSON_PATH, JSON.stringify(stateList, null, 2), "utf8");
} // fn: saveBenchmarkState

// ============================================================================
// Post-Task Survey & SUS Evaluation
// ============================================================================

export interface ParticipantSurvey {
  realistic: number; // 1-5 Likert
  sus1: number; // 1-5 Likert
  sus2: number;
  sus3: number;
  sus4: number;
  sus5: number;
  sus6: number;
  sus7: number;
  sus8: number;
  sus9: number;
  sus10: number;
  susScore: number; // 0 - 100
  toolHelpfulFeedback: string;
  toolUsabilityFeedback: string;
  workflowFitFeedback: string;
  toolImprovementFeedback: string;
  studyImprovementFeedback: string;
}

export function computeSusScore(responses: {
  sus1: number;
  sus2: number;
  sus3: number;
  sus4: number;
  sus5: number;
  sus6: number;
  sus7: number;
  sus8: number;
  sus9: number;
  sus10: number;
}): number {
  // SUS Calculation:
  // Odd items (1, 3, 5, 7, 9): score - 1
  // Even items (2, 4, 6, 8, 10): 5 - score
  // Sum * 2.5
  const oddSum =
    responses.sus1 -
    1 +
    (responses.sus3 - 1) +
    (responses.sus5 - 1) +
    (responses.sus7 - 1) +
    (responses.sus9 - 1);
  const evenSum =
    5 -
    responses.sus2 +
    (5 - responses.sus4) +
    (5 - responses.sus6) +
    (5 - responses.sus8) +
    (5 - responses.sus10);
  const total = (oddSum + evenSum) * 2.5;
  return Math.max(0, Math.min(100, Math.round(total * 10) / 10));
} // fn: computeSusScore

let fileWriteChain: Promise<void> = Promise.resolve();

function writeSurveyResponsesCsv(
  run: BenchmarkRunSpec,
  survey: ParticipantSurvey
): void {
  const headerCols = [
    "Participant",
    "Task",
    "Tool",
    "InvariantSource",
    "Replicate",
    "Sequence",
    "Date",
    "Realistic",
    "SUS_Score",
    "SUS1_FrequentUse",
    "SUS2_Complexity",
    "SUS3_EaseOfUse",
    "SUS4_TechnicalSupport",
    "SUS5_Integration",
    "SUS6_Inconsistency",
    "SUS7_LearnQuickly",
    "SUS8_Cumbersome",
    "SUS9_Confidence",
    "SUS10_LearnedALot",
    "ToolHelpfulFeedback",
    "ToolUsabilityFeedback",
    "WorkflowFitFeedback",
    "ToolImprovementFeedback",
    "StudyImprovementFeedback",
  ];

  const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;

  const rowCols = [
    run.participant,
    run.task,
    run.engine,
    run.source,
    String(run.replicate),
    String(run.sequence),
    new Date().toISOString().split("T")[0],
    String(survey.realistic),
    survey.susScore.toFixed(1),
    String(survey.sus1),
    String(survey.sus2),
    String(survey.sus3),
    String(survey.sus4),
    String(survey.sus5),
    String(survey.sus6),
    String(survey.sus7),
    String(survey.sus8),
    String(survey.sus9),
    String(survey.sus10),
    escapeCsv(survey.toolHelpfulFeedback),
    escapeCsv(survey.toolUsabilityFeedback),
    escapeCsv(survey.workflowFitFeedback),
    escapeCsv(survey.toolImprovementFeedback),
    escapeCsv(survey.studyImprovementFeedback),
  ];

  fileWriteChain = fileWriteChain.then(async () => {
    if (!fs.existsSync(REPORTS_DIR)) {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }

    const fileExists = fs.existsSync(SURVEY_RESPONSES_CSV_PATH);
    if (!fileExists) {
      fs.writeFileSync(
        SURVEY_RESPONSES_CSV_PATH,
        headerCols.join(",") + "\n",
        "utf8"
      );
    }

    fs.appendFileSync(
      SURVEY_RESPONSES_CSV_PATH,
      rowCols.join(",") + "\n",
      "utf8"
    );
    log(
      `[SURVEY] Saved post-task survey responses to survey_responses.csv for ${run.participant}`
    );
  });
} // fn: writeSurveyResponsesCsv

// ============================================================================
// Bug Scoring & data.csv Exporter
// ============================================================================

interface BugEvaluationResult {
  bug: GroundTruthBug;
  elicited: number; // 1 or 0
  reported: number; // 1 or 0
  generator: string;
}

function evaluateBugsForParticipant(
  task: BenchmarkTaskName,
  reportText: string,
  fuzzRuns: Array<{
    functionName: string;
    failedTests: number;
    exceptions: number;
    generatorName?: string;
    details?: string;
  }>
): BugEvaluationResult[] {
  const taskBugs = GROUND_TRUTH_BUGS[task] || [];
  const results: BugEvaluationResult[] = [];

  for (const bug of taskBugs) {
    let elicited = 0;
    let generator = "None";

    // Check if recorded fuzz failures match bug patterns
    for (const run of fuzzRuns) {
      if (run.failedTests > 0 || run.exceptions > 0) {
        const textToCheck = `${run.functionName} ${run.details || ""}`;
        const isMatch = bug.matchPatterns.some((pat) => pat.test(textToCheck));
        if (isMatch) {
          elicited = 1;
          generator = run.generatorName || "Unknown";
          break;
        }
      }
    }

    // Fallback check if report contains reproducer or error matching patterns
    if (elicited === 0 && reportText) {
      const isMatch = bug.matchPatterns.some((pat) => pat.test(reportText));
      if (isMatch) {
        elicited = 1;
        generator = "ReportedInSummary";
      }
    }

    // Check if bug was explicitly reported in markdown report
    let reported = 0;
    if (reportText) {
      reported = bug.matchPatterns.some((pat) => pat.test(reportText)) ? 1 : 0;
    }

    results.push({
      bug,
      elicited,
      reported,
      generator,
    });
  }

  return results;
}

function writeScoringSheet(
  run: BenchmarkRunSpec,
  evalResults: BugEvaluationResult[],
  normalizedScore: string,
  durationSec: number,
  splits: ParticipantPhaseSplits,
  survey?: ParticipantSurvey
): void {
  if (!fs.existsSync(SCORING_SHEETS_DIR)) {
    fs.mkdirSync(SCORING_SHEETS_DIR, { recursive: true });
  }

  const lines = [
    `# Participant Scoring Sheet: ${run.participant}`,
    "",
    `- **Participant**: \`${run.participant}\``,
    `- **Task (Entrypoint)**: \`${run.task}\``,
    `- **Testing Engine**: \`${run.engine}\``,
    `- **Invariant Source**: \`${run.source}\``,
    `- **PUT Version**: ${TARGET_NAME} \`${TARGET_VERSION}\` (\`${TARGET_COMMIT.slice(0, 8)}\`)`,
    `- **Replicate**: ${run.replicate} (Sequence Order: ${run.sequence})`,
    `- **Date**: ${new Date().toISOString().split("T")[0]}`,
    `- **Duration**: ${Math.floor(durationSec / 60)}m ${durationSec % 60}s (active: ${splits.totalExtract.activeSec + splits.synthesis.activeSec + splits.smoke.activeSec + splits.deep.activeSec + splits.contextualize.activeSec}s, retry: ${splits.totalExtract.retrySec + splits.synthesis.retrySec + splits.smoke.retrySec + splits.deep.retrySec + splits.contextualize.retrySec}s, deep slot wait: ${splits.deep.slotWaitSec}s)`,
    `- **Phase Timing Splits**:`,
    `  - Invariant Extraction: ${splits.totalExtract.activeSec}s active (${splits.totalExtract.retrySec}s retry, ${splits.totalExtract.elapsedSec}s elapsed)`,
    `    - From Docs: ${splits.extractDocs.activeSec}s active (${splits.extractDocs.retrySec}s retry)`,
    `    - From Tests: ${splits.extractTests.activeSec}s active (${splits.extractTests.retrySec}s retry)`,
    `  - Harness Synthesis: ${splits.synthesis.activeSec}s active (${splits.synthesis.retrySec}s retry, ${splits.synthesis.elapsedSec}s elapsed)`,
    `  - Smoke Testing: ${splits.smoke.activeSec}s active (${splits.smoke.retrySec}s retry, ${splits.smoke.elapsedSec}s elapsed)`,
    `  - Deep Fuzzing: ${splits.deep.activeSec}s active (${splits.deep.slotWaitSec}s slot wait, ${splits.deep.retrySec}s retry, ${splits.deep.elapsedSec}s elapsed)`,
    `  - Bug Reporting & Context: ${splits.contextualize.activeSec}s active (${splits.contextualize.retrySec}s retry, ${splits.contextualize.elapsedSec}s elapsed)`,
    `- **Task Bug Count**: ${evalResults.length}`,
    `- **Bugs Elicited**: ${evalResults.filter((r) => r.elicited === 1).length} / ${evalResults.length}`,
    `- **Normalized Score (0.000 - 1.000)**: **${normalizedScore}**`,
  ];

  if (survey) {
    lines.push(
      `- **Realism Rating (1-5)**: ${survey.realistic}`,
      `- **System Usability Scale (SUS Score 0-100)**: **${survey.susScore.toFixed(1)}**`
    );
  }

  lines.push(
    "",
    `## Ground-Truth Defect Scoring Breakdown`,
    "",
    `| Bug ID | Defect Name | Elicited? | Reported? | Eliciting Generator |`,
    `| :--- | :--- | :---: | :---: | :--- |`
  );

  for (const r of evalResults) {
    const elIcon = r.elicited === 1 ? "1" : "0";
    const repIcon = r.reported === 1 ? "0" : "0";
    lines.push(
      `| \`${r.bug.id}\` | ${r.bug.name} | ${elIcon} | ${repIcon} | \`${r.generator}\` |`
    );
  }

  if (survey) {
    lines.push(
      "",
      `## Post-Task Survey & SUS Evaluation`,
      "",
      `| Question / Item | Response |`,
      `| :--- | :--- |`,
      `| Task Realism (1-5) | ${survey.realistic} |`,
      `| SUS 1: I think that I would like to use this system frequently | ${survey.sus1} |`,
      `| SUS 2: I found the system unnecessarily complex | ${survey.sus2} |`,
      `| SUS 3: I thought the system was easy to use | ${survey.sus3} |`,
      `| SUS 4: I think that I would need technical support to use this system | ${survey.sus4} |`,
      `| SUS 5: I found the various functions in this system were well integrated | ${survey.sus5} |`,
      `| SUS 6: I thought there was too much inconsistency in this system | ${survey.sus6} |`,
      `| SUS 7: I would imagine that most people would learn to use this system very quickly | ${survey.sus7} |`,
      `| SUS 8: I found the system very cumbersome to use | ${survey.sus8} |`,
      `| SUS 9: I felt very confident using the system | ${survey.sus9} |`,
      `| SUS 10: I needed to learn a lot of things before I could get going with this system | ${survey.sus10} |`,
      `| **Computed SUS Composite Score (0-100)** | **${survey.susScore.toFixed(1)}** |`,
      "",
      `### Qualitative Feedback`,
      `- **Helpfulness/Effectiveness**: ${survey.toolHelpfulFeedback || "N/A"}`,
      `- **Ease of Use**: ${survey.toolUsabilityFeedback || "N/A"}`,
      `- **Workflow Fit**: ${survey.workflowFitFeedback || "N/A"}`,
      `- **Tool Improvements**: ${survey.toolImprovementFeedback || "N/A"}`,
      `- **Study Improvements**: ${survey.studyImprovementFeedback || "N/A"}`
    );
  }

  lines.push("");
  const sheetPath = path.join(
    SCORING_SHEETS_DIR,
    `scoring_sheet_${run.participant}.md`
  );
  fs.writeFileSync(sheetPath, lines.join("\n"), "utf8");
} // fn: writeScoringSheet

function appendToDataCsv(
  run: BenchmarkRunSpec,
  evalResults: BugEvaluationResult[],
  durationSec: number,
  retryWaitSec: number,
  deepSlotWaitSec: number,
  activeSec: number,
  splits: ParticipantPhaseSplits,
  totalFuzzRuns: number,
  totalTests: number,
  branchCoverage: number,
  survey?: ParticipantSurvey
): void {
  const headerCols = [
    "Participant",
    "Task",
    "Tool",
    "InvariantSource",
    "Replicate",
    "Sequence",
    "Date",
    "ElapsedSec",
    "ApiRetryWaitSec",
    "DeepSlotWaitSec",
    "ActiveExecutionSec",
    "Extract_Docs.ElapsedSec",
    "Extract_Docs.RetrySec",
    "Extract_Docs.ActiveSec",
    "Extract_Tests.ElapsedSec",
    "Extract_Tests.RetrySec",
    "Extract_Tests.ActiveSec",
    "Total_Extract.ElapsedSec",
    "Total_Extract.RetrySec",
    "Total_Extract.ActiveSec",
    "Synthesis.ElapsedSec",
    "Synthesis.RetrySec",
    "Synthesis.ActiveSec",
    "Smoke.ElapsedSec",
    "Smoke.RetrySec",
    "Smoke.ActiveSec",
    "Deep.ElapsedSec",
    "Deep.RetrySec",
    "Deep.SlotWaitSec",
    "Deep.ActiveSec",
    "Contextualize.ElapsedSec",
    "Contextualize.RetrySec",
    "Contextualize.ActiveSec",
    "TotalFuzzRuns",
    "TotalTestsExecuted",
    "BranchCoveragePct",
    "TaskBugCount",
    "BugsElicited",
    "NormalizedScore",
    "Accuracy",
    "Realistic",
    "SUS_Score",
    "SUS1",
    "SUS2",
    "SUS3",
    "SUS4",
    "SUS5",
    "SUS6",
    "SUS7",
    "SUS8",
    "SUS9",
    "SUS10",
    "ElicitingGenerators",
    "Status",
    ...ALL_GROUND_TRUTH_BUG_IDS,
  ];

  const taskBugCount = evalResults.length;
  const bugsElicited = evalResults.filter((r) => r.elicited === 1).length;
  const score =
    taskBugCount > 0 ? (bugsElicited / taskBugCount).toFixed(3) : "0.000";

  const bugsReported = evalResults.filter((r) => r.reported === 1).length;
  const accuracy =
    taskBugCount > 0 ? (bugsReported / taskBugCount).toFixed(3) : "0.000";

  const generators = evalResults
    .filter((r) => r.elicited === 1)
    .map((r) => `${r.bug.id}:${r.generator}`)
    .join(";");

  // Map each ground truth bug column: 1, 0, or #N/A (if not in task)
  const taskBugMap = new Map(evalResults.map((r) => [r.bug.id, r.elicited]));
  const bugCols = ALL_GROUND_TRUTH_BUG_IDS.map((bid) => {
    if (taskBugMap.has(bid)) {
      return String(taskBugMap.get(bid));
    }
    return "#N/A";
  });

  const rowCols = [
    run.participant,
    run.task,
    run.engine,
    run.source,
    String(run.replicate),
    String(run.sequence),
    new Date().toISOString().split("T")[0],
    String(durationSec),
    String(retryWaitSec),
    String(deepSlotWaitSec),
    String(activeSec),
    String(splits.extractDocs.elapsedSec),
    String(splits.extractDocs.retrySec),
    String(splits.extractDocs.activeSec),
    String(splits.extractTests.elapsedSec),
    String(splits.extractTests.retrySec),
    String(splits.extractTests.activeSec),
    String(splits.totalExtract.elapsedSec),
    String(splits.totalExtract.retrySec),
    String(splits.totalExtract.activeSec),
    String(splits.synthesis.elapsedSec),
    String(splits.synthesis.retrySec),
    String(splits.synthesis.activeSec),
    String(splits.smoke.elapsedSec),
    String(splits.smoke.retrySec),
    String(splits.smoke.activeSec),
    String(splits.deep.elapsedSec),
    String(splits.deep.retrySec),
    String(splits.deep.slotWaitSec),
    String(splits.deep.activeSec),
    String(splits.contextualize.elapsedSec),
    String(splits.contextualize.retrySec),
    String(splits.contextualize.activeSec),
    String(totalFuzzRuns),
    String(totalTests),
    branchCoverage.toFixed(1),
    String(taskBugCount),
    String(bugsElicited),
    score,
    accuracy,
    survey ? String(survey.realistic) : "",
    survey ? survey.susScore.toFixed(1) : "",
    survey ? String(survey.sus1) : "",
    survey ? String(survey.sus2) : "",
    survey ? String(survey.sus3) : "",
    survey ? String(survey.sus4) : "",
    survey ? String(survey.sus5) : "",
    survey ? String(survey.sus6) : "",
    survey ? String(survey.sus7) : "",
    survey ? String(survey.sus8) : "",
    survey ? String(survey.sus9) : "",
    survey ? String(survey.sus10) : "",
    `"${generators || "None"}"`,
    "COMPLETED",
    ...bugCols,
  ];

  fileWriteChain = fileWriteChain.then(async () => {
    if (!fs.existsSync(REPORTS_DIR)) {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }

    const fileExists = fs.existsSync(DATA_CSV_PATH);
    if (!fileExists) {
      fs.writeFileSync(DATA_CSV_PATH, headerCols.join(",") + "\n", "utf8");
    }

    fs.appendFileSync(DATA_CSV_PATH, rowCols.join(",") + "\n", "utf8");
    log(
      `[DATA] Recorded ${run.participant} row in data.csv (Score: ${score}, SUS: ${survey ? survey.susScore.toFixed(1) : "N/A"})`
    );

    // Write individual participant scoring sheet
    writeScoringSheet(run, evalResults, score, durationSec, splits, survey);
  });
} // fn: appendToDataCsv

// ============================================================================
// Target Repo Hygiene & Settings
// ============================================================================

export function initializeConcurrentWorktrees(
  lanes: number = CONCURRENCY_LANES
): void {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  fs.mkdirSync(SCORING_SHEETS_DIR, { recursive: true });

  execSync(`git -C "${SOURCE_REPO}" worktree prune`, { stdio: "pipe" });

  for (let lane = 1; lane <= lanes; lane++) {
    const wtPath = path.join(WORKTREES_DIR, `w${lane}`);
    if (!fs.existsSync(wtPath)) {
      execSync(
        `git -C "${SOURCE_REPO}" worktree add --force --detach "${wtPath}" ${TARGET_COMMIT}`,
        { stdio: "pipe" }
      );
    }
    const venvLink = path.join(wtPath, ".venv");
    ensureVenvSymlink(path.join(SOURCE_REPO, ".venv"), venvLink);
  }
} // fn: initializeConcurrentWorktrees

export function cleanLane(laneId: number): void {
  const wtPath = path.join(WORKTREES_DIR, `w${laneId}`);
  if (!fs.existsSync(wtPath)) return;
  try {
    execSync("git checkout -- .", { cwd: wtPath, stdio: "ignore" });
    execSync("git clean -fd", { cwd: wtPath, stdio: "ignore" });
    execSync(`git checkout -q ${TARGET_COMMIT}`, {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch (err) {
    log(`[WARN] Lane ${laneId} git cleanup error: ${String(err)}`);
  }

  // Ensure .venv symlink remains intact
  const venvLink = path.join(wtPath, ".venv");
  ensureVenvSymlink(path.join(SOURCE_REPO, ".venv"), venvLink);

  // Clean lane-specific IPC temp files
  const tmpFiles = fs.readdirSync("/tmp");
  for (const f of tmpFiles) {
    if (
      f.startsWith(`nanofuzz_w${laneId}_`) ||
      f.startsWith(`nanofuzz_pbt_w${laneId}_`)
    ) {
      if (fs.existsSync(path.join("/tmp", f))) {
        fs.unlinkSync(path.join("/tmp", f));
      }
    }
  }

  // De-reference cached raw fuzz results to allow V8 garbage collection
  clearCachedRawResultsForPath(wtPath);
} // fn: cleanLane

export function cleanTargetRepo(): void {
  for (let lane = 1; lane <= CONCURRENCY_LANES; lane++) {
    cleanLane(lane);
  }
} // fn: cleanTargetRepo

export function configureRunSettings(): void {
  // Pre-approve workspace edits so no modal dialogs appear
  Config.override("chat.tools.edits.autoApprove", {
    "**/*": true,
  });
}

// ============================================================================
// Autonomous Agent Runner Loop
// ============================================================================

export async function runSingleBenchmarkSession(
  run: BenchmarkRunSpec,
  totalRuns: number,
  laneId: number = 1,
  token?: vscode.CancellationToken
): Promise<{ success: boolean; durationSec: number; error?: string }> {
  const t0 = Date.now();
  const prefix = `[${run.participant} (L${laneId})]`;
  const laneRepoPath = path.join(WORKTREES_DIR, `w${laneId}`);
  const sessionId = `bench-w${laneId}-${run.participant}-${run.task}`;

  log(
    `\n================================================================================`
  );
  log(
    `[START] ${prefix}: Task ${run.task} (Engine: ${run.engine} | Source: ${run.source} | Rep ${run.replicate})`
  );
  log(`Lane Target Repo: ${laneRepoPath}`);
  log(`Destination report: ${run.reportFilename}`);
  log(
    `================================================================================`
  );

  // Clean lane worktree, reset session state, and apply settings
  cleanLane(laneId);
  sessionManager.clear(sessionId);
  sessionManager.getOrCreateSession(
    sessionId,
    run.engine,
    run.source,
    1,
    "init",
    run.targetScope,
    laneRepoPath
  );
  configureRunSettings();

  dashboardTracker.sessionStarted(laneId, {
    participant: run.participant,
    lane: laneId,
    task: run.task,
    engine: run.engine,
    source: run.source,
    replicate: run.replicate,
    stage: "Phase 1/6 (init)",
    turn: 0,
    toolErrors: 0,
    retryAttempts: 0,
    startTime: t0,
  });

  const tag = (phaseLabel?: string): string => {
    const stepLabel = PHASE_STEPS[currentPhase] || "?/6";
    const p = phaseLabel ?? stepLabel;
    return `${prefix} [Phase ${p}]`;
  };

  // Select Chat Model: Strictly require Gemini 3.8 Flash under "Google (paid)" / vendor "gemini"
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
    throw new Error(
      "vscode.lm API is not available. Please ensure VS Code with Copilot is active."
    );
  }

  const all = await vscode.lm.selectChatModels();
  let models = all.filter(
    (m) =>
      (m.id === "gemini-3.8-flash" ||
        m.family === "gemini-3.8-flash" ||
        m.name?.includes("3.8") ||
        m.id.includes("gemini-3.8-flash")) &&
      (m.vendor.toLowerCase() === "gemini" ||
        m.vendor.toLowerCase() === "google" ||
        m.name?.includes("paid") ||
        (isKeyedObject(m) &&
          typeof m.vendorDisplayName === "string" &&
          m.vendorDisplayName.includes("paid")))
  );

  if (!models || models.length === 0) {
    models = all.filter(
      (m) =>
        m.id === "gemini-3.8-flash" ||
        m.family === "gemini-3.8-flash" ||
        m.id.includes("gemini-3.8-flash")
    );
  }

  if (!models || models.length === 0) {
    throw new Error(
      "CRITICAL: Required model 'Gemini 3.8 Flash' under Google (paid) / gemini not found. Available models: " +
        all.map((m) => `${m.vendor}:${m.id || m.name}`).join(", ")
    );
  }

  const model = models[0];
  log(
    `${prefix} Using Chat Model: ${model.vendor} / ${model.name || model.family || model.id}`
  );

  // Filter tools to only include relevant bug-hunting tools (eliminates 85% of tool overhead)
  const allowedTools = new Set([
    "nanofuzz_listTargets",
    "nanofuzz_fuzzFunction",
    "nanofuzz_findBugs",
    "nanofuzz_shrinkInputs",
    "manage_todo_list",
    "read_file",
    "copilot_readFile",
    "create_file",
    "copilot_createFile",
    "replace_string_in_file",
    "copilot_replaceString",
    "list_dir",
    "copilot_listDirectory",
    "file_search",
    "copilot_findFiles",
    "grep_search",
    "copilot_findTextInFiles",
  ]);

  const availableTools: vscode.LanguageModelChatTool[] = (vscode.lm.tools || [])
    .filter((t) => allowedTools.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

  // Clean, focused task prompt
  const initialPrompt = [
    `Target Repository: ${laneRepoPath}`,
    `Target Task Entrypoint: ${run.task}`,
    `Testing Engine: ${run.engine}`,
    `Invariant Source: ${run.source}`,
    `Session ID: ${sessionId}`,
    "",
    `Use NaNofuzz to find bugs in the entrypoint '${run.task}' in ${TARGET_NAME} located at ${laneRepoPath}.`,
    `(when calling nanofuzz_findBugs, always include statePayload: { sessionId: "${sessionId}" }; after the find_bugs workflow completes, save your bug report to '${run.reportPath}')`,
  ].join("\n");

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(initialPrompt),
  ];

  let turn = 0;
  const MAX_TURNS = 120;
  let sessionCompleted = false;
  let totalRetryWaitMs = 0;
  let totalRetryAttempts = 0;
  let totalDeepSlotWaitMs = 0;

  // Track phase progress and timing splits
  const PHASE_STEPS: Record<string, string> = {
    init: "1/6",
    invariants_from_docs: "1/6",
    invariants_from_tests: "2/6",
    invariants_extracted: "3/6",
    fuzz_smoke: "4/6",
    fuzz_deep: "5/6",
    fuzz_entrypoint: "4/6",
    contextualize_bugs: "6/6",
    complete: "6/6",
  };
  let currentPhase = "init";
  let phaseStartTime = t0;
  let phaseRetryWaitMs = 0;
  let phaseSlotWaitMs = 0;

  const phaseTimings: Record<
    string,
    { elapsedMs: number; retryWaitMs: number; slotWaitMs: number }
  > = {};

  const commitPhaseTiming = (phaseName: string, endTime: number): void => {
    if (!phaseTimings[phaseName]) {
      phaseTimings[phaseName] = { elapsedMs: 0, retryWaitMs: 0, slotWaitMs: 0 };
    }
    const elapsed = Math.max(0, endTime - phaseStartTime);
    phaseTimings[phaseName].elapsedMs += elapsed;
    phaseTimings[phaseName].retryWaitMs += phaseRetryWaitMs;
    phaseTimings[phaseName].slotWaitMs += phaseSlotWaitMs;
    phaseStartTime = endTime;
    phaseRetryWaitMs = 0;
    phaseSlotWaitMs = 0;
  };

  const recordedToolEvents: Array<{
    tool: string;
    args: unknown;
    timestamp: string;
    result?: string;
    shrinkSteps?: number;
  }> = [];

  while (!sessionCompleted && turn < MAX_TURNS) {
    if (token?.isCancellationRequested) {
      log(`${prefix} Cancellation requested.`);
      cleanTargetRepo();
      return {
        success: false,
        durationSec: Math.floor((Date.now() - t0) / 1000),
        error: "Cancelled",
      };
    }

    turn++;
    dashboardTracker.updateTurn(laneId, turn);
    const stepLabel = PHASE_STEPS[currentPhase] || "?/6";
    log(
      `  ${tag(`${stepLabel} (${currentPhase})`)} Turn ${turn} sending to LLM...`
    );

    // Stream and turn execution with automatic resilient retry on 503 / 429 / socket drops / stream errors
    let assistantText = "";
    let toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let allParts: (
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolCallPart
      | vscode.LanguageModelDataPart
    )[] = [];
    let streamSucceeded = false;
    let attempt = 0;
    const maxRetries = 20;

    while (!streamSucceeded) {
      if (token?.isCancellationRequested) {
        log(`${tag()} Cancellation requested.`);
        cleanTargetRepo();
        return {
          success: false,
          durationSec: Math.floor((Date.now() - t0) / 1000),
          error: "Cancelled",
        };
      }

      attempt++;
      assistantText = "";
      toolCalls = [];
      allParts = [];

      try {
        const response = await model.sendRequest(
          messages,
          { tools: availableTools },
          token
        );

        for await (const part of response.stream) {
          allParts.push(cast<AssistantStreamPart>(part));
          if (part instanceof vscode.LanguageModelTextPart) {
            assistantText += part.value;
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(part);
          }
        }

        // Verify we got a non-empty turn (not a silent empty drop)
        if (toolCalls.length === 0 && !assistantText.trim()) {
          throw new Error(
            "Empty response received from language model stream."
          );
        }

        streamSucceeded = true;
      } catch (err: unknown) {
        if (token?.isCancellationRequested) {
          log(`  ${tag()} [CANCEL] Request cancelled by user.`);
          cleanTargetRepo();
          return {
            success: false,
            durationSec: Math.floor((Date.now() - t0) / 1000),
            error: "Cancelled",
          };
        }

        const errStr = String(err);
        const isTransient =
          errStr.includes("503") ||
          errStr.includes("429") ||
          errStr.includes("UNAVAILABLE") ||
          errStr.includes("RESOURCE_EXHAUSTED") ||
          errStr.includes("high demand") ||
          errStr.includes("Empty response") ||
          errStr.includes("ECONNRESET") ||
          errStr.includes("ETIMEDOUT") ||
          errStr.includes("terminated") ||
          errStr.includes("fetch failed") ||
          errStr.includes("network") ||
          errStr.includes("socket hang up");

        if (!isTransient || attempt >= maxRetries) {
          log(
            `  ${tag()} [FAILED] LLM request failed (attempt ${attempt}/${maxRetries}): ${errStr}`
          );
          cleanTargetRepo();
          return {
            success: false,
            durationSec: Math.floor((Date.now() - t0) / 1000),
            error: errStr,
          };
        }

        totalRetryAttempts++;
        dashboardTracker.updateRetries(laneId, totalRetryAttempts);
        // Exponential backoff with jitter for 503 / 429 / busy spikes
        const baseDelay = Math.min(60000, 3000 * Math.pow(1.6, attempt - 1));
        const delayMs = baseDelay + Math.floor(Math.random() * 3000);
        totalRetryWaitMs += delayMs;
        phaseRetryWaitMs += delayMs;
        log(
          `  ${tag()} [RETRY] Model busy (attempt ${attempt}/${maxRetries}): ${errStr}. Waiting ${Math.round(delayMs / 1000)}s before retry...`
        );
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }

    // Filter out internal usage data parts before passing to Assistant history
    const assistantParts = allParts.filter((p) => {
      if (p instanceof vscode.LanguageModelDataPart) {
        const mime = p.mimeType.toLowerCase();
        if (
          mime === "usage" ||
          mime.includes("usage") ||
          mime.includes("marker") ||
          mime.includes("cache")
        ) {
          return false;
        }
      }
      return true;
    });

    // Append Assistant response to history preserving all raw stream parts (including LanguageModelThinkingPart)
    if (assistantParts.length > 0) {
      messages.push(
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.Assistant,
          assistantParts
        )
      );
    } else if (assistantText) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantText));
    }

    // If no tools were called, check if report already exists or encourage continuation
    if (toolCalls.length === 0) {
      log(
        `  ${tag()} Model returned text without tool calls: ${assistantText.slice(0, 100)}...`
      );
      if (
        fs.existsSync(run.reportPath) &&
        fs.statSync(run.reportPath).size > 500
      ) {
        log(`  ${tag()} Report detected on disk. Marking session complete.`);
        break;
      }
      messages.push(
        vscode.LanguageModelChatMessage.User(
          "Please continue executing the nanofuzz_findBugs workflow until complete."
        )
      );
      continue;
    }

    // Execute each tool call
    const toolResults: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      const toolInput: Record<string, unknown> = isKeyedObject(call.input)
        ? call.input
        : {};
      const toolName = call.name;

      const eventRecord: {
        tool: string;
        args: unknown;
        timestamp: string;
        result?: string;
        shrinkSteps?: number;
      } = {
        tool: toolName,
        args: toolInput,
        timestamp: new Date().toISOString(),
      };
      recordedToolEvents.push(eventRecord);

      // Log structured turn feedback to console and enforce lane isolation
      if (toolName === "nanofuzz_findBugs") {
        toolInput.targetPath = laneRepoPath;
        if (!isKeyedObject(toolInput.statePayload)) {
          toolInput.statePayload = {};
        }
        const sp = cast<Record<string, unknown>>(toolInput.statePayload);
        // UNCONDITIONALLY bind sessionId to the runner session so findBugs and fuzzFunction never desync
        sp.sessionId = sessionId;
        sp.targetRepoPath = laneRepoPath;
        if (!sp.tool) sp.tool = run.engine;
        if (!sp.invariantSource) sp.invariantSource = run.source;
        if (!sp.targetScope) sp.targetScope = run.targetScope;

        const p =
          typeof toolInput.phase === "string" ? toolInput.phase : "init";
        const stage =
          typeof sp.stage === "string" ? ` [Stage: ${sp.stage}]` : "";
        const fn =
          typeof sp.functionName === "string"
            ? ` (fn: ${sp.functionName})`
            : "";
        const step = PHASE_STEPS[p] || "?/6";
        log(`  ${tag(`${step} (${p})`)} State: ${p}${stage}${fn}`);
      } else if (toolName === "nanofuzz_fuzzFunction") {
        toolInput.sessionId = sessionId;
        if (
          typeof toolInput.filePath === "string" &&
          !path.isAbsolute(toolInput.filePath)
        ) {
          toolInput.filePath = path.resolve(laneRepoPath, toolInput.filePath);
        }
        const fn = toolInput.functionName || "";
        const maxTests =
          toolInput.maxTests === 0
            ? "continuous (maxTests=0)"
            : `${toolInput.maxTests} tests`;
        const to = Math.round(Number(toolInput.timeoutMs || 0) / 1000);
        log(`  ${tag()} Fuzzing: ${fn} (${maxTests}, timeout=${to}s)`);
      } else if (toolName === "nanofuzz_shrinkInputs") {
        toolInput.sessionId = sessionId;
        if (
          typeof toolInput.filePath === "string" &&
          !path.isAbsolute(toolInput.filePath)
        ) {
          toolInput.filePath = path.resolve(laneRepoPath, toolInput.filePath);
        }
        const fn = toolInput.functionName || "";
        log(`  ${tag()} Shrinking inputs for: ${fn}`);
      } else if (toolName === "nanofuzz_listTargets") {
        if (
          typeof toolInput.filePath === "string" &&
          !path.isAbsolute(toolInput.filePath)
        ) {
          toolInput.filePath = path.resolve(laneRepoPath, toolInput.filePath);
        }
        const rel = String(toolInput.filePath || "")
          .split("/")
          .slice(-2)
          .join("/");
        log(`  ${tag()} Scanning: ${rel}`);
      } else if (
        toolName === "read_file" ||
        toolName === "copilot_readFile" ||
        toolName === "create_file" ||
        toolName === "copilot_createFile" ||
        toolName === "replace_string_in_file" ||
        toolName === "copilot_replaceString"
      ) {
        if (
          typeof toolInput.filePath === "string" &&
          !path.isAbsolute(toolInput.filePath)
        ) {
          toolInput.filePath = path.resolve(laneRepoPath, toolInput.filePath);
        }
        log(`  ${tag()} Tool: ${toolName}`);
      } else if (
        toolName === "list_dir" ||
        toolName === "copilot_listDirectory"
      ) {
        if (
          typeof toolInput.dirPath === "string" &&
          !path.isAbsolute(toolInput.dirPath)
        ) {
          toolInput.dirPath = path.resolve(laneRepoPath, toolInput.dirPath);
        }
        log(`  ${tag()} Tool: ${toolName}`);
      } else {
        log(`  ${tag()} Tool: ${toolName}`);
      }

      // Invoke tool via vscode.lm.invokeTool
      let resultText = "";
      let toolSucceeded = false;
      const fuzzRunsCountBefore =
        toolName === "nanofuzz_fuzzFunction"
          ? (sessionManager.getSession(sessionId, laneRepoPath)?.fuzzRuns
              .length ?? 0)
          : 0;
      try {
        const toolRes = await vscode.lm.invokeTool(
          toolName,
          { input: toolInput, toolInvocationToken: undefined },
          token
        );
        for (const part of toolRes.content) {
          if (part instanceof vscode.LanguageModelTextPart) {
            resultText += part.value;
          } else if (typeof part === "string") {
            resultText += part;
          } else {
            resultText += JSON.stringify(part);
          }
        }
        toolSucceeded = true;
      } catch (err: unknown) {
        dashboardTracker.incrementToolError(laneId);
        resultText = `Tool invocation error: ${String(err)}`;
        const step = PHASE_STEPS[currentPhase] || "?/6";
        log(`  ${tag(step)} [WARN] Tool ${toolName} threw: ${String(err)}`);
      }

      // Record tool execution outcome and capture shrink steps
      eventRecord.result =
        resultText.length > 2000
          ? resultText.slice(0, 2000) + "... [truncated]"
          : resultText;

      const shrinkMatch = resultText.match(
        /(?:simplified through|Shrink Steps:?)\s*(\d+)/i
      );
      if (shrinkMatch) {
        eventRecord.shrinkSteps = parseInt(shrinkMatch[1], 10);
      } else if (toolName === "nanofuzz_shrinkInputs") {
        const stepMatch = resultText.match(/(\d+)\s+step/i);
        if (stepMatch) {
          eventRecord.shrinkSteps = parseInt(stepMatch[1], 10);
        }
      }

      // ONLY advance phase and commit timing if the tool invocation succeeded without error
      if (toolSucceeded && toolName === "nanofuzz_findBugs") {
        const p =
          typeof toolInput.phase === "string" ? toolInput.phase : "init";
        if (p !== currentPhase) {
          commitPhaseTiming(currentPhase, Date.now());
          currentPhase = p;
          const step = PHASE_STEPS[currentPhase] || "?/6";
          dashboardTracker.updatePhase(laneId, `Phase ${step} (${p})`);
        }
        if (p === "complete") {
          sessionCompleted = true;
        }
      }

      if (toolName === "nanofuzz_fuzzFunction") {
        const activeSession = sessionManager.getSession(
          sessionId,
          laneRepoPath
        );
        if (
          activeSession &&
          activeSession.fuzzRuns.length > fuzzRunsCountBefore
        ) {
          const newRuns = activeSession.fuzzRuns.slice(fuzzRunsCountBefore);
          for (const r of newRuns) {
            if (r.deepSlotWaitMs && r.deepSlotWaitMs > 0) {
              phaseSlotWaitMs += r.deepSlotWaitMs;
              totalDeepSlotWaitMs += r.deepSlotWaitMs;
              const step = PHASE_STEPS[currentPhase] || "?/6";
              log(
                `  ${tag(step)} Deep fuzzing slot wait: ${Math.round(r.deepSlotWaitMs / 1000)}s (discounted from active time)`
              );
            }
          }
        }
      }

      toolResults.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(resultText),
        ])
      );
    }

    // Feed tool results back as User message
    messages.push(vscode.LanguageModelChatMessage.User(toolResults));

    // Check if report written
    if (
      fs.existsSync(run.reportPath) &&
      fs.statSync(run.reportPath).size > 500 &&
      sessionCompleted
    ) {
      break;
    }
  }

  commitPhaseTiming(currentPhase, Date.now());

  const durationSec = Math.floor((Date.now() - t0) / 1000);
  const mm = Math.floor(durationSec / 60);
  const ss = durationSec % 60;

  const retryWaitSec = Math.round(totalRetryWaitMs / 1000);
  const deepSlotWaitSec = Math.round(totalDeepSlotWaitMs / 1000);
  const activeSec = Math.max(0, durationSec - retryWaitSec - deepSlotWaitSec);

  const getPhaseSec = (phaseName: string): PhaseTimeSplit => {
    const t = phaseTimings[phaseName] || {
      elapsedMs: 0,
      retryWaitMs: 0,
      slotWaitMs: 0,
    };
    const elapsedSec = Math.round(t.elapsedMs / 1000);
    const retrySec = Math.round(t.retryWaitMs / 1000);
    const slotWaitSec = Math.round((t.slotWaitMs ?? 0) / 1000);
    const activeSec = Math.max(0, elapsedSec - retrySec - slotWaitSec);
    return { elapsedSec, retrySec, slotWaitSec, activeSec };
  };

  let extractDocs: PhaseTimeSplit;
  let extractTests: PhaseTimeSplit;

  if (run.source === "docs") {
    const docs1 = getPhaseSec("init");
    const docs2 = getPhaseSec("invariants_from_docs");
    extractDocs = {
      elapsedSec: docs1.elapsedSec + docs2.elapsedSec,
      retrySec: docs1.retrySec + docs2.retrySec,
      slotWaitSec: docs1.slotWaitSec + docs2.slotWaitSec,
      activeSec: docs1.activeSec + docs2.activeSec,
    };
    extractTests = { elapsedSec: 0, retrySec: 0, slotWaitSec: 0, activeSec: 0 };
  } else if (run.source === "tests") {
    extractDocs = { elapsedSec: 0, retrySec: 0, slotWaitSec: 0, activeSec: 0 };
    const t1 = getPhaseSec("init");
    const t2 = getPhaseSec("invariants_from_tests");
    extractTests = {
      elapsedSec: t1.elapsedSec + t2.elapsedSec,
      retrySec: t1.retrySec + t2.retrySec,
      slotWaitSec: t1.slotWaitSec + t2.slotWaitSec,
      activeSec: t1.activeSec + t2.activeSec,
    };
  } else {
    // "all": init (or invariants_from_docs) is docs, invariants_from_tests is tests
    const docs1 = getPhaseSec("init");
    const docs2 = getPhaseSec("invariants_from_docs");
    extractDocs = {
      elapsedSec: docs1.elapsedSec + docs2.elapsedSec,
      retrySec: docs1.retrySec + docs2.retrySec,
      slotWaitSec: docs1.slotWaitSec + docs2.slotWaitSec,
      activeSec: docs1.activeSec + docs2.activeSec,
    };
    extractTests = getPhaseSec("invariants_from_tests");
  }

  const totalExtract: PhaseTimeSplit = {
    elapsedSec: extractDocs.elapsedSec + extractTests.elapsedSec,
    retrySec: extractDocs.retrySec + extractTests.retrySec,
    slotWaitSec: extractDocs.slotWaitSec + extractTests.slotWaitSec,
    activeSec: extractDocs.activeSec + extractTests.activeSec,
  };

  const synthesis = getPhaseSec("invariants_extracted");
  const smoke = getPhaseSec("fuzz_smoke");

  const deep1 = getPhaseSec("fuzz_deep");
  const deep2 = getPhaseSec("fuzz_entrypoint");
  const deep: PhaseTimeSplit = {
    elapsedSec: deep1.elapsedSec + deep2.elapsedSec,
    retrySec: deep1.retrySec + deep2.retrySec,
    slotWaitSec: deep1.slotWaitSec + deep2.slotWaitSec,
    activeSec: deep1.activeSec + deep2.activeSec,
  };

  const contextualize = getPhaseSec("contextualize_bugs");

  const splits: ParticipantPhaseSplits = {
    extractDocs,
    extractTests,
    totalExtract,
    synthesis,
    smoke,
    deep,
    contextualize,
  };

  // Evaluate ground-truth bugs elicited & reported for this participant
  const reportContent = fs.existsSync(run.reportPath)
    ? fs.readFileSync(run.reportPath, "utf8")
    : "";

  const activeSession = sessionManager.getSession(sessionId, laneRepoPath);
  const fuzzRuns = activeSession?.fuzzRuns || [];
  const evalResults = evaluateBugsForParticipant(
    run.task,
    reportContent,
    fuzzRuns
  );

  const totalTests = fuzzRuns.reduce((sum, r) => sum + r.totalTests, 0);
  const branchCoverage =
    fuzzRuns.length > 0
      ? Math.max(...fuzzRuns.map((r) => r.branchCoveragePct ?? 0))
      : 0;

  // Conduct Post-Task Survey & SUS Evaluation with the Agent
  let survey: ParticipantSurvey | undefined;
  try {
    const surveyPrompt = [
      "The bug hunting session and fuzz testing run are now complete.",
      "",
      "Please complete this standardized post-task evaluation survey regarding your experience performing this testing task with this tool.",
      "Respond strictly with a JSON object in a ```json codeblock containing the following fields:",
      "",
      "- `realistic`: Integer rating from 1 (Strongly Disagree) to 5 (Strongly Agree) for statement: 'I thought the testing tasks in this study resemble tasks I might encounter outside the study.'",
      "- `sus1`: Integer 1-5 ('I think that I would like to use this system frequently.')",
      "- `sus2`: Integer 1-5 ('I found the system unnecessarily complex.')",
      "- `sus3`: Integer 1-5 ('I thought the system was easy to use.')",
      "- `sus4`: Integer 1-5 ('I think that I would need technical support to use this system.')",
      "- `sus5`: Integer 1-5 ('I found the various functions in this system were well integrated.')",
      "- `sus6`: Integer 1-5 ('I thought there was too much inconsistency in this system.')",
      "- `sus7`: Integer 1-5 ('I would imagine that most people would learn to use this system very quickly.')",
      "- `sus8`: Integer 1-5 ('I found the system very cumbersome to use.')",
      "- `sus9`: Integer 1-5 ('I felt very confident using the system.')",
      "- `sus10`: Integer 1-5 ('I needed to learn a lot of things before I could get going with this system.')",
      "- `toolHelpfulFeedback`: String describing whether and why the tool was helpful or effective in testing.",
      "- `toolUsabilityFeedback`: String describing whether and why the tool was easy or hard to use.",
      "- `workflowFitFeedback`: String describing how well the tool fit into your test and debug workflow.",
      "- `toolImprovementFeedback`: String with feedback/suggestions to improve the testing tool.",
      "- `studyImprovementFeedback`: String with feedback/suggestions to improve this or future studies.",
    ].join("\n");

    const surveyMessages = [
      ...messages,
      vscode.LanguageModelChatMessage.User(surveyPrompt),
    ];

    const surveyResponse = await model.sendRequest(
      surveyMessages,
      { tools: [] },
      token
    );

    let surveyRawText = "";
    for await (const chunk of surveyResponse.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        surveyRawText += chunk.value;
      }
    }

    const jsonMatch =
      surveyRawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
      surveyRawText.match(/(\{[\s\S]*\})/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      const clampLikert = (v: unknown): number => {
        const n = Number(v);
        if (isNaN(n) || n < 1) return 3;
        if (n > 5) return 5;
        return Math.round(n);
      };

      const susResponses = {
        sus1: clampLikert(parsed.sus1),
        sus2: clampLikert(parsed.sus2),
        sus3: clampLikert(parsed.sus3),
        sus4: clampLikert(parsed.sus4),
        sus5: clampLikert(parsed.sus5),
        sus6: clampLikert(parsed.sus6),
        sus7: clampLikert(parsed.sus7),
        sus8: clampLikert(parsed.sus8),
        sus9: clampLikert(parsed.sus9),
        sus10: clampLikert(parsed.sus10),
      };

      const computedSus = computeSusScore(susResponses);

      survey = {
        realistic: clampLikert(parsed.realistic),
        ...susResponses,
        susScore: computedSus,
        toolHelpfulFeedback: String(parsed.toolHelpfulFeedback || "").trim(),
        toolUsabilityFeedback: String(
          parsed.toolUsabilityFeedback || ""
        ).trim(),
        workflowFitFeedback: String(parsed.workflowFitFeedback || "").trim(),
        toolImprovementFeedback: String(
          parsed.toolImprovementFeedback || ""
        ).trim(),
        studyImprovementFeedback: String(
          parsed.studyImprovementFeedback || ""
        ).trim(),
      };

      writeSurveyResponsesCsv(run, survey);
    }
  } catch (err: unknown) {
    log(
      `  ${prefix} [WARN] Failed to collect post-task survey: ${String(err)}`
    );
  }

  // Append row to data.csv and generate scoring sheet
  appendToDataCsv(
    run,
    evalResults,
    durationSec,
    retryWaitSec,
    deepSlotWaitSec,
    activeSec,
    splits,
    fuzzRuns.length,
    totalTests,
    branchCoverage,
    survey
  );

  // Save structured telemetry file
  if (!fs.existsSync(TELEMETRY_DIR)) {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  }
  const baseName = run.reportFilename.replace(/\.md$/, "");
  const telemetryJsonPath = path.join(
    TELEMETRY_DIR,
    `${baseName}.telemetry.json`
  );
  const telemetryData = {
    participant: run.participant,
    lane: laneId,
    sequence: run.sequence,
    replicate: run.replicate,
    task: run.task,
    engine: run.engine,
    source: run.source,
    targetScope: run.targetScope,
    targetCommit: TARGET_COMMIT,
    targetVersion: TARGET_VERSION,
    reportFilename: run.reportFilename,
    durationSeconds: durationSec,
    activeExecutionSeconds: activeSec,
    apiRetryWaitSeconds: retryWaitSec,
    deepSlotWaitSeconds: deepSlotWaitSec,
    apiRetryAttempts: totalRetryAttempts,
    phaseSplits: splits,
    completedAt: new Date().toISOString(),
    toolEventCount: recordedToolEvents.length,
    events: recordedToolEvents,
    fuzzRuns: activeSession?.fuzzRuns || [],
    shrinkStats: {
      totalShrinkSteps:
        (activeSession?.fuzzRuns || []).reduce(
          (sum, r) => sum + (r.shrinkSteps ?? 0),
          0
        ) +
        recordedToolEvents.reduce((sum, e) => sum + (e.shrinkSteps ?? 0), 0),
      runsWithShrinking: (activeSession?.fuzzRuns || []).filter(
        (r) => (r.shrinkSteps ?? 0) > 0
      ),
      shrinkEvents: recordedToolEvents.filter(
        (e) =>
          e.tool === "nanofuzz_shrinkInputs" ||
          (e.shrinkSteps !== undefined && e.shrinkSteps > 0)
      ),
    },
    evalResults,
    survey,
  };
  fs.writeFileSync(
    telemetryJsonPath,
    JSON.stringify(telemetryData, null, 2),
    "utf8"
  );
  log(`${prefix} Saved telemetry: ${path.basename(telemetryJsonPath)}`);

  // Clean target lane worktree
  log(`${prefix} Cleaning lane ${laneId} worktree...`);
  cleanLane(laneId);

  const score =
    evalResults.length > 0
      ? (
          evalResults.filter((r) => r.elicited === 1).length /
          evalResults.length
        ).toFixed(3)
      : "0.000";

  dashboardTracker.sessionFinished(laneId, {
    participant: run.participant,
    lane: laneId,
    task: run.task,
    engine: run.engine,
    source: run.source,
    replicate: run.replicate,
    durationSec,
    success: true,
    score,
    bugsElicited: evalResults.filter((r) => r.elicited === 1).length,
    taskBugCount: evalResults.length,
  });

  log(
    `[SUCCESS] ${prefix} Completed in ${mm}m ${ss}s! Score: ${score} (${run.reportFilename})\n`
  );
  return { success: true, durationSec };
}

// ============================================================================
// Master Orchestrator (45 or 135 Runs)
// ============================================================================

export async function runBenchmarkMatrix(
  replicates: 1 | 3 = 1,
  concurrency: number = CONCURRENCY_LANES
): Promise<void> {
  initializeConcurrentWorktrees(concurrency);
  const schedule = generateBenchmarkSchedule(replicates);
  const totalRuns = schedule.length;

  if (activeCts) {
    activeCts.cancel();
    activeCts.dispose();
  }
  activeCts = new vscode.CancellationTokenSource();
  const token = activeCts.token;

  // Checkpoint & Resumption: Load completed runs from benchmark_state.json and telemetry files
  const completedMap = loadCompletedParticipants();
  saveBenchmarkState(schedule, completedMap);

  const initialFinished: FinishedSessionStatus[] = [];
  for (const s of schedule) {
    const done = completedMap.get(s.participant);
    if (done && done.status === "completed") {
      initialFinished.push({
        participant: done.participant,
        lane: 0,
        task: done.task,
        engine: done.engine,
        source: done.source,
        replicate: done.replicate,
        durationSec: done.durationSec ?? 0,
        success: true,
        score: done.score ?? "0.000",
      });
    }
  }

  dashboardTracker.startMatrix(totalRuns, initialFinished);

  getOutput().show(true);
  log(
    "================================================================================"
  );
  log(
    `[BENCHMARK] Starting unattended concurrent matrix: ${totalRuns} tasks (Seed: '${SEED}')`
  );
  if (completedMap.size > 0) {
    log(
      `[RESUME] Discovered ${completedMap.size}/${totalRuns} previously completed tasks. Resuming remaining tasks...`
    );
  }
  log(
    `Parallel Lanes: ${concurrency} | Max Deep Fuzzing Slots: ${MAX_DEEP_FUZZ_SLOTS}`
  );
  log(
    `Base Repo: ${SOURCE_REPO} (${TARGET_VERSION} @ ${TARGET_COMMIT.slice(0, 8)})`
  );
  log(`Worktrees: ${WORKTREES_DIR}/w1 ... w${concurrency}`);
  log(`Results Directory: ${RESULTS_DIR}`);
  log(`Factorial Tasks: ${BENCHMARK_TASKS.join(", ")}`);
  log(`Engines: ${ENGINES.join(", ")} | Sources: ${SOURCES.join(", ")}`);
  log(
    "================================================================================\n"
  );

  const results: Array<{
    participant: string;
    lane: number;
    task: string;
    engine: string;
    source: string;
    replicate: number;
    durationSec: number;
    success: boolean;
  }> = [];

  for (const init of initialFinished) {
    results.push({
      participant: init.participant,
      lane: init.lane,
      task: init.task,
      engine: init.engine,
      source: init.source,
      replicate: init.replicate,
      durationSec: init.durationSec,
      success: true,
    });
  }

  let nextQueueIndex = 0;

  async function laneWorker(laneId: number): Promise<void> {
    while (nextQueueIndex < schedule.length) {
      if (token.isCancellationRequested) break;
      const runIndex = nextQueueIndex++;
      if (runIndex >= schedule.length) break;
      const run = schedule[runIndex];

      // Checkpoint skip: If task is already completed, do not rerun
      if (completedMap.has(run.participant)) {
        log(
          `[SKIP] [Lane ${laneId}] ${run.participant} (Task: ${run.task}, Engine: ${run.engine}, Source: ${run.source}) already completed. Skipping.`
        );
        continue;
      }

      const sessionStart = Date.now();
      try {
        const res = await runSingleBenchmarkSession(
          run,
          totalRuns,
          laneId,
          token
        );
        if (!res.success) {
          dashboardTracker.sessionFinished(laneId, {
            participant: run.participant,
            lane: laneId,
            task: run.task,
            engine: run.engine,
            source: run.source,
            replicate: run.replicate,
            durationSec: res.durationSec,
            success: false,
            error: res.error,
          });
        } else {
          completedMap.set(run.participant, {
            participant: run.participant,
            sequence: run.sequence,
            replicate: run.replicate,
            task: run.task,
            engine: run.engine,
            source: run.source,
            reportFilename: run.reportFilename,
            status: "completed",
            durationSec: res.durationSec,
            completedAt: new Date().toISOString(),
          });
          saveBenchmarkState(schedule, completedMap);
        }
        results.push({
          participant: run.participant,
          lane: laneId,
          task: run.task,
          engine: run.engine,
          source: run.source,
          replicate: run.replicate,
          durationSec: res.durationSec,
          success: res.success,
        });
      } catch (err: unknown) {
        const crashDurationSec = Math.floor((Date.now() - sessionStart) / 1000);
        log(
          `[FAILED] [Lane ${laneId}] Participant ${run.participant} crashed after ${crashDurationSec}s with error: ${String(err)}`
        );
        cleanLane(laneId);
        dashboardTracker.sessionFinished(laneId, {
          participant: run.participant,
          lane: laneId,
          task: run.task,
          engine: run.engine,
          source: run.source,
          replicate: run.replicate,
          durationSec: crashDurationSec,
          success: false,
          error: String(err),
        });
        results.push({
          participant: run.participant,
          lane: laneId,
          task: run.task,
          engine: run.engine,
          source: run.source,
          replicate: run.replicate,
          durationSec: crashDurationSec,
          success: false,
        });
      }
    }
  }

  try {
    const laneWorkers: Promise<void>[] = [];
    for (let l = 1; l <= concurrency; l++) {
      laneWorkers.push(laneWorker(l));
    }
    await Promise.all(laneWorkers);
  } finally {
    dashboardTracker.dispose();
    if (activeCts?.token === token) {
      activeCts.dispose();
      activeCts = undefined;
    }
  }

  // Print final summary table
  results.sort((a, b) => a.participant.localeCompare(b.participant));
  log(
    "\n================================================================================"
  );
  log("BENCHMARK MATRIX COMPLETE: SUMMARY OF ALL PARTICIPANTS");
  log(
    "================================================================================"
  );
  log("| ID | Lane | Task | Engine | Source | Duration | Status |");
  log("| :-: | :--: | :--- | :----: | :----: | :------: | :----: |");
  for (const r of results) {
    const dur = `${Math.floor(r.durationSec / 60)}m ${r.durationSec % 60}s`;
    const st = r.success ? "[PASS]" : "[FAIL]";
    log(
      `| ${r.participant} | Lane ${r.lane} | ${r.task} | ${r.engine} | ${r.source} | ${dur} | ${st} |`
    );
  }
  log(
    "================================================================================\n"
  );

  // Run statistical analysis and regenerate dissertation tables/figures
  runAnalysisPipeline();
} // fn: runBenchmarkMatrix

export function runAnalysisPipeline(): void {
  const localVenvPython = path.join(WORKSPACE_ROOT, ".venv", "bin", "python");
  const analysisVenvPython = path.resolve(
    WORKSPACE_ROOT,
    "..",
    "nanofuzz-2024-analysis",
    ".venv",
    "bin",
    "python"
  );
  const pythonBin = fs.existsSync(localVenvPython)
    ? localVenvPython
    : fs.existsSync(analysisVenvPython)
      ? analysisVenvPython
      : "python3";

  const scriptCandidates = [
    path.join(WORKSPACE_ROOT, "benchmark", "scripts", "analyze_quarton.py"),
    path.join(WORKSPACE_ROOT, "scripts", "analyze_quarton.py"),
  ];
  const scriptPath =
    scriptCandidates.find((cand) => fs.existsSync(cand)) ?? scriptCandidates[0];
  if (!fs.existsSync(scriptPath)) {
    log(`[ANALYSIS] [WARN] Analysis script not found at ${scriptPath}`);
    return;
  }

  log("[ANALYSIS] Running QuartoN dissertation analysis pipeline...");
  try {
    const stdout = execSync(`"${pythonBin}" "${scriptPath}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of stdout.split("\n")) {
      if (line.trim()) {
        log(`  ${line}`);
      }
    }
  } catch (err: unknown) {
    log(`  [ANALYSIS] [WARN] Analysis pipeline error: ${String(err)}`);
  }
} // fn: runAnalysisPipeline

// -------------------------------------------------------------------------- //
// Benchmark Execution Dashboard
// -------------------------------------------------------------------------- //

class BenchmarkDashboardTracker {
  private _matrixStartTime: number = 0;
  private _totalRuns: number = 0;
  private _active: Map<number, ActiveSessionStatus> = new Map();
  private _finished: FinishedSessionStatus[] = [];
  private _statusBarItem: vscode.StatusBarItem | undefined;
  private _lastLogTime: number = 0;

  public startMatrix(
    totalRuns: number,
    initialFinished: FinishedSessionStatus[] = []
  ): void {
    this._matrixStartTime = Date.now();
    this._totalRuns = totalRuns;
    this._active.clear();
    this._finished = [...initialFinished];
    this._lastLogTime = 0;
    this.updateStatusBar();
    this.writeDashboardFile();
  } // fn: startMatrix

  public sessionStarted(lane: number, status: ActiveSessionStatus): void {
    this._active.set(lane, status);
    this.updateStatusBar();
    this.writeDashboardFile();
    this.logDashboard(true);
  } // fn: sessionStarted

  public updateTurn(lane: number, turn: number): void {
    const s = this._active.get(lane);
    if (s) {
      s.turn = turn;
      this.updateStatusBar();
      this.logDashboardIfDue();
    }
  } // fn: updateTurn

  public updatePhase(lane: number, stage: string): void {
    const s = this._active.get(lane);
    if (s) {
      s.stage = stage;
      this.updateStatusBar();
      this.writeDashboardFile();
      this.logDashboard(true);
    }
  } // fn: updatePhase

  public updateRetries(lane: number, retries: number): void {
    const s = this._active.get(lane);
    if (s) {
      s.retryAttempts = retries;
      this.updateStatusBar();
    }
  } // fn: updateRetries

  public incrementToolError(lane: number): void {
    const s = this._active.get(lane);
    if (s) {
      s.toolErrors++;
      this.updateStatusBar();
    }
  } // fn: incrementToolError

  public sessionFinished(lane: number, result: FinishedSessionStatus): void {
    this._active.delete(lane);
    const existingIdx = this._finished.findIndex(
      (f) => f.participant === result.participant
    );
    if (existingIdx !== -1) {
      this._finished[existingIdx] = result;
    } else {
      this._finished.push(result);
    }
    this.updateStatusBar();
    this.writeDashboardFile();
    this.logDashboard(true);
  } // fn: sessionFinished

  public logDashboardIfDue(): void {
    const now = Date.now();
    if (now - this._lastLogTime >= 45000) {
      this.logDashboard(true);
    }
  } // fn: logDashboardIfDue

  public logDashboard(force: boolean = false): void {
    if (!force) {
      this.logDashboardIfDue();
      return;
    }
    this._lastLogTime = Date.now();
    logRaw("\n" + this.renderDashboard());
  } // fn: logDashboard

  public renderDashboard(maxFinished: number = 8): string {
    const completed = this._finished.length;
    const total = this._totalRuns;
    const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : "0.0";
    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - (this._matrixStartTime || Date.now())) / 1000)
    );
    const elapsedStr = formatDuration(elapsedSec);
    const etaStr = estimateEta(
      total,
      completed,
      this._finished,
      this._active.size
    );

    const lines: string[] = [
      `================================================================================`,
      `[BENCHMARK DASHBOARD] ${completed}/${total} complete (${pct}%) | Elapsed: ${elapsedStr} | ETA: ${etaStr}`,
      `--------------------------------------------------------------------------------`,
      `RUNNING (${this._active.size} lanes):`,
    ];

    if (this._active.size === 0) {
      lines.push(`  (none - all lanes idle)`);
    } else {
      const activeList = Array.from(this._active.values()).sort(
        (a, b) => a.lane - b.lane
      );
      for (const a of activeList) {
        const laneElapsed = Math.max(
          0,
          Math.floor((Date.now() - a.startTime) / 1000)
        );
        const laneElapsedStr = formatDuration(laneElapsed);
        const errCount = a.toolErrors + a.retryAttempts;
        const treatment = `${a.engine}+${a.source}`;
        lines.push(
          `  L${a.lane}: ${a.participant} | ${a.task} | ${treatment} | ${a.stage} | Turn ${a.turn} | Err: ${errCount} | Active: ${laneElapsedStr}`
        );
      }
    }

    lines.push(``);
    lines.push(`FINISHED (${this._finished.length}):`);
    if (this._finished.length === 0) {
      lines.push(`  (none yet)`);
    } else {
      const showCount = Math.min(this._finished.length, maxFinished);
      const slice = this._finished.slice(-showCount);
      for (const f of slice) {
        const durStr = formatDuration(f.durationSec);
        const st = f.success ? "[PASS]" : "[FAIL]";
        const treatment = `${f.engine}+${f.source} (Rep ${f.replicate})`;
        const scoreStr =
          f.score !== undefined
            ? ` | Score: ${f.score} (${f.bugsElicited ?? 0}/${f.taskBugCount ?? 0} bugs)`
            : f.error
              ? ` | Error: ${f.error}`
              : "";
        lines.push(
          `  ${f.participant} (L${f.lane}) | ${f.task} | ${treatment} | ${durStr} | ${st}${scoreStr}`
        );
      }
      if (this._finished.length > maxFinished) {
        const earlier = this._finished.slice(0, -maxFinished);
        const passCount = earlier.filter((e) => e.success).length;
        const failCount = earlier.length - passCount;
        lines.push(
          `  ... and ${earlier.length} earlier completed (${passCount} [PASS], ${failCount} [FAIL])`
        );
      }
    }

    const scored = this._finished.filter((f) => f.score !== undefined);
    if (scored.length > 0) {
      lines.push(``);

      const calcStats = (items: FinishedSessionStatus[]) => {
        if (items.length === 0) return "- (0/0)";
        const totalBugs = items.reduce(
          (sum, f) =>
            sum + (f.taskBugCount ?? GROUND_TRUTH_BUGS[f.task]?.length ?? 0),
          0
        );
        const elicitedBugs = items.reduce(
          (sum, f) => sum + (f.bugsElicited ?? 0),
          0
        );
        const avgScore =
          items.reduce((sum, f) => sum + parseFloat(f.score ?? "0"), 0) /
          items.length;
        return `${avgScore.toFixed(3)} (${elicitedBugs}/${totalBugs})`;
      };

      const toolEntries = ENGINES.map((eng) => {
        const stats = calcStats(scored.filter((f) => f.engine === eng));
        return `${eng}: ${stats}`;
      });
      const maxTool = Math.max(...toolEntries.map((e) => e.length));

      const srcEntries = SOURCES.map((src) => {
        const stats = calcStats(scored.filter((f) => f.source === src));
        return `${src}: ${stats}`;
      });
      const maxSrc = Math.max(...srcEntries.map((e) => e.length));

      const taskEntries = BENCHMARK_TASKS.map((task) => {
        const stats = calcStats(scored.filter((f) => f.task === task));
        return `${task}: ${stats}`;
      });

      const maxTaskCol1 = Math.max(
        taskEntries[0]?.length ?? 0,
        taskEntries[1]?.length ?? 0,
        taskEntries[2]?.length ?? 0
      );

      const row1Col3 = (taskEntries[0] ?? "").padEnd(maxTaskCol1, " ");
      const row1Col4 = taskEntries[3] ?? "";
      const row2Col3 = (taskEntries[1] ?? "").padEnd(maxTaskCol1, " ");
      const row2Col4 = taskEntries[4] ?? "";
      const row3Col3 = taskEntries[2] ?? "";

      const r1Tool = (toolEntries[0] ?? "").padEnd(maxTool, " ");
      const r1Src = (srcEntries[0] ?? "").padEnd(maxSrc, " ");
      const r2Tool = (toolEntries[1] ?? "").padEnd(maxTool, " ");
      const r2Src = (srcEntries[1] ?? "").padEnd(maxSrc, " ");
      const r3Tool = (toolEntries[2] ?? "").padEnd(maxTool, " ");
      const r3Src = (srcEntries[2] ?? "").padEnd(maxSrc, " ");

      lines.push(
        `SCORES: ${r1Tool} | ${r1Src} | ${row1Col3}${row1Col4 ? ` | ${row1Col4}` : ""}`
      );
      lines.push(
        `        ${r2Tool} | ${r2Src} | ${row2Col3}${row2Col4 ? ` | ${row2Col4}` : ""}`
      );
      lines.push(`        ${r3Tool} | ${r3Src} | ${row3Col3}`);
    }

    lines.push(
      `================================================================================`
    );
    return lines.join("\n");
  } // fn: renderDashboard

  public renderMarkdownTooltip(): string {
    const completed = this._finished.length;
    const total = this._totalRuns;
    const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : "0.0";
    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - (this._matrixStartTime || Date.now())) / 1000)
    );
    const elapsedStr = formatDuration(elapsedSec);
    const etaStr = estimateEta(
      total,
      completed,
      this._finished,
      this._active.size
    );

    const lines: string[] = [
      `### 🧪 NaNofuzz Benchmark Progress`,
      `- **Progress**: ${completed}/${total} complete (${pct}%)`,
      `- **Elapsed**: ${elapsedStr} | **ETA**: ${etaStr}`,
      ``,
      `#### 🏃 Running Sessions`,
    ];

    if (this._active.size === 0) {
      lines.push(`*(No active sessions)*`);
    } else {
      lines.push(
        `| Lane | P# | Task | Treatment | Phase | Turn | Err | Active |`,
        `| :---: | :---: | :--- | :--- | :--- | :---: | :---: | :---: |`
      );
      const activeList = Array.from(this._active.values()).sort(
        (a, b) => a.lane - b.lane
      );
      for (const a of activeList) {
        const laneElapsed = formatDuration(
          Math.max(0, Math.floor((Date.now() - a.startTime) / 1000))
        );
        lines.push(
          `| L${a.lane} | **${a.participant}** | ${a.task} | \`${a.engine}+${a.source}\` | ${a.stage} | ${a.turn} | ${a.toolErrors + a.retryAttempts} | ${laneElapsed} |`
        );
      }
    }

    lines.push(``, `#### ✅ Finished Sessions (${this._finished.length})`);
    if (this._finished.length === 0) {
      lines.push(`*(No finished sessions yet)*`);
    } else {
      lines.push(
        `| P# | Lane | Task | Treatment | Duration | Status | Score |`,
        `| :---: | :---: | :--- | :--- | :---: | :---: | :---: |`
      );
      for (const f of this._finished.slice(-10)) {
        const durStr = formatDuration(f.durationSec);
        const scoreStr =
          f.score !== undefined
            ? `${f.score} (${f.bugsElicited ?? 0}/${f.taskBugCount ?? 0})`
            : "-";
        lines.push(
          `| **${f.participant}** | L${f.lane} | ${f.task} | \`${f.engine}+${f.source}\` | ${durStr} | ${f.success ? "PASS" : "FAIL"} | ${scoreStr} |`
        );
      }
    }

    return lines.join("\n");
  } // fn: renderMarkdownTooltip

  public updateStatusBar(): void {
    if (!this._statusBarItem) {
      this._statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
      );
    }
    const completed = this._finished.length;
    const total = this._totalRuns;
    const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : "0.0";
    const etaStr = estimateEta(
      total,
      completed,
      this._finished,
      this._active.size
    );

    this._statusBarItem.text = `$(beaker) NaNofuzz: ${completed}/${total} (${pct}%) ${etaStr}`;
    const md = new vscode.MarkdownString(this.renderMarkdownTooltip());
    md.isTrusted = true;
    this._statusBarItem.tooltip = md;
    this._statusBarItem.show();
  } // fn: updateStatusBar

  public writeDashboardFile(): void {
    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }
    const dashboardPath = path.join(RESULTS_DIR, "DASHBOARD.md");
    const content = [
      `# NaNofuzz Benchmark Execution Dashboard`,
      ``,
      `*Last Updated: ${new Date().toLocaleTimeString()}*`,
      ``,
      this.renderMarkdownTooltip(),
      ``,
    ].join("\n");
    fs.writeFileSync(dashboardPath, content, "utf8");
  } // fn: writeDashboardFile

  public dispose(): void {
    if (this._statusBarItem) {
      this._statusBarItem.hide();
      this._statusBarItem.dispose();
      this._statusBarItem = undefined;
    }
  } // fn: dispose
} // class: BenchmarkDashboardTracker

export const dashboardTracker = new BenchmarkDashboardTracker();

// -------------------------------------------------------------------------- //
// Auxiliary Types & Helpers
// -------------------------------------------------------------------------- //

export interface ActiveSessionStatus {
  participant: string;
  lane: number;
  task: string;
  engine: string;
  source: string;
  replicate: number;
  stage: string;
  turn: number;
  toolErrors: number;
  retryAttempts: number;
  startTime: number;
}

export interface FinishedSessionStatus {
  participant: string;
  lane: number;
  task: string;
  engine: string;
  source: string;
  replicate: number;
  durationSec: number;
  success: boolean;
  score?: string;
  bugsElicited?: number;
  taskBugCount?: number;
  error?: string;
}

/**
 * Estimates remaining wall-clock time based on finished sessions and active lanes.
 *
 * @param totalRuns total planned trials
 * @param completedRuns count of completed trials
 * @param finished array of finished session records
 * @param activeLanesCount number of concurrently running lanes
 * @returns formatted ETA duration string
 */
function estimateEta(
  totalRuns: number,
  completedRuns: number,
  finished: FinishedSessionStatus[],
  activeLanesCount: number
): string {
  if (completedRuns === 0 || totalRuns === 0) {
    return "calculating...";
  }
  const remaining = totalRuns - completedRuns;
  if (remaining <= 0) {
    return "0s";
  }

  const totalFinishedSec = finished.reduce((sum, s) => sum + s.durationSec, 0);
  const avgSecPerRun = totalFinishedSec / completedRuns;
  const effectiveConcurrency = Math.max(
    1,
    Math.min(activeLanesCount || 1, remaining)
  );
  const remainingSec = Math.round(
    (remaining * avgSecPerRun) / effectiveConcurrency
  );

  return formatEta(remainingSec);
} // fn: estimateEta

/**
 * Formats a duration in seconds into a human-readable ETA string.
 *
 * @param totalSec total seconds
 * @returns human-readable string like '~45m 12s' or '~2h 10m'
 */
function formatEta(totalSec: number): string {
  if (totalSec <= 0) return "0s";
  if (totalSec < 60) return `+${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) {
    return `+${m}m ${s}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `+${h}h ${remM}m`;
} // fn: formatEta

export interface PhaseTimeSplit {
  elapsedSec: number;
  retrySec: number;
  slotWaitSec: number;
  activeSec: number;
}

export interface ParticipantPhaseSplits {
  extractDocs: PhaseTimeSplit;
  extractTests: PhaseTimeSplit;
  totalExtract: PhaseTimeSplit;
  synthesis: PhaseTimeSplit;
  smoke: PhaseTimeSplit;
  deep: PhaseTimeSplit;
  contextualize: PhaseTimeSplit;
}

type AssistantStreamPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelDataPart;

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
} // fn: cast

function resolveWorkspaceRoot(): string {
  const folders = vscode.workspace?.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return process.cwd();
} // fn: resolveWorkspaceRoot

function resolveSourceRepo(): string {
  if (
    process.env.BENCHMARK_TARGET_REPO &&
    fs.existsSync(process.env.BENCHMARK_TARGET_REPO)
  ) {
    return path.resolve(process.env.BENCHMARK_TARGET_REPO);
  }
  const ws = resolveWorkspaceRoot();
  const candidates = [
    path.resolve(ws, "benchmark", "target"),
    path.resolve(ws, "..", "nanofuzz", "test-repos", "fandango"),
    path.resolve(ws, "..", "test-repos", "fandango"),
    path.resolve(ws, "test-repos", "fandango"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve(ws, "benchmark", "target");
} // fn: resolveSourceRepo

function getSystemCpus(): number {
  return typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
} // fn: getSystemCpus

export function getAutoConcurrencyLanes(): number {
  if (process.env.BENCHMARK_LANES) {
    const val = parseInt(process.env.BENCHMARK_LANES, 10);
    if (!isNaN(val) && val >= 1) return val;
  }
  return Math.max(2, Math.floor(getSystemCpus() / 2));
} // fn: getAutoConcurrencyLanes

export function getAutoDeepFuzzSlots(): number {
  if (process.env.BENCHMARK_DEEP_SLOTS) {
    const val = parseInt(process.env.BENCHMARK_DEEP_SLOTS, 10);
    if (!isNaN(val) && val >= 1) return val;
  }
  return Math.max(1, Math.floor(getSystemCpus() / 4));
} // fn: getAutoDeepFuzzSlots

interface BenchmarkRubricJson {
  targetMetadata?: {
    name?: string;
    commit?: string;
    version?: string;
    language?: string;
  };
  tasks?: Record<
    string,
    {
      file?: string;
      target_symbols?: string[];
      bugs?: Record<
        string,
        {
          id?: string;
          name?: string;
          description?: string;
          matchPatterns?: string[];
        }
      >;
    }
  >;
}

export interface GroundTruthBug {
  id: string;
  name: string;
  description: string;
  matchPatterns: RegExp[];
}

interface LoadedBenchmarkRubric {
  targetMetadata: {
    name: string;
    commit: string;
    version: string;
    language: string;
  };
  tasks: string[];
  groundTruthBugs: Record<string, GroundTruthBug[]>;
  allGroundTruthBugIds: string[];
}

function loadBenchmarkRubric(jsonPath: string): LoadedBenchmarkRubric {
  const fallback: LoadedBenchmarkRubric = {
    targetMetadata: {
      name: "target",
      commit: "HEAD",
      version: "v1.0.0",
      language: "python",
    },
    tasks: [],
    groundTruthBugs: {},
    allGroundTruthBugIds: [],
  };

  if (!fs.existsSync(jsonPath)) {
    return fallback;
  }

  try {
    const parsed: BenchmarkRubricJson = JSON.parse(
      fs.readFileSync(jsonPath, "utf8")
    );
    const tm = parsed.targetMetadata || {};
    const targetMetadata = {
      name: tm.name || "target",
      commit: tm.commit || "HEAD",
      version: tm.version || "v1.0.0",
      language: tm.language || "python",
    };

    const taskKeys = Object.keys(parsed.tasks || {});
    const groundTruthBugs: Record<string, GroundTruthBug[]> = {};
    const allBugIds: string[] = [];

    for (const [taskName, taskSpec] of Object.entries(parsed.tasks || {})) {
      const bugList: GroundTruthBug[] = [];
      for (const [bugKey, bugSpec] of Object.entries(taskSpec.bugs || {})) {
        const id = bugSpec.id || bugKey;
        const name = bugSpec.name || bugKey;
        const description = bugSpec.description || name;
        const patterns: RegExp[] = Array.isArray(bugSpec.matchPatterns)
          ? bugSpec.matchPatterns.map((p) => new RegExp(p, "i"))
          : [new RegExp(id, "i"), new RegExp(name, "i")];
        bugList.push({
          id,
          name,
          description,
          matchPatterns: patterns,
        });
        if (!allBugIds.includes(id)) {
          allBugIds.push(id);
        }
      }
      groundTruthBugs[taskName] = bugList;
    }

    return {
      targetMetadata,
      tasks: taskKeys,
      groundTruthBugs,
      allGroundTruthBugIds: allBugIds,
    };
  } catch (err: unknown) {
    log(
      `[WARN] Failed to load benchmark rubric from ${jsonPath}: ${String(err)}`
    );
    return fallback;
  }
} // fn: loadBenchmarkRubric

function ensureVenvSymlink(sourceVenv: string, venvLink: string): void {
  if (!fs.existsSync(sourceVenv)) {
    throw new Error(
      `Cannot initialize benchmark worktree: source virtualenv does not exist at '${sourceVenv}'.`
    );
  }
  const linkStat = fs.lstatSync(venvLink, { throwIfNoEntry: false });
  if (linkStat) {
    if (linkStat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(venvLink);
      const resolvedCurrent = path.resolve(
        path.dirname(venvLink),
        currentTarget
      );
      if (resolvedCurrent === path.resolve(sourceVenv)) {
        return;
      }
      fs.unlinkSync(venvLink);
    } else {
      fs.rmSync(venvLink, { recursive: true, force: true });
    }
  }
  fs.symlinkSync(sourceVenv, venvLink);
} // fn: ensureVenvSymlink
