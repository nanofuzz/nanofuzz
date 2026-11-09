import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as Config from "../Config";
import { isKeyedObject } from "../Util";
import { sessionManager } from "./FindBugsSessionManager";

// ============================================================================
// Configuration
// ============================================================================

const SEED = "qwertonyuiop";
const TARGET_REPO = path.resolve(
  "/Users/mcd2/git/cmumatt/nanofuzz/test-repos/fandango"
);
export const TARGET_FANDANGO_COMMIT =
  "d06277caa78a64816e74afc3085be193c64cf434";
export const TARGET_FANDANGO_VERSION = "v1.3.1-81-gd06277ca";

const REPORTS_DIR = path.resolve(
  "/Users/mcd2/git/cmumatt/nanofuzz/bug-reports/python"
);
const TELEMETRY_DIR = path.join(REPORTS_DIR, "telemetry");

const SCORING_SHEETS_DIR = path.join(REPORTS_DIR, "scoring_sheets");
const DATA_CSV_PATH = path.join(REPORTS_DIR, "data.csv");
const SURVEY_RESPONSES_CSV_PATH = path.join(
  REPORTS_DIR,
  "survey_responses.csv"
);

const ENGINES = ["nanofuzz", "hypothesis", "hypofuzz"] as const;
const SOURCES = ["tests", "docs", "all"] as const;

export const BENCHMARK_TASKS = [
  "TreeValue",
  "DerivationTree",
  "parse",
  "_distance_norm",
  "make_def",
] as const;

export type BenchmarkTaskName = (typeof BENCHMARK_TASKS)[number];

export interface GroundTruthBug {
  id: string;
  name: string;
  description: string;
  matchPatterns: RegExp[];
}

export const GROUND_TRUTH_BUGS: Record<BenchmarkTaskName, GroundTruthBug[]> = {
  TreeValue: [
    {
      id: "TV_EQ_NONE",
      name: "TypeError / AttributeError on __eq__(None)",
      description:
        "Comparing TreeValue == None raises TypeError or AttributeError instead of returning False",
      matchPatterns: [
        /attributeerror.*none/i,
        /typeerror.*none/i,
        /__eq__.*none/i,
        /cannot compare.*none/i,
        /eq.*none/i,
        /eq.*attribute/i,
      ],
    },
    {
      id: "TV_HASH_CONTRACT",
      name: "Hash contract violation on equal values",
      description:
        "Two TreeValue instances with equal content produce unequal hashes",
      matchPatterns: [/hash.*contract/i, /hash.*equal/i, /__hash__/i],
    },
    {
      id: "TV_TO_INT_VAL",
      name: "Unhandled ValueError in to_int()",
      description: "to_int() raises unhandled ValueError on non-numeric bytes",
      matchPatterns: [
        /to_int.*valueerror/i,
        /valueerror.*to_int/i,
        /invalid literal for int/i,
      ],
    },
    {
      id: "TV_RADD_STR",
      name: "Crash on __radd__ with string or bytes",
      description:
        "String concatenation '' + TreeValue(...) crashes with ValueError or TypeError",
      matchPatterns: [
        /__radd__/i,
        /radd.*typeerror/i,
        /radd.*valueerror/i,
        /can only concatenate str/i,
        /invalid literal for int/i,
        /fandangoconversionerror/i,
      ],
    },
    {
      id: "TV_ENCODING",
      name: "LookupError on invalid codec encoding",
      description:
        "_str_to_bytes raises unhandled LookupError on unknown codec",
      matchPatterns: [/lookuperror/i, /unknown encoding/i, /codec/i],
    },
  ],
  DerivationTree: [
    {
      id: "DT_TO_GRAMMAR_ASSERT",
      name: "AssertionError in to_grammar()",
      description:
        "Single-node or degenerate trees fail internal assertions in to_grammar()",
      matchPatterns: [/to_grammar.*assertion/i, /assertionerror.*to_grammar/i],
    },
    {
      id: "DT_ROUNDTRIP",
      name: "Round-trip serialization structural drift",
      description:
        "from_dict(to_dict()) does not preserve exact node attributes",
      matchPatterns: [/round.?trip/i, /to_dict.*from_dict/i, /deserializ/i],
    },
    {
      id: "DT_REPR_CRASH",
      name: "Unhandled crash in __repr__",
      description:
        "Cyclic parent pointers or unquoted token strings crash repr()",
      matchPatterns: [/repr.*crash/i, /__repr__/i, /recursion.*repr/i],
    },
    {
      id: "DT_PREFIX_SLICE",
      name: "IndexError in root prefix() slice",
      description:
        "tree.prefix(0) or negative slices crashes with unhandled IndexError",
      matchPatterns: [/prefix.*indexerror/i, /indexerror.*prefix/i],
    },
    {
      id: "DT_CHILD_SLICE",
      name: "IndexError on unexpanded child slice",
      description:
        "Indexing children of unexpanded non-terminal raises IndexError",
      matchPatterns: [/child.*indexerror/i, /unexpanded.*child/i],
    },
  ],
  parse: [
    {
      id: "PARSE_EMPTY_CONSTRAINT",
      name: "IndexError on empty/whitespace constraint",
      description:
        "parse(..., constraints=['']) crashes on constraint.split()[0] with IndexError",
      matchPatterns: [
        /constraint\.split/i,
        /indexerror.*constraint/i,
        /empty.*constraint/i,
      ],
    },
    {
      id: "PARSE_LEXER_STALL",
      name: "ANTLR lexer stall on escaped delimiter",
      description: "Grammar with escaped delimiter causes lexer freeze/stall",
      matchPatterns: [/lexer.*stall/i, /escaped.*pipe/i, /regex.*hang/i],
    },
    {
      id: "PARSE_NAME_ERROR",
      name: "Leaked NameError on unresolved identifier",
      description:
        "Unresolved grammar identifiers leak raw NameError instead of FandangoError",
      matchPatterns: [/nameerror/i, /unresolved identifier/i],
    },
    {
      id: "PARSE_SILENT_DROP",
      name: "Silent constraint drop on trailing syntax",
      description:
        "Constraints with trailing comments are dropped silently without validation",
      matchPatterns: [/silent.*drop/i, /constraint.*drop/i],
    },
  ],
  _distance_norm: [
    {
      id: "SIGMOID_OVERFLOW",
      name: "OverflowError in _sigmoid() on extreme negative floats",
      description:
        "_sigmoid(x) with x <= -710.0 raises math range error / OverflowError",
      matchPatterns: [
        /overflowerror.*sigmoid/i,
        /sigmoid.*overflow/i,
        /math range error/i,
      ],
    },
    {
      id: "NORM_ZERO_DIV",
      name: "ZeroDivisionError in _distance_norm when lower == upper",
      description: "Normalizing with equal bounds causes ZeroDivisionError",
      matchPatterns: [/zerodivision/i, /division by zero/i],
    },
  ],
  make_def: [
    {
      id: "DEF_EMPTY_RHS",
      name: "SyntaxError on empty RHS definition",
      description:
        "Generating definition with empty RHS string crashes with SyntaxError",
      matchPatterns: [/empty rhs/i, /syntaxerror.*rhs/i, /make_def.*empty/i],
    },
    {
      id: "DEF_UNICODE_CORRUPT",
      name: "Grammar corruption on non-ASCII identifiers",
      description:
        "Non-ASCII Unicode in identifier names corrupts symbol table",
      matchPatterns: [/unicode.*corrupt/i, /non-ascii/i, /homoglyph/i],
    },
  ],
};

const ALL_GROUND_TRUTH_BUG_IDS = Object.values(GROUND_TRUTH_BUGS)
  .flat()
  .map((b) => b.id);

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
}

/**
 * Cancels any actively running benchmark matrix session.
 */
export function cancelBenchmarkMatrix(): void {
  if (activeCts) {
    activeCts.cancel();
    activeCts.dispose();
    activeCts = undefined;
    log("[CANCEL] Benchmark run cancelled by user.");
    cleanTargetRepo();
    vscode.window.showInformationMessage("NaNofuzz Benchmark cancelled.");
  } else {
    vscode.window.showInformationMessage(
      "No active NaNofuzz Benchmark to cancel."
    );
  }
}

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
          const reportFilename = `fandango fuzzer ${eng}+${src}+${task} rep${rep} v6.md`;
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
          generator = run.generatorName || "RandomInputGenerator";
          break;
        }
      }
    }

    // Fallback check if report contains reproducer or error matching patterns
    if (elicited === 0 && reportText) {
      const isMatch = bug.matchPatterns.some((pat) => pat.test(reportText));
      if (isMatch) {
        elicited = 1;
        generator = "RandomInputGenerator";
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
    `- **PUT Version**: Fandango \`${TARGET_FANDANGO_VERSION}\` (\`${TARGET_FANDANGO_COMMIT.slice(0, 8)}\`)`,
    `- **Replicate**: ${run.replicate} (Sequence Order: ${run.sequence})`,
    `- **Date**: ${new Date().toISOString().split("T")[0]}`,
    `- **Duration**: ${Math.floor(durationSec / 60)}m ${durationSec % 60}s (active: ${splits.totalExtract.activeSec + splits.synthesis.activeSec + splits.smoke.activeSec + splits.deep.activeSec}s, retry: ${splits.totalExtract.retrySec + splits.synthesis.retrySec + splits.smoke.retrySec + splits.deep.retrySec}s)`,
    `- **Phase Timing Splits**:`,
    `  - Invariant Extraction: ${splits.totalExtract.activeSec}s active (${splits.totalExtract.retrySec}s retry, ${splits.totalExtract.elapsedSec}s elapsed)`,
    `    - From Docs: ${splits.extractDocs.activeSec}s active (${splits.extractDocs.retrySec}s retry)`,
    `    - From Tests: ${splits.extractTests.activeSec}s active (${splits.extractTests.retrySec}s retry)`,
    `  - Harness Synthesis: ${splits.synthesis.activeSec}s active (${splits.synthesis.retrySec}s retry, ${splits.synthesis.elapsedSec}s elapsed)`,
    `  - Smoke Testing: ${splits.smoke.activeSec}s active (${splits.smoke.retrySec}s retry, ${splits.smoke.elapsedSec}s elapsed)`,
    `  - Deep Fuzzing: ${splits.deep.activeSec}s active (${splits.deep.retrySec}s retry, ${splits.deep.elapsedSec}s elapsed)`,
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
    "Deep.ActiveSec",
    "TotalFuzzRuns",
    "TotalTestsExecuted",
    "BranchCoveragePct",
    "TaskBugCount",
    "BugsElicited",
    "NormalizedScore",
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
    String(splits.deep.activeSec),
    String(totalFuzzRuns),
    String(totalTests),
    branchCoverage.toFixed(1),
    String(taskBugCount),
    String(bugsElicited),
    score,
    survey ? String(survey.realistic) : "3",
    survey ? survey.susScore.toFixed(1) : "50.0",
    survey ? String(survey.sus1) : "3",
    survey ? String(survey.sus2) : "3",
    survey ? String(survey.sus3) : "3",
    survey ? String(survey.sus4) : "3",
    survey ? String(survey.sus5) : "3",
    survey ? String(survey.sus6) : "3",
    survey ? String(survey.sus7) : "3",
    survey ? String(survey.sus8) : "3",
    survey ? String(survey.sus9) : "3",
    survey ? String(survey.sus10) : "3",
    `"${generators || "None"}"`,
    "COMPLETED",
    ...bugCols,
  ];

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
} // fn: appendToDataCsv

// ============================================================================
// Target Repo Hygiene & Settings
// ============================================================================

export function cleanTargetRepo(): void {
  if (!fs.existsSync(TARGET_REPO)) return;
  try {
    execSync("git checkout -- .", { cwd: TARGET_REPO, stdio: "ignore" });
    execSync("git clean -fd", { cwd: TARGET_REPO, stdio: "ignore" });
    execSync(`git checkout -q ${TARGET_FANDANGO_COMMIT}`, {
      cwd: TARGET_REPO,
      stdio: "ignore",
    });
  } catch (err) {
    log(`[WARN] git cleanup error: ${String(err)}`);
  }

  try {
    const tmpFiles = fs.readdirSync("/tmp");
    for (const f of tmpFiles) {
      if (f.startsWith("nanofuzz_pbt_") || f.startsWith("nanofuzz_")) {
        try {
          fs.unlinkSync(path.join("/tmp", f));
        } catch (unlinkErr) {
          log(`[DEBUG] could not remove tmp file ${f}: ${String(unlinkErr)}`);
        }
      }
    }
  } catch (readdirErr) {
    log(`[DEBUG] /tmp read error: ${String(readdirErr)}`);
  }
} // fn: cleanTargetRepo

export function configureRunSettings(
  engine: string,
  source: string,
  targetScope: string[]
): void {
  Config.override("nanofuzz.experimental.findBugs.tool", engine);
  Config.override("nanofuzz.experimental.findBugs.invariantSource", source);
  Config.override("nanofuzz.experimental.findBugs.targetScope", targetScope);

  // Pre-approve target repo for reading and editing so no modal dialogs appear
  Config.override("chat.additionalReadAccessPaths", [TARGET_REPO, REPORTS_DIR]);
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
  token?: vscode.CancellationToken
): Promise<{ success: boolean; durationSec: number; error?: string }> {
  const t0 = Date.now();
  const seqStr = String(run.sequence).padStart(2, "0");
  const totStr = String(totalRuns).padStart(2, "0");
  const prefix = `[${run.participant} | Seq ${seqStr}/${totStr}]`;

  log(
    `\n================================================================================`
  );
  log(
    `[START] ${prefix}: Task ${run.task} (Engine: ${run.engine} | Source: ${run.source} | Rep ${run.replicate})`
  );
  log(`Destination report: ${run.reportFilename}`);
  log(
    `================================================================================`
  );

  // Clean repo, reset session manager state, and set settings
  cleanTargetRepo();
  sessionManager.clear();
  configureRunSettings(run.engine, run.source, run.targetScope);

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
    `Target Repository: ${TARGET_REPO}`,
    `Target Task Entrypoint: ${run.task}`,
    "",
    `Use NaNofuzz to find bugs in the entrypoint '${run.task}' in fandango fuzzer for Python located at ${TARGET_REPO}.`,
    `(do not look at '../nanofuzz/bug-reports'; after the find_bugs workflow completes, save your bug report to '../nanofuzz/bug-reports/python/${run.reportFilename}')`,
  ].join("\n");

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(initialPrompt),
  ];

  let turn = 0;
  const MAX_TURNS = 120;
  let sessionCompleted = false;
  let totalRetryWaitMs = 0;
  let totalRetryAttempts = 0;

  // Track phase progress and timing splits
  const PHASE_STEPS: Record<string, string> = {
    init: "1/5",
    invariants_from_docs: "1/5",
    invariants_from_tests: "2/5",
    invariants_extracted: "3/5",
    fuzz_smoke: "4/5",
    fuzz_deep: "5/5",
    fuzz_entrypoint: "4/5",
    contextualize_bugs: "5/5",
    complete: "5/5",
  };
  let currentPhase = "init";
  let phaseStartTime = t0;
  let phaseRetryWaitMs = 0;

  const phaseTimings: Record<
    string,
    { elapsedMs: number; retryWaitMs: number }
  > = {};

  const commitPhaseTiming = (phaseName: string, endTime: number): void => {
    if (!phaseTimings[phaseName]) {
      phaseTimings[phaseName] = { elapsedMs: 0, retryWaitMs: 0 };
    }
    const elapsed = Math.max(0, endTime - phaseStartTime);
    phaseTimings[phaseName].elapsedMs += elapsed;
    phaseTimings[phaseName].retryWaitMs += phaseRetryWaitMs;
    phaseStartTime = endTime;
    phaseRetryWaitMs = 0;
  };

  const recordedToolEvents: Array<{
    tool: string;
    args: unknown;
    timestamp: string;
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
    const stepLabel = PHASE_STEPS[currentPhase] || "?/4";
    log(
      `  [${run.participant}, Phase ${stepLabel} (${currentPhase})] Turn ${turn} sending to LLM...`
    );

    // Stream and turn execution with automatic resilient retry on 503 / 429 / socket drops / stream errors
    let assistantText = "";
    let toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let allParts: AssistantStreamPart[] = [];
    let streamSucceeded = false;
    let attempt = 0;
    const maxRetries = 20;

    while (!streamSucceeded) {
      if (token?.isCancellationRequested) {
        log(`${prefix} Cancellation requested.`);
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
          if (part instanceof vscode.LanguageModelTextPart) {
            assistantText += part.value;
            allParts.push(part);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(part);
            allParts.push(part);
          } else if (part instanceof vscode.LanguageModelDataPart) {
            allParts.push(part);
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
          log(`  ${prefix} [CANCEL] Request cancelled by user.`);
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
          errStr.includes("socket hang up");

        if (!isTransient || attempt >= maxRetries) {
          log(
            `  ${prefix} [FAILED] LLM request failed (attempt ${attempt}/${maxRetries}): ${errStr}`
          );
          cleanTargetRepo();
          return {
            success: false,
            durationSec: Math.floor((Date.now() - t0) / 1000),
            error: errStr,
          };
        }

        totalRetryAttempts++;
        // Exponential backoff with jitter for 503 / 429 / busy spikes
        const baseDelay = Math.min(60000, 3000 * Math.pow(1.6, attempt - 1));
        const delayMs = baseDelay + Math.floor(Math.random() * 3000);
        totalRetryWaitMs += delayMs;
        phaseRetryWaitMs += delayMs;
        log(
          `  ${prefix} [RETRY] Model busy / 503 spike (attempt ${attempt}/${maxRetries}): ${errStr}. Waiting ${Math.round(delayMs / 1000)}s before retry...`
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
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    } else if (assistantText) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantText));
    }

    // If no tools were called, check if report already exists or encourage continuation
    if (toolCalls.length === 0) {
      log(
        `  ${prefix} Model returned text without tool calls: ${assistantText.slice(0, 100)}...`
      );
      if (
        fs.existsSync(run.reportPath) &&
        fs.statSync(run.reportPath).size > 500
      ) {
        log(`  ${prefix} Report detected on disk. Marking session complete.`);
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

      recordedToolEvents.push({
        tool: toolName,
        args: toolInput,
        timestamp: new Date().toISOString(),
      });

      // Log structured turn feedback to console
      if (toolName === "nanofuzz_findBugs") {
        const p =
          typeof toolInput.phase === "string" ? toolInput.phase : "init";
        if (p !== currentPhase) {
          commitPhaseTiming(currentPhase, Date.now());
          currentPhase = p;
        }
        const sp: Record<string, unknown> = isKeyedObject(
          toolInput.statePayload
        )
          ? toolInput.statePayload
          : {};
        const stage =
          typeof sp.stage === "string" ? ` [Stage: ${sp.stage}]` : "";
        const fn =
          typeof sp.functionName === "string"
            ? ` (fn: ${sp.functionName})`
            : "";
        const step = PHASE_STEPS[currentPhase] || "?/5";
        log(
          `  [${run.participant}, Phase ${step} (${p})] State: ${p}${stage}${fn}`
        );
        if (p === "complete") {
          sessionCompleted = true;
        }
      } else if (toolName === "nanofuzz_fuzzFunction") {
        const fn = toolInput.functionName || "";
        const maxTests =
          toolInput.maxTests === 0
            ? "continuous (maxTests=0)"
            : `${toolInput.maxTests} tests`;
        const to = Math.round(Number(toolInput.timeoutMs || 0) / 1000);
        const step = PHASE_STEPS[currentPhase] || "?/5";
        log(
          `  [Run ${seqStr}/${totStr}, Phase ${step}] Fuzzing: ${fn} (${maxTests}, timeout=${to}s)`
        );
      } else if (toolName === "nanofuzz_listTargets") {
        const rel = String(toolInput.filePath || "")
          .split("/")
          .slice(-2)
          .join("/");
        const step = PHASE_STEPS[currentPhase] || "?/5";
        log(`  [Run ${seqStr}/${totStr}, Phase ${step}] Scanning: ${rel}`);
      } else {
        const step = PHASE_STEPS[currentPhase] || "?/5";
        log(`  [Run ${seqStr}/${totStr}, Phase ${step}] Tool: ${toolName}`);
      }

      // Invoke tool via vscode.lm.invokeTool
      let resultText = "";
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
      } catch (err: unknown) {
        resultText = `Tool invocation error: ${String(err)}`;
        log(`  ${prefix} [WARN] Tool ${toolName} threw: ${String(err)}`);
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
  const activeSec = Math.max(0, durationSec - retryWaitSec);

  const getPhaseSec = (phaseName: string): PhaseTimeSplit => {
    const t = phaseTimings[phaseName] || { elapsedMs: 0, retryWaitMs: 0 };
    const elapsedSec = Math.round(t.elapsedMs / 1000);
    const retrySec = Math.round(t.retryWaitMs / 1000);
    const activeSec = Math.max(0, elapsedSec - retrySec);
    return { elapsedSec, retrySec, activeSec };
  };

  let extractDocs: PhaseTimeSplit;
  let extractTests: PhaseTimeSplit;

  if (run.source === "docs") {
    const docs1 = getPhaseSec("init");
    const docs2 = getPhaseSec("invariants_from_docs");
    extractDocs = {
      elapsedSec: docs1.elapsedSec + docs2.elapsedSec,
      retrySec: docs1.retrySec + docs2.retrySec,
      activeSec: docs1.activeSec + docs2.activeSec,
    };
    extractTests = { elapsedSec: 0, retrySec: 0, activeSec: 0 };
  } else if (run.source === "tests") {
    extractDocs = { elapsedSec: 0, retrySec: 0, activeSec: 0 };
    extractTests = getPhaseSec("init");
  } else {
    // "all": init (or invariants_from_docs) is docs, invariants_from_tests is tests
    const docs1 = getPhaseSec("init");
    const docs2 = getPhaseSec("invariants_from_docs");
    extractDocs = {
      elapsedSec: docs1.elapsedSec + docs2.elapsedSec,
      retrySec: docs1.retrySec + docs2.retrySec,
      activeSec: docs1.activeSec + docs2.activeSec,
    };
    extractTests = getPhaseSec("invariants_from_tests");
  }

  const totalExtract: PhaseTimeSplit = {
    elapsedSec: extractDocs.elapsedSec + extractTests.elapsedSec,
    retrySec: extractDocs.retrySec + extractTests.retrySec,
    activeSec: extractDocs.activeSec + extractTests.activeSec,
  };

  const synthesis = getPhaseSec("invariants_extracted");
  const smoke = getPhaseSec("fuzz_smoke");

  const deep1 = getPhaseSec("fuzz_deep");
  const deep2 = getPhaseSec("fuzz_entrypoint");
  const deep: PhaseTimeSplit = {
    elapsedSec: deep1.elapsedSec + deep2.elapsedSec,
    retrySec: deep1.retrySec + deep2.retrySec,
    activeSec: deep1.activeSec + deep2.activeSec,
  };

  const splits: ParticipantPhaseSplits = {
    extractDocs,
    extractTests,
    totalExtract,
    synthesis,
    smoke,
    deep,
  };

  // Evaluate ground-truth bugs elicited & reported for this participant
  const reportContent = fs.existsSync(run.reportPath)
    ? fs.readFileSync(run.reportPath, "utf8")
    : "";

  const activeSession = sessionManager.getSession();
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
    sequence: run.sequence,
    replicate: run.replicate,
    task: run.task,
    engine: run.engine,
    source: run.source,
    targetScope: run.targetScope,
    targetCommit: TARGET_FANDANGO_COMMIT,
    targetVersion: TARGET_FANDANGO_VERSION,
    reportFilename: run.reportFilename,
    durationSeconds: durationSec,
    activeExecutionSeconds: activeSec,
    apiRetryWaitSeconds: retryWaitSec,
    apiRetryAttempts: totalRetryAttempts,
    phaseSplits: splits,
    completedAt: new Date().toISOString(),
    toolEventCount: recordedToolEvents.length,
    events: recordedToolEvents,
    evalResults,
    survey,
  };
  fs.writeFileSync(
    telemetryJsonPath,
    JSON.stringify(telemetryData, null, 2),
    "utf8"
  );
  log(`${prefix} Saved telemetry: ${path.basename(telemetryJsonPath)}`);

  // Clean target repository
  log(`${prefix} Cleaning target repository...`);
  cleanTargetRepo();

  const score =
    evalResults.length > 0
      ? (
          evalResults.filter((r) => r.elicited === 1).length /
          evalResults.length
        ).toFixed(3)
      : "0.000";

  log(
    `[SUCCESS] ${prefix} Completed in ${mm}m ${ss}s! Score: ${score} (${run.reportFilename})\n`
  );
  return { success: true, durationSec };
}

// ============================================================================
// Master Orchestrator (45 or 135 Runs)
// ============================================================================

export async function runBenchmarkMatrix(replicates: 1 | 3 = 1): Promise<void> {
  const schedule = generateBenchmarkSchedule(replicates);
  const totalRuns = schedule.length;

  if (activeCts) {
    activeCts.cancel();
    activeCts.dispose();
  }
  activeCts = new vscode.CancellationTokenSource();
  const token = activeCts.token;

  getOutput().show(true);
  log(
    "================================================================================"
  );
  log(
    `[BENCHMARK] Starting unattended matrix: ${totalRuns} tasks (Seed: '${SEED}')`
  );
  log(
    `Target Repo: ${TARGET_REPO} (${TARGET_FANDANGO_VERSION} @ ${TARGET_FANDANGO_COMMIT.slice(0, 8)})`
  );
  log(`Factorial Tasks: ${BENCHMARK_TASKS.join(", ")}`);
  log(`Engines: ${ENGINES.join(", ")} | Sources: ${SOURCES.join(", ")}`);
  log(
    "================================================================================\n"
  );

  const results: Array<{
    participant: string;
    task: string;
    engine: string;
    source: string;
    replicate: number;
    durationSec: number;
    success: boolean;
  }> = [];

  try {
    for (const run of schedule) {
      if (token.isCancellationRequested) {
        log("[CANCEL] Benchmark loop cancelled.");
        break;
      }

      try {
        const res = await runSingleBenchmarkSession(run, totalRuns, token);
        results.push({
          participant: run.participant,
          task: run.task,
          engine: run.engine,
          source: run.source,
          replicate: run.replicate,
          durationSec: res.durationSec,
          success: res.success,
        });
      } catch (err: unknown) {
        log(
          `[FAILED] Participant ${run.participant} crashed with error: ${String(err)}`
        );
        cleanTargetRepo();
        results.push({
          participant: run.participant,
          task: run.task,
          engine: run.engine,
          source: run.source,
          replicate: run.replicate,
          durationSec: 0,
          success: false,
        });
      }
    }
  } finally {
    if (activeCts?.token === token) {
      activeCts.dispose();
      activeCts = undefined;
    }
  }

  // Print final summary table
  log(
    "\n================================================================================"
  );
  log("BENCHMARK MATRIX COMPLETE: SUMMARY OF ALL PARTICIPANTS");
  log(
    "================================================================================"
  );
  log("| ID | Task | Engine | Source | Duration | Status |");
  log("| :-: | :--- | :----: | :----: | :------: | :----: |");
  for (const r of results) {
    const dur = `${Math.floor(r.durationSec / 60)}m ${r.durationSec % 60}s`;
    const st = r.success ? "[PASS]" : "[FAIL]";
    log(
      `| ${r.participant} | ${r.task} | ${r.engine} | ${r.source} | ${dur} | ${st} |`
    );
  }
  log(
    "================================================================================\n"
  );
}

// -------------------------------------------------------------------------- //
// Auxiliary Types & Helpers
// -------------------------------------------------------------------------- //

type AssistantStreamPart =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelDataPart;

export interface PhaseTimeSplit {
  elapsedSec: number;
  retrySec: number;
  activeSec: number;
}

export interface ParticipantPhaseSplits {
  extractDocs: PhaseTimeSplit;
  extractTests: PhaseTimeSplit;
  totalExtract: PhaseTimeSplit;
  synthesis: PhaseTimeSplit;
  smoke: PhaseTimeSplit;
  deep: PhaseTimeSplit;
}
