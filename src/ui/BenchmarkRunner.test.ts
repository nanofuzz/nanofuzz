import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  collectPostTaskSurvey,
  computeProtocolBMedian,
  evaluateBugsWithLlmJudge,
  findLatestUnfinishedRun,
  createRunContext,
  formatDatestamp,
  updateLatestSymlink,
  BenchmarkRunSpec,
  JurorRating,
} from "./BenchmarkRunner";

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

  const sampleSurveyJson = JSON.stringify({
    realistic: 5,
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
    expect(tvBug?.jurorScores?.claude?.netScore).toBe(0.5);
    expect(tvBug?.jurorScores?.gpt4o?.netScore).toBe(0.5);
  });
});

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

    expect(ctx.resultsDir).toBe(targetDir);
    expect(ctx.telemetryDir).toBe(path.join(targetDir, "telemetry"));
    expect(ctx.scoringSheetsDir).toBe(path.join(targetDir, "scoring_sheets"));
    expect(ctx.dataCsvPath).toBe(path.join(targetDir, "data.csv"));
    expect(ctx.surveyResponsesCsvPath).toBe(path.join(targetDir, "survey_responses.csv"));
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
});
