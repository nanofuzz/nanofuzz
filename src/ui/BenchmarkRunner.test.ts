import * as vscode from "vscode";
import {
  collectPostTaskSurvey,
  BenchmarkRunSpec,
} from "./BenchmarkRunner";

describe("BenchmarkRunner - collectPostTaskSurvey", () => {
  const dummyRun: BenchmarkRunSpec = {
    participant: "P99",
    lane: 1,
    sequence: 99,
    replicate: 1,
    task: "TreeValue",
    engine: "nanofuzz",
    source: "docs",
    reportFilename: "P99.md",
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
