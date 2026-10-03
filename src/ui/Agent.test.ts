import * as path from "node:path";
import * as Config from "../Config";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import {
  listTargets,
  runFuzz,
  resolveFilePath,
  getDefaultFuzzOptions,
  normalizeAgentFuzzOptions,
  synthesizeReproducer,
  buildSummaryMarkdown,
  getToolName,
  AgentFuzzOptions,
} from "./Agent";
import { FuzzTestResult } from "../fuzzer/Types";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

describe("Agent", () => {
  const tsFixture = path.resolve(
    __dirname,
    "../fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
  );
  const pyFixture = path.resolve(
    __dirname,
    "../fuzzer/test_fixtures/Fuzzer.testfixtures.py"
  );
  const originalName = Config.get("nanofuzz.name", "NaNofuzz");

  beforeAll(async () => {
    await ParserAdapter.init();
  });

  afterEach(() => {
    Config.override("nanofuzz.name", originalName);
  });

  it("listTargets: ts", async () => {
    const result = await listTargets(tsFixture);
    expect(result.language).toBe("typescript");
    expect(result.functions.length).toBeGreaterThan(0);

    const fnMap = new Map(result.functions.map((f) => [f.name, f]));
    expect(fnMap.has("testStandardVoidReturnUndefined")).toBe(true);

    const voidFn = fnMap.get("testStandardVoidReturnUndefined")!;
    expect(voidFn.isVoid).toBe(true);
    expect(voidFn.args.length).toBe(1);
    expect(voidFn.args[0].name).toBe("_x");
    expect(voidFn.args[0].type).toBe("number");
    expect(voidFn.signature).toContain(
      "function testStandardVoidReturnUndefined"
    );

    const changeInputFn = fnMap.get("testChangeInput");
    expect(changeInputFn).toBeDefined();
    expect(changeInputFn!.args.length).toBe(1);
    expect(changeInputFn!.args[0].name).toBe("obj");
  });

  it("listTargets: py", async () => {
    const result = await listTargets(pyFixture);
    expect(result.language).toBe("python");
    expect(result.functions.length).toBeGreaterThan(0);

    const fnMap = new Map(result.functions.map((f) => [f.name, f]));
    expect(fnMap.has("greeting")).toBe(true);
    expect(fnMap.has("throws")).toBe(true);

    const greetingFn = fnMap.get("greeting")!;
    expect(greetingFn.args.length).toBe(1);
    expect(greetingFn.args[0].name).toBe("name");
    expect(greetingFn.signature).toContain("def greeting(name: a)");
  });

  it("listTargets: missing file", async () => {
    await expectAsync(
      listTargets("/path/to/nonexistent/file.ts")
    ).toBeRejectedWithError(/does not exist/);
  });

  it("getToolName: dynamic", () => {
    Config.override("nanofuzz.name", "CustomFuzzBot");
    expect(getToolName()).toBe("CustomFuzzBot");
  });

  it("summary: dynamic tool name", () => {
    Config.override("nanofuzz.name", "SuperFuzz");
    const summary = buildSummaryMarkdown({
      status: "success",
      filePath: tsFixture,
      functionName: "testStandardVoidReturnUndefined",
      language: "typescript",
      toolVersion: "SuperFuzz v1.0.0",
      totalTests: 10,
      passedTests: 10,
      failedTests: 0,
      erroredTests: 0,
      timeouts: 0,
      exceptions: 0,
      counterexamples: [],
    });
    expect(summary).toContain("SuperFuzz Passed");
  });

  it("options: defaults", () => {
    const dft = getDefaultFuzzOptions();
    expect(dft.maxTests).toBeGreaterThan(0);
    expect(dft.suiteTimeout).toBeGreaterThan(0);
    expect(dft.generators.RandomInputGenerator.enabled).toBe(true);
    expect(dft.generators.AiInputGenerator.enabled).toBe(false);
  });

  it("options: normalize", () => {
    const custom: AgentFuzzOptions = {
      filePath: tsFixture,
      functionName: "testStandardVoidReturnUndefined",
      maxTests: 25,
      fnTimeout: 50,
      suiteTimeout: 1000,
    };
    const normalized = normalizeAgentFuzzOptions(custom);
    expect(normalized.maxTests).toBe(25);
    expect(normalized.fnTimeout).toBe(50);
    expect(normalized.suiteTimeout).toBe(1000);
    expect(normalized.useImplicit).toBe(true);
  });

  it("reproducer: jest output", () => {
    const dummyFailure: FuzzTestResult = {
      pinned: true,
      inputGenerated: {
        tick: 0,
        value: [{ tag: "ArgValueTypeWrapped", value: 42 }],
        source: { type: "user" },
      },
      input: [
        {
          name: "x",
          offset: 0,
          value: 42,
          origin: { type: "user" },
        },
      ],
      output: [],
      exception: true,
      exceptionMessage: "Boom",
      timeout: false,
      passedImplicit: "fail",
      passedHuman: "unknown",
      passedValidator: "unknown",
      passedValidators: [],
      harnessErrors: [],
      timers: { gen: 0, transform: 0, run: 1 },
      category: "exception",
      interestingReasons: [],
    };

    const code = synthesizeReproducer(
      tsFixture,
      "testStandardVoidReturnException",
      dummyFailure
    );

    expect(code).toBeDefined();
    expect(code).toContain("describe(");
    expect(code).toContain("testStandardVoidReturnException");
    expect(code).toContain("it(");
  });

  it("runFuzz: ts pass", async () => {
    const result = await runFuzz({
      filePath: tsFixture,
      functionName: "testStandardVoidReturnUndefined",
      maxTests: 10,
      suiteTimeout: 2000,
    });

    expect(result.status).toBe("success");
    expect(result.functionName).toBe("testStandardVoidReturnUndefined");
    expect(result.language).toBe("typescript");
    expect(result.totalTests).toBeGreaterThan(0);
    expect(result.failedTests).toBe(0);
    expect(result.erroredTests).toBe(0);
    expect(result.counterexamples.length).toBe(0);
    expect(result.summaryText).toContain("✅ NaNofuzz Passed");
  });

  it("runFuzz: ts exception", async () => {
    const result = await runFuzz({
      filePath: tsFixture,
      functionName: "testStandardVoidReturnException",
      maxTests: 5,
      suiteTimeout: 3000,
    });

    expect(result.status).toBe("counterexample_found");
    expect(result.failedTests).toBeGreaterThan(0);
    expect(result.exceptions).toBeGreaterThan(0);
    expect(result.counterexamples.length).toBeGreaterThan(0);
    expect(result.primaryCounterexample).toBeDefined();
    expect(result.primaryCounterexample!.exception).toBe(true);
    expect(result.reproducerCode).toBeDefined();
    expect(result.reproducerCode).toContain("testStandardVoidReturnException");
    expect(result.summaryText).toContain(
      "❌ NaNofuzz Counterexample Discovered"
    );
  });

  it("runFuzz: py exception", async () => {
    const result = await runFuzz({
      filePath: pyFixture,
      functionName: "throws",
      maxTests: 10,
      suiteTimeout: 4000,
    });

    expect(result.status).toBe("counterexample_found");
    expect(result.language).toBe("python");
    expect(result.failedTests).toBeGreaterThan(0);
    expect(result.exceptions).toBeGreaterThan(0);
    expect(result.counterexamples.length).toBeGreaterThan(0);
    expect(result.reproducerCode).toBeDefined();
    expect(result.summaryText).toContain(
      "❌ NaNofuzz Counterexample Discovered"
    );
  });

  it("runFuzz: cancel", async () => {
    let cancelCalled = false;
    const result = await runFuzz(
      {
        filePath: tsFixture,
        functionName: "testStandardVoidReturnUndefined",
        maxTests: 1000,
        suiteTimeout: 5000,
      },
      () => {
        cancelCalled = true;
        return true;
      }
    );

    expect(cancelCalled).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.summaryText).toContain("Cancelled");
  });

  it("runFuzz: error", async () => {
    const result = await runFuzz({
      filePath: tsFixture,
      functionName: "nonexistentFunction_12345",
      maxTests: 5,
    });

    expect(result.status).toBe("error");
    expect(result.summaryText).toContain("❌ NaNofuzz Error");
  });

  it("summary: diagnostics guidance", () => {
    const summary = buildSummaryMarkdown({
      status: "success",
      filePath: tsFixture,
      functionName: "testFn",
      language: "typescript",
      toolVersion: "NaNofuzz v0.4.0",
      totalTests: 10,
      passedTests: 10,
      failedTests: 0,
      erroredTests: 0,
      timeouts: 0,
      exceptions: 0,
      counterexamples: [],
      diagnostics: [
        "AI input generation is enabled, but no AI model provider is configured.",
      ],
    });

    expect(summary).toContain("Diagnostics & Guidance");
    expect(summary).toContain("AI input generation is enabled");
  });

  it("summary: generators and origin", () => {
    const summary = buildSummaryMarkdown({
      status: "counterexample_found",
      filePath: tsFixture,
      functionName: "testFn",
      language: "typescript",
      toolVersion: "NaNofuzz v0.4.0",
      totalTests: 100,
      passedTests: 99,
      failedTests: 1,
      erroredTests: 0,
      timeouts: 0,
      exceptions: 0,
      primaryCounterexample: {
        input: [{ name: "x", offset: 0, value: 42 }],
        category: "badValue",
        exception: false,
        timeout: false,
        passedImplicit: "fail",
        passedHuman: "unknown",
        passedValidator: "unknown",
        shrunk: false,
        origin: "AI (copilot)",
      },
      counterexamples: [],
      generators: {
        aiInputs: 20,
        aiQueriesSent: 1,
        mutationInputs: 30,
        randomInputs: 50,
      },
    });

    expect(summary).toContain("Generator Breakdown");
    expect(summary).toContain("AI Generator");
    expect(summary).toContain("Input Source");
    expect(summary).toContain("AI (copilot)");
  });

  it("runFuzz: enableCopilotAi with custom vendor and model", async () => {
    Config.override("nanofuzz.ai.provider", "anthropic");
    Config.override("nanofuzz.ai.model", "claude-3-opus");
    Config.override("nanofuzz.ai.vendor", "anthropic");

    const result = await runFuzz({
      filePath: tsFixture,
      functionName: "testStandardVoidReturnUndefined",
      maxTests: 5,
      suiteTimeout: 2000,
      enableCopilotAi: true,
      model: "gemini-3.7-flash",
      vendor: "google",
    });

    expect(result.status).toBe("success");
    expect(Config.get("nanofuzz.ai.provider", "disabled")).toBe("anthropic");
    expect(Config.get("nanofuzz.ai.model", "")).toBe("claude-3-opus");
    expect(Config.get("nanofuzz.ai.vendor", "")).toBe("anthropic");
  });

  it("resolveFilePath: relative and file URI", () => {
    const abs = resolveFilePath(tsFixture);
    expect(abs).toBe(tsFixture);

    const rel = resolveFilePath(
      "src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    expect(rel).toBe(tsFixture);

    const fileUri = resolveFilePath(`file://${tsFixture}`);
    expect(fileUri).toBe(tsFixture);
  });

  it("llm: copilot provider config", () => {
    Config.override("nanofuzz.ai.provider", "copilot");
    expect(LlmAdapter.isConfigured()).toBe(true);
    const adapter = new LlmAdapter();
    expect(adapter.id).toContain("v=copilot");
    expect(LlmAdapter.getMaxOutputTokens()).toBe(4096);
  });
});
