import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// import * as Config from "../Config";
import {
  collectPostTaskSurvey,
  /*
  computeProtocolBMedian,
  evaluateBugsWithLlmJudge,
  selectJuryModels,
  validateJuryModels,
  JurorRating,
  GROUND_TRUTH_BUGS,
  */
  findLatestUnfinishedRun,
  createRunContext,
  formatDatestamp,
  updateLatestSymlink,
  runSingleBenchmarkSession,
  setActiveRunContext,
  generateBenchmarkSchedule,
  BenchmarkRunSpec,
} from "./BenchmarkRunner";
import { resolveFullProvenance } from "../fuzzer/Util";
import { FuzzValueOrigin } from "../fuzzer/Types";

const sampleSurveyJson = JSON.stringify({
  realistic: 5,
  taskConfidence: 4,
  sus1: 4,
  sus2: 2,
  sus3: 5,
  sus4: 1,
  sus5: 4,
  sus6: 2,
  sus7: 5,
  sus8: 1,
  sus9: 4,
  sus10: 2,
  toolHelpfulFeedback: "Great tool",
  toolUsabilityFeedback: "Easy to use",
  workflowFitFeedback: "Fits well",
  toolImprovementFeedback: "None",
  studyImprovementFeedback: "None",
});

describe("BenchmarkRunner - collectPostTaskSurvey", () => {
  const dummyRun: BenchmarkRunSpec = {
    participant: "P99",
    sequence: 99,
    replicate: 1,
    task: "TreeValue",
    engine: "nanofuzz",
    source: "docs",
    targetScope: ["TreeValue"],
    reportFilename: "P99.md",
    reportPath: "/tmp/P99.md",
  };

  function createMockModel(responses: Array<string | Error>): vscode.LanguageModelChat {
    let callIndex = 0;
    return {
      id: "mock-model",
      name: "Mock Model",
      vendor: "copilot",
      family: "gpt-4",
      version: "1.0",
      maxInputTokens: 100000,
      countTokens: async () => 10,
      sendRequest: async () => {
        const current = responses[callIndex] ?? "";
        callIndex++;
        if (current instanceof Error) {
          throw current;
        }
        return {
          text: (async function* () {
            if (current) yield current;
          })(),
          stream: (async function* () {
            if (current) yield new vscode.LanguageModelTextPart(current);
          })(),
        };
      },
    };
  }

  it("succeeds on first attempt with valid JSON", async () => {
    const model = createMockModel([`\`\`\`json\n${sampleSurveyJson}\n\`\`\``]);
    const messages = [vscode.LanguageModelChatMessage.User("Task done")];

    const result = await collectPostTaskSurvey({
      model,
      messages,
      run: dummyRun,
      baseDelayMs: 0,
      writeCsv: false,
    });

    expect(result.survey).toBeDefined();
    expect(result.survey?.realistic).toBe(5);
    expect(result.survey?.taskConfidence).toBe(4);
    expect(result.survey?.sus1).toBe(4);
    expect(result.survey?.susScore).toBeGreaterThan(0);
    expect(result.rawSurveyOutputs.length).toBe(1);
  });

  it("recovers from empty stream chunks with exponential retry and succeeds", async () => {
    // Attempt 1: empty stream
    // Attempt 2: empty stream
    // Attempt 3: valid JSON
    const model = createMockModel([
      "",
      "",
      `\`\`\`json\n${sampleSurveyJson}\n\`\`\``,
    ]);
    const messages = [vscode.LanguageModelChatMessage.User("Task done")];

    let retryCount = 0;
    const result = await collectPostTaskSurvey({
      model,
      messages,
      run: dummyRun,
      baseDelayMs: 0,
      writeCsv: false,
      onRetry: () => {
        retryCount++;
      },
    });

    expect(result.survey).toBeDefined();
    expect(result.survey?.realistic).toBe(5);
    expect(retryCount).toBe(2);
    expect(result.rawSurveyOutputs.length).toBe(3);
    expect(result.rawSurveyOutputs[0]).toBe("");
    expect(result.rawSurveyOutputs[1]).toBe("");
    expect(result.rawSurveyOutputs[2]).toContain("realistic");
  });

  it("handles malformed JSON with reprompt and succeeds on second attempt", async () => {
    // Attempt 1: malformed text
    // Attempt 2: valid JSON
    const model = createMockModel([
      "Sorry I cannot complete JSON",
      `\`\`\`json\n${sampleSurveyJson}\n\`\`\``,
    ]);
    const messages = [vscode.LanguageModelChatMessage.User("Task done")];

    const result = await collectPostTaskSurvey({
      model,
      messages,
      run: dummyRun,
      baseDelayMs: 0,
      writeCsv: false,
    });

    expect(result.survey).toBeDefined();
    expect(result.survey?.realistic).toBe(5);
    expect(result.rawSurveyOutputs.length).toBe(2);
    expect(result.rawSurveyOutputs[0]).toBe("Sorry I cannot complete JSON");
    expect(result.rawSurveyOutputs[1]).toContain("realistic");
  });

  it("recovers from transient network errors (e.g. 503 / 429)", async () => {
    // Attempt 1: 503 UNAVAILABLE
    // Attempt 2: valid JSON
    const model = createMockModel([
      new Error("503 Service Unavailable"),
      `\`\`\`json\n${sampleSurveyJson}\n\`\`\``,
    ]);
    const messages = [vscode.LanguageModelChatMessage.User("Task done")];

    let retryCount = 0;
    const result = await collectPostTaskSurvey({
      model,
      messages,
      run: dummyRun,
      baseDelayMs: 0,
      writeCsv: false,
      onRetry: () => {
        retryCount++;
      },
    });

    expect(result.survey).toBeDefined();
    expect(result.survey?.realistic).toBe(5);
    expect(retryCount).toBe(1);
  });

  it("prunes messages and retries when context token limit is exceeded", async () => {
    // Attempt 1: Context length exceeded error
    // Attempt 2: valid JSON
    const model = createMockModel([
      new Error("context_length_exceeded: prompt is too long"),
      `\`\`\`json\n${sampleSurveyJson}\n\`\`\``,
    ]);
    const messages = [
      vscode.LanguageModelChatMessage.User("Turn 1"),
      vscode.LanguageModelChatMessage.Assistant("Reply 1"),
      vscode.LanguageModelChatMessage.User("Turn 2"),
      vscode.LanguageModelChatMessage.Assistant("Reply 2"),
      vscode.LanguageModelChatMessage.User("Turn 3"),
      vscode.LanguageModelChatMessage.Assistant("Reply 3"),
    ];

    const result = await collectPostTaskSurvey({
      model,
      messages,
      run: dummyRun,
      baseDelayMs: 0,
      writeCsv: false,
    });

    expect(result.survey).toBeDefined();
    expect(result.survey?.realistic).toBe(5);
  });

  it("gracefully halts after exhausting all 15 retries on persistent empty streams without throwing", async () => {
    // 15 empty streams
    const model = createMockModel(new Array(15).fill(""));
    const messages = [vscode.LanguageModelChatMessage.User("Task done")];

    let retryCount = 0;
    const result = await collectPostTaskSurvey({
      model,
      messages,
      run: dummyRun,
      maxSurveyRetries: 15,
      baseDelayMs: 0,
      writeCsv: false,
      onRetry: () => {
        retryCount++;
      },
    });

    // Should not throw, should return survey = undefined, and record all 15 empty attempts
    expect(result.survey).toBeUndefined();
    expect(result.rawSurveyOutputs.length).toBe(15);
    expect(retryCount).toBe(14); // Retries triggered between attempt 1 and 15
  });
});

/*
describe("BenchmarkRunner - Protocol B PoLL Jury (Verga et al., 2024)", () => {
  it("computes median net score and plurality elicitation across 3 divergent jurors", () => {
    const ratings: JurorRating[] = [
      {
        juror: "gemini",
        elicitedInReport: true,
        creditEarned: 1.0,
        deduction: 0.0,
        netScore: 1.0,
        evidenceQuote: "Quote G",
        rationale: "Full domain described",
      },
      {
        juror: "claude",
        elicitedInReport: true,
        creditEarned: 0.5,
        deduction: 0.0,
        netScore: 0.5,
        evidenceQuote: "Quote C",
        rationale: "Partial domain described",
      },
      {
        juror: "gpt4o",
        elicitedInReport: false,
        creditEarned: 0.0,
        deduction: 0.0,
        netScore: 0.0,
        evidenceQuote: "",
        rationale: "Not mentioned",
      },
    ];

    const consensus = computeProtocolBMedian(ratings);

    // Median of [1.0, 0.5, 0.0] is 0.5
    expect(consensus.netScore).toBe(0.5);
    expect(consensus.creditEarned).toBe(0.5);
    expect(consensus.deduction).toBe(0.0);
    // 2 out of 3 said elicited -> majority says elicited
    expect(consensus.elicitedInReport).toBe(true);
    expect(consensus.consensusMethod).toBe("poll_protocol_b_median");
    expect(consensus.jurorScores.gemini.netScore).toBe(1.0);
    expect(consensus.jurorScores.claude.netScore).toBe(0.5);
    expect(consensus.jurorScores.gpt4o.netScore).toBe(0.0);
    expect(consensus.rationale).toContain("gemini:+1");
    expect(consensus.rationale).toContain("claude:+0.5");
    expect(consensus.rationale).toContain("gpt4o:0");
  });

  it("handles unanimous and ties correctly", () => {
    // Case 1: [1.0, 1.0, 0.0] -> median is 1.0
    const ratings1: JurorRating[] = [
      {
        juror: "gemini",
        elicitedInReport: true,
        creditEarned: 1.0,
        deduction: 0.0,
        netScore: 1.0,
        evidenceQuote: "",
        rationale: "",
      },
      {
        juror: "claude",
        elicitedInReport: true,
        creditEarned: 1.0,
        deduction: 0.0,
        netScore: 1.0,
        evidenceQuote: "",
        rationale: "",
      },
      {
        juror: "gpt4o",
        elicitedInReport: false,
        creditEarned: 0.0,
        deduction: 0.0,
        netScore: 0.0,
        evidenceQuote: "",
        rationale: "",
      },
    ];
    expect(computeProtocolBMedian(ratings1).netScore).toBe(1.0);

    // Case 2: [-0.5, 0.0, 0.0] -> median is 0.0
    const ratings2: JurorRating[] = [
      {
        juror: "gemini",
        elicitedInReport: true,
        creditEarned: 0.0,
        deduction: 0.5,
        netScore: -0.5,
        evidenceQuote: "",
        rationale: "",
      },
      {
        juror: "claude",
        elicitedInReport: false,
        creditEarned: 0.0,
        deduction: 0.0,
        netScore: 0.0,
        evidenceQuote: "",
        rationale: "",
      },
      {
        juror: "gpt4o",
        elicitedInReport: false,
        creditEarned: 0.0,
        deduction: 0.0,
        netScore: 0.0,
        evidenceQuote: "",
        rationale: "",
      },
    ];
    expect(computeProtocolBMedian(ratings2).netScore).toBe(0.0);
  });

  it("evaluates bugs with mock 3-model jury panel in evaluateBugsWithLlmJudge", async () => {
    const rubricPath = path.resolve(
      process.cwd(),
      "benchmark",
      "scripts",
      "ground_truth_rubric.json"
    );
    if (!fs.existsSync(rubricPath) || !GROUND_TRUTH_BUGS["TreeValue"]?.length) {
      pending(
        "Skipping benchmark evaluation test: benchmark rubric not present in environment."
      );
      return;
    }

    function createJudgeModel(netScore: number): vscode.LanguageModelChat {
      const jsonResponse = JSON.stringify({
        bug_id: "TV_EQ_NONE",
        elicited_in_report: netScore > 0,
        credit_earned: Math.max(0, netScore),
        deduction: netScore < 0 ? 0.5 : 0.0,
        net_score: netScore,
        evidenceQuote: `Quote for score ${netScore}`,
        rationale: `Rationale for score ${netScore}`,
      });

      return {
        id: "mock-judge",
        name: "Mock Judge",
        vendor: "test",
        family: "test",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({
          text: (async function* () {
            yield jsonResponse;
          })(),
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart(`\`\`\`json\n${jsonResponse}\n\`\`\``);
          })(),
        }),
      };
    }

    // Gemini gives 1.0, Claude gives 0.5, GPT-4o gives 0.5 -> Median should be 0.5
    const jury = {
      gemini: createJudgeModel(1.0),
      claude: createJudgeModel(0.5),
      gpt4o: createJudgeModel(0.5),
    };

    const fuzzRuns = [
      {
        functionName: "fuzz_TreeValue",
        failedTests: 1,
        exceptions: 1,
        generatorName: "NaNofuzz",
      },
    ];

    const results = await evaluateBugsWithLlmJudge(
      jury,
      "TreeValue",
      "Bug report describing TreeValue == None defect",
      fuzzRuns
    );

    expect(results.length).toBeGreaterThan(0);
    const tvBug = results.find((r) => r.bug.id === "TV_EQ_NONE");
    expect(tvBug).toBeDefined();
    // Protocol B median of [1.0, 0.5, 0.5] is 0.5
    expect(tvBug?.netScore).toBe(0.5);
    expect(tvBug?.elicited).toBe(1);
    expect(tvBug?.consensusMethod).toBe("poll_protocol_b_median");
    expect(tvBug?.jurorScores?.gemini?.netScore).toBe(1.0);
    expect(tvBug?.jurorScores?.gemini?.modelInfo?.id).toBe("mock-judge");
    expect(tvBug?.jurorScores?.claude?.netScore).toBe(0.5);
    expect(tvBug?.jurorScores?.claude?.modelInfo?.vendor).toBe("test");
    expect(tvBug?.jurorScores?.gpt4o?.netScore).toBe(0.5);
    expect(tvBug?.jurorScores?.gpt4o?.modelInfo?.name).toBe("Mock Judge");
  });

  it("selectJuryModels reads from nanofuzz.benchmark.juryModels config and matches exact configured models", async () => {
    // Save original selectChatModels if present
    const origSelectChatModels = vscode.lm.selectChatModels;

    const mockModels: vscode.LanguageModelChat[] = [
      {
        id: "claude-haiku-5.5",
        name: "Claude Haiku 5.5",
        vendor: "copilot",
        family: "claude",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
      {
        id: "claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        vendor: "copilot",
        family: "claude",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        vendor: "google",
        family: "gemini",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
      {
        id: "models/gemini-3.8-flash",
        name: "Gemini 3.8 Flash (paid)",
        vendor: "gemini",
        family: "models/gemini-3.8-flash",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
      {
        id: "claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        vendor: "copilot",
        family: "claude-sonnet-5.5",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        vendor: "openai",
        family: "gpt-4o",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        vendor: "copilot",
        family: "gpt-4o-mini",
        version: "1.0",
        maxInputTokens: 100000,
        countTokens: async () => 10,
        sendRequest: async () => ({ text: (async function* () {})(), stream: (async function* () {})() }),
      },
    ];

    Object.defineProperty(vscode.lm, "selectChatModels", {
      value: async () => mockModels,
      configurable: true,
      writable: true,
    });

    try {
      // Default config: ["gemini-3.8-flash", "claude-sonnet-5.5", "gpt-4o-mini"]
      const panel = await selectJuryModels();
      expect(panel.slots?.length).toBe(3);
      expect(panel.slots?.[0].actualModel?.id).toBe("gemini-3.8-flash");
      expect(panel.slots?.[1].actualModel?.id).toBe("claude-sonnet-5.5");
      expect(panel.slots?.[2].actualModel?.id).toBe("gpt-4o-mini");

      // Validating jury models succeeds when all match
      const validated = await validateJuryModels();
      expect(validated.slots?.length).toBe(3);

      // Custom override via Config matching exact user settings
      Config.override("nanofuzz.benchmark.juryModels", [
        "gemini/Gemini-Paid/models/gemini-3.8-flash",
        "claude-sonnet-5.5",
        "gpt-4o-mini",
      ]);
      const byokPanel = await selectJuryModels();
      expect(byokPanel.slots?.[0].requested).toBe("gemini/Gemini-Paid/models/gemini-3.8-flash");
      expect(byokPanel.slots?.[0].actualModel?.id).toBe("models/gemini-3.8-flash");
      expect(byokPanel.slots?.[0].actualModel?.vendor).toBe("gemini");
      expect(byokPanel.slots?.[1].actualModel?.id).toBe("claude-sonnet-5.5");
      expect(byokPanel.slots?.[2].actualModel?.id).toBe("gpt-4o-mini");

      // Custom override with a missing model causes validateJuryModels to throw
      Config.override("nanofuzz.benchmark.juryModels", [
        "gemini/Gemini-Paid/models/gemini-3.8-flash",
        "non-existent-model",
      ]);
      await expectAsync(validateJuryModels()).toBeRejectedWithError(
        /CRITICAL: Jury configuration error/
      );
    } finally {
      Object.defineProperty(vscode.lm, "selectChatModels", {
        value: origSelectChatModels,
        configurable: true,
        writable: true,
      });
      Config.clearOverrides();
    }
  });
});
*/

describe("BenchmarkRunner - Timestamped Directories & Recovery", () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-bench-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it("formatDatestamp generates string in YYYYMMDD_HHMMSS format", () => {
    const ds = formatDatestamp(new Date(2026, 10, 12, 5, 2, 1));
    expect(ds).toBe("20261112_050201");
    expect(/^\d{8}_\d{6}$/.test(ds)).toBe(true);
  });

  it("createRunContext sets up all output subpaths inside the target directory", () => {
    const targetDir = path.join(tempBaseDir, "20261112_050201");
    const ctx = createRunContext(targetDir);

    expect(ctx.runDir).toBe(targetDir);
    expect(ctx.resultsDir).toBe(path.join(targetDir, "results"));
    expect(ctx.reportsDir).toBe(path.join(targetDir, "artifacts"));
    expect(ctx.telemetryDir).toBe(path.join(targetDir, "telemetry"));
    expect(ctx.scoringSheetsDir).toBe(path.join(targetDir, "artifacts"));
    expect(ctx.artifactsDir).toBe(path.join(targetDir, "artifacts"));
    expect(ctx.partsDir).toBe(path.join(targetDir, "results", "parts"));
    expect(ctx.dataCsvPath).toBe(path.join(targetDir, "results", "data.csv"));
    expect(ctx.surveyResponsesCsvPath).toBe(path.join(targetDir, "results", "survey_responses.csv"));
    expect(ctx.stateJsonPath).toBe(path.join(targetDir, "benchmark_state.json"));
    expect(ctx.dashboardPath).toBe(path.join(targetDir, "DASHBOARD.md"));
  });

  it("findLatestUnfinishedRun finds the newest unfinished folder sorted by folder name", () => {
    // 1. Oldest unfinished folder
    const dir1 = path.join(tempBaseDir, "20261110_120000");
    fs.mkdirSync(dir1);
    fs.writeFileSync(
      path.join(dir1, "benchmark_state.json"),
      JSON.stringify([{ participant: "P01", status: "pending" }])
    );

    // 2. Newer unfinished folder
    const dir2 = path.join(tempBaseDir, "20261111_120000");
    fs.mkdirSync(dir2);
    fs.writeFileSync(
      path.join(dir2, "benchmark_state.json"),
      JSON.stringify([{ participant: "P01", status: "incomplete" }])
    );

    // 3. Newest completed folder
    const dir3 = path.join(tempBaseDir, "20261112_120000");
    fs.mkdirSync(dir3);
    fs.writeFileSync(
      path.join(dir3, "benchmark_state.json"),
      JSON.stringify([{ participant: "P01", status: "completed" }])
    );

    // Should pick dir2 (20261111_120000) because dir3 is completed, and dir2 > dir1 alphabetically
    const latestUnfinished = findLatestUnfinishedRun(tempBaseDir);
    expect(latestUnfinished).toBe(dir2);
  });

  it("findLatestUnfinishedRun returns undefined when all runs are completed", () => {
    const dir = path.join(tempBaseDir, "20261112_150000");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "benchmark_state.json"),
      JSON.stringify([
        { participant: "P01", status: "completed" },
        { participant: "P02", status: "completed" },
      ])
    );

    const latest = findLatestUnfinishedRun(tempBaseDir);
    expect(latest).toBeUndefined();
  });

  it("updateLatestSymlink creates and updates a relative symlink to the latest run directory", () => {
    const targetDir = path.join(tempBaseDir, "20261112_050201");
    fs.mkdirSync(targetDir);

    updateLatestSymlink(targetDir, tempBaseDir);

    const symlinkPath = path.join(tempBaseDir, "latest");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe("20261112_050201");
  });

  it("Option 1: executes runSingleBenchmarkSession end-to-end integration smoketest", async () => {
    const targetRepo = path.resolve(process.cwd(), "benchmark", "target");
    if (!fs.existsSync(targetRepo)) {
      pending(
        "Skipping benchmark integration smoketest: benchmark/target not present in environment."
      );
      return;
    }

    const runDir = path.join(tempBaseDir, "20261112_050505");
    const testContext = createRunContext(runDir);
    setActiveRunContext(testContext);

    fs.mkdirSync(testContext.resultsDir, { recursive: true });
    fs.mkdirSync(testContext.telemetryDir, { recursive: true });
    fs.mkdirSync(testContext.scoringSheetsDir, { recursive: true });

    const reportPath = path.join(testContext.resultsDir, "P99.md");
    const testRunSpec: BenchmarkRunSpec = {
      participant: "P99",
      sequence: 99,
      replicate: 1,
      task: "TreeValue",
      engine: "nanofuzz",
      source: "docs",
      targetScope: ["TreeValue"],
      reportFilename: "P99.md",
      reportPath,
    };

    let turnCount = 0;
    const scriptedModel: vscode.LanguageModelChat = {
      id: "mock-gemini-3.8-flash",
      name: "Gemini 3.8 Flash (paid)",
      vendor: "google",
      family: "gemini-3.8-flash",
      version: "1.0",
      maxInputTokens: 100000,
      countTokens: async () => 10,
      sendRequest: async (msgs) => {
        const lastMsg = msgs[msgs.length - 1];
        const lastContent = typeof lastMsg.content === "string" ? lastMsg.content : "";

        // 1. Post-task survey request
        if (lastContent.includes("standardized post-task evaluation survey")) {
          return {
            text: (async function* () {
              yield `\`\`\`json\n${sampleSurveyJson}\n\`\`\``;
            })(),
            stream: (async function* () {
              yield new vscode.LanguageModelTextPart(`\`\`\`json\n${sampleSurveyJson}\n\`\`\``);
            })(),
          };
        }

        // 2. LLM Judge prompt
        if (lastContent.includes("Ground Truth Defect Under Evaluation")) {
          const judgeJson = JSON.stringify({
            bug_id: "TV_EQ_NONE",
            elicited_in_report: true,
            credit_earned: 1.0,
            deduction: 0.0,
            net_score: 1.0,
            evidence_quote: "Found TV_EQ_NONE",
            rationale: "Accurately described",
          });
          return {
            text: (async function* () {
              yield `\`\`\`json\n${judgeJson}\n\`\`\``;
            })(),
            stream: (async function* () {
              yield new vscode.LanguageModelTextPart(`\`\`\`json\n${judgeJson}\n\`\`\``);
            })(),
          };
        }

        // 3. Main multi-turn workflow turns
        turnCount++;
        if (turnCount === 1) {
          // Turn 1: call init
          return {
            text: (async function* () {})(),
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart("call-1", "nanofuzz_findBugs", {
                phase: "init",
              });
            })(),
          };
        } else if (turnCount === 2) {
          // Turn 2: submit invariants and create test harness
          return {
            text: (async function* () {})(),
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart("call-2a", "create_file", {
                filePath: "nanofuzz_harness_TreeValue.py",
                content: "# test harness\ndef fuzz_TreeValue(): pass\n",
              });
              yield new vscode.LanguageModelToolCallPart("call-2b", "nanofuzz_findBugs", {
                phase: "invariants_extracted",
                statePayload: {
                  entrypoints: [
                    {
                      name: "fuzz_TreeValue",
                      filePath: "nanofuzz_harness_TreeValue.py",
                      invariants: ["TreeValue == None raises TypeError"],
                    },
                  ],
                },
              });
            })(),
          };
        } else if (turnCount === 3) {
          // Turn 3: call smoke
          return {
            text: (async function* () {})(),
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart("call-3", "nanofuzz_findBugs", {
                phase: "fuzz_smoke",
                statePayload: {
                  stage: "smoke",
                  functionName: "fuzz_TreeValue",
                },
              });
            })(),
          };
        } else if (turnCount === 4) {
          // Turn 4: call deep
          return {
            text: (async function* () {})(),
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart("call-4", "nanofuzz_findBugs", {
                phase: "fuzz_deep",
                statePayload: {
                  stage: "deep",
                  functionName: "fuzz_TreeValue",
                },
              });
            })(),
          };
        } else if (turnCount === 5) {
          // Turn 5: call contextualize_bugs
          return {
            text: (async function* () {})(),
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart("call-5", "nanofuzz_findBugs", {
                phase: "contextualize_bugs",
              });
            })(),
          };
        } else {
          // Turn 6: write report file and complete
          return {
            text: (async function* () {})(),
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart("call-6", "create_file", {
                filePath: reportPath,
                content:
                  "# Benchmark Evaluation Report: TreeValue\n\n" +
                  "Discovered defect TV_EQ_NONE with exact failure domain x == None.\n" +
                  "A".repeat(600),
              });
              yield new vscode.LanguageModelToolCallPart("call-7", "nanofuzz_findBugs", {
                phase: "complete",
              });
            })(),
          };
        }
      },
    };

    // Run the single benchmark session with laneId: 99
    const sessionRes = await runSingleBenchmarkSession(
      testRunSpec,
      1,
      99,
      undefined,
      scriptedModel
    );

    expect(sessionRes.error).toBeUndefined();
    expect(sessionRes.success).toBe(true);

    // Verify report was created on disk
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.statSync(reportPath).size).toBeGreaterThan(500);

    // Verify scoring sheet was written
    const scoringSheet = path.join(testContext.artifactsDir, "P99", "scoring_sheet_P99.md");
    expect(fs.existsSync(scoringSheet)).toBe(true);
    const sheetContent = fs.readFileSync(scoringSheet, "utf8");
    expect(sheetContent).not.toContain("Gemini slot");
    expect(sheetContent).not.toContain("Claude slot");
    expect(sheetContent).not.toContain("GPT-4o slot");

    // Verify telemetry JSON was written
    const telemetryFile = path.join(testContext.telemetryDir, "P99.telemetry.json");
    expect(fs.existsSync(telemetryFile)).toBe(true);
    const telData = JSON.parse(fs.readFileSync(telemetryFile, "utf8"));
    expect(telData.survey).toBeDefined();
    expect(telData.survey.realistic).toBe(5);
    expect(telData.agentModel).toBeDefined();
    expect(telData.agentModel.id).toBe("mock-gemini-3.8-flash");
    if (telData.juryPanel !== undefined) {
      expect(telData.juryPanel.slots).toBeDefined();
    }

    // Verify data.csv was written with Status = COMPLETED
    expect(fs.existsSync(testContext.dataCsvPath)).toBe(true);
    const dataContent = fs.readFileSync(testContext.dataCsvPath, "utf8");
    expect(dataContent).toContain("P99");
    expect(dataContent).toContain("COMPLETED");

    // Verify survey_responses.csv was written
    expect(fs.existsSync(testContext.surveyResponsesCsvPath)).toBe(true);
    const surveyContent = fs.readFileSync(testContext.surveyResponsesCsvPath, "utf8");
    expect(surveyContent).toContain("P99");

    // Verify participant artifacts were preserved
    const savedHarness = path.join(
      testContext.artifactsDir,
      "P99",
      "nanofuzz_harness_TreeValue.py"
    );
    expect(fs.existsSync(savedHarness)).toBe(true);
    expect(fs.readFileSync(savedHarness, "utf8")).toContain("fuzz_TreeValue");
  });

  it("generates exactly 150 tasks with 15 replicates, 5 tasks, 2 engines, and 1 source (all)", () => {
    const schedule = generateBenchmarkSchedule(15);
    expect(schedule.length).toBe(150);

    const engines = new Set(schedule.map((s) => s.engine));
    expect(Array.from(engines).sort()).toEqual(["hypothesis", "nanofuzz"]);

    const sources = new Set(schedule.map((s) => s.source));
    expect(Array.from(sources)).toEqual(["all"]);

    const tasks = new Set(schedule.map((s) => s.task));
    expect(tasks.size).toBe(5);

    expect(schedule[0].participant).toBe("P001");
    expect(schedule[149].participant).toBe("P150");
  });
});

describe("Dynamic Defect Elicitation & Recursive Provenance Resolution", () => {
  it("resolves multi-step recursive provenance chains without modifying FuzzValueOrigin", () => {
    const leaderboardProvenance = new Map<number, string>();

    // 1. Seed originated by UserInputGenerator at tick 1
    const userGenOrigin: FuzzValueOrigin = {
      type: "generator",
      generator: "UserInputGenerator",
      fnName: "fuzz_TreeValueGenerator",
    };
    const userProv = resolveFullProvenance(userGenOrigin, leaderboardProvenance);
    expect(userProv).toBe("CustomGen[fuzz_TreeValueGenerator]");
    leaderboardProvenance.set(1, userProv);

    // 2. Transformer applied to seed at tick 2
    const transformerOrigin: FuzzValueOrigin = {
      type: "transformer",
      transformer: "fuzz_TreeValueTransformer",
      basis: {
        value: [],
        source: userGenOrigin,
      },
    };
    const transProv = resolveFullProvenance(transformerOrigin, leaderboardProvenance);
    expect(transProv).toBe(
      "CustomGen[fuzz_TreeValueGenerator]->Transformer[fuzz_TreeValueTransformer]"
    );
    leaderboardProvenance.set(2, transProv);

    // 3. Mutation 1 applied to transformed input at tick 10 (pointing to tick 2)
    const mut1Origin: FuzzValueOrigin = {
      type: "generator",
      generator: "MutationInputGenerator",
      tick: 2,
      steps: {
        taken: 1,
        max: 2,
        mode: "mutate",
        mutators: ["int_negate"],
      },
    };
    const mut1Prov = resolveFullProvenance(mut1Origin, leaderboardProvenance);
    expect(mut1Prov).toBe(
      "CustomGen[fuzz_TreeValueGenerator]->Transformer[fuzz_TreeValueTransformer]->Mutation[int_negate]"
    );
    leaderboardProvenance.set(10, mut1Prov);

    // 4. Mutation 2 applied to Mutation 1 at tick 25 (pointing to tick 10)
    const mut2Origin: FuzzValueOrigin = {
      type: "generator",
      generator: "MutationInputGenerator",
      tick: 10,
      steps: {
        taken: 1,
        max: 2,
        mode: "mutate",
        mutators: ["byte_corrupt"],
      },
    };
    const mut2Prov = resolveFullProvenance(mut2Origin, leaderboardProvenance);
    expect(mut2Prov).toBe(
      "CustomGen[fuzz_TreeValueGenerator]->Transformer[fuzz_TreeValueTransformer]->Mutation[int_negate]->Mutation[byte_corrupt]"
    );
  });

  it("parses elicited and detected bug entries from elicited_bugs.json correctly upgrading detection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-elicitation-test-"));
    const logPath = path.join(tempDir, "elicited_bugs.json");

    try {
      // Event 1: TV_EQ_NONE elicited but undetected
      // Event 2: NORM_ZERO_DIV elicited and detected
      // Event 3: TV_EQ_NONE elicited again, this time detected
      const lines = [
        JSON.stringify({
          bug_id: "TV_EQ_NONE",
          elicited: 1,
          detected: 0,
          generator: "RandomInputGenerator",
          args: ["1", "None"],
        }),
        JSON.stringify({
          bug_id: "NORM_ZERO_DIV",
          elicited: 1,
          detected: 1,
          detection_type: "ZeroDivisionError",
          generator: "SeedInput",
          args: [0, 0],
        }),
        JSON.stringify({
          bug_id: "TV_EQ_NONE",
          elicited: 1,
          detected: 1,
          detection_type: "TypeError",
          generator: "Mutation[number-boundary]",
          args: ["2", "None"],
        }),
      ];
      fs.writeFileSync(logPath, lines.join("\n"), "utf8");

      const elicitedMap = new Map<
        string,
        { bug_id: string; elicited: number; detected: number; detection_type?: string; generator: string; args: string[] }
      >();

      const rawLines = fs.readFileSync(logPath, "utf8").split("\n");
      for (const line of rawLines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.bug_id) {
          const prev = elicitedMap.get(entry.bug_id);
          const wasDetected = Number(entry.detected) === 1 ? 1 : 0;
          if (!prev) {
            elicitedMap.set(entry.bug_id, {
              bug_id: entry.bug_id,
              elicited: 1,
              detected: wasDetected,
              detection_type: entry.detection_type,
              generator: entry.generator || "None",
              args: entry.args || [],
            });
          } else if (wasDetected && !prev.detected) {
            prev.detected = 1;
            prev.detection_type = entry.detection_type;
          }
        }
      }

      // Check NORM_ZERO_DIV: elicited = 1, detected = 1
      const normBug = elicitedMap.get("NORM_ZERO_DIV");
      expect(normBug).toBeDefined();
      expect(normBug?.elicited).toBe(1);
      expect(normBug?.detected).toBe(1);
      expect(normBug?.detection_type).toBe("ZeroDivisionError");
      expect(normBug?.generator).toBe("SeedInput");

      // Check TV_EQ_NONE: elicited = 1, upgraded detected from 0 to 1
      const tvBug = elicitedMap.get("TV_EQ_NONE");
      expect(tvBug).toBeDefined();
      expect(tvBug?.elicited).toBe(1);
      expect(tvBug?.detected).toBe(1);
      expect(tvBug?.detection_type).toBe("TypeError");
      expect(tvBug?.generator).toBe("RandomInputGenerator");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

