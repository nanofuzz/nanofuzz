import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Config from "../Config";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import {
  listTargets,
  runFuzz,
  resolveFilePath,
  getDefaultFuzzOptions,
  normalizeAgentFuzzOptions,
  synthesizeReproducer,
  buildSummaryMarkdown,
  formatLineRanges,
  getToolName,
  synthesizeValidator,
  synthesizeTransformer,
  synthesizeUserGenerator,
  AgentFuzzOptions,
} from "./Agent";
import { FuzzTestResult } from "../fuzzer/Types";
import { FuzzConfigStore } from "../fuzzer/FuzzConfigStore";

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

  beforeAll(async () => {
    await ParserAdapter.init();
  });

  beforeEach(() => {
    Config.clearOverrides();
  });

  afterEach(() => {
    Config.clearOverrides();
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

    const asyncFn = fnMap.get("testAsyncGreeting");
    expect(asyncFn).toBeDefined();
    expect(asyncFn!.isAsync).toBe(true);
    expect(asyncFn!.signature).toContain("async function testAsyncGreeting");

    expect(voidFn.validatorTemplate).toBeDefined();
    expect(voidFn.validatorTemplate).toContain(
      'import { FuzzTestResult } from "@nanofuzz/runtime";'
    );
    expect(voidFn.validatorTemplate).toContain(
      'export function testStandardVoidReturnUndefinedValidator(r: FuzzTestResult): "pass" | "fail" | "unknown"'
    );
    expect(voidFn.validatorTemplate).toContain("const _x: number = r.in[0];");

    expect(voidFn.transformerTemplate).toBeDefined();
    expect(voidFn.transformerTemplate).toContain(
      'import { assume, UnsatisfiedAssumption } from "@nanofuzz/runtime";'
    );
    expect(voidFn.transformerTemplate).toContain(
      "export function testStandardVoidReturnUndefinedTransformer"
    );

    expect(voidFn.generatorTemplate).toBeDefined();
    expect(voidFn.generatorTemplate).toContain(
      "export function testStandardVoidReturnUndefinedGenerator(prng: () => number): Parameters<typeof testStandardVoidReturnUndefined> | undefined"
    );
    expect(voidFn.generatorTemplate).toContain("return [");
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
    expect(greetingFn.validatorTemplate).toBeDefined();
    expect(greetingFn.validatorTemplate).toContain(
      "from nanofuzz_runtime import FuzzTestResult"
    );
    expect(greetingFn.validatorTemplate).toContain(
      'def greetingValidator1(r: FuzzTestResult) -> Literal["pass", "fail", "unknown"]:'
    );
    expect(greetingFn.validatorTemplate).toContain("name: a = r['in'][0]");

    expect(greetingFn.transformerTemplate).toBeDefined();
    expect(greetingFn.transformerTemplate).toContain(
      "from nanofuzz_runtime import UnsatisfiedAssumption, assume"
    );
    expect(greetingFn.transformerTemplate).toContain("def greetingTransformer");

    expect(greetingFn.generatorTemplate).toBeDefined();
    expect(greetingFn.generatorTemplate).toContain(
      "from typing import Callable"
    );
    expect(greetingFn.generatorTemplate).toContain(
      "def greetingGenerator(prng: Callable[[], float]) -> tuple["
    );

    const asyncFn = fnMap.get("async_greeting");
    expect(asyncFn).toBeDefined();
    expect(asyncFn!.isAsync).toBe(true);
    expect(asyncFn!.signature).toContain("async def async_greeting");
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
    expect(dft.generators.UserInputGenerator.enabled).toBe(true);
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

  it("runFuzz: ts async function", async () => {
    const result = await runFuzz({
      filePath: tsFixture,
      functionName: "testAsyncGreeting",
      maxTests: 5,
      suiteTimeout: 3000,
    });

    expect(result.status).toBe("success");
    expect(result.functionName).toBe("testAsyncGreeting");
    expect(result.language).toBe("typescript");
    expect(result.totalTests).toBeGreaterThan(0);
  });

  it("runFuzz: py async function", async () => {
    const result = await runFuzz({
      filePath: pyFixture,
      functionName: "async_greeting",
      maxTests: 5,
      suiteTimeout: 3000,
    });

    expect(result.status).toBe("success");
    expect(result.functionName).toBe("async_greeting");
    expect(result.language).toBe("python");
    expect(result.totalTests).toBeGreaterThan(0);
  });

  it("runFuzz: with injected concrete inputs (object and array)", async () => {
    // 1. Injected failing object input
    const resultObj = await runFuzz({
      filePath: tsFixture,
      functionName: "testStandardVoidReturnException",
      inputs: [{ _x: 42 }],
      maxTests: 1,
      suiteTimeout: 3000,
    });

    expect(resultObj.status).toBe("counterexample_found");
    expect(resultObj.exceptions).toBeGreaterThan(0);
    expect(resultObj.primaryCounterexample?.input[0].value === 42).toBeTrue();

    // 2. Injected failing array positional input
    const resultArr = await runFuzz({
      filePath: tsFixture,
      functionName: "testStandardVoidReturnException",
      inputs: [[42]],
      maxTests: 1,
      suiteTimeout: 3000,
    });

    expect(resultArr.status).toBe("counterexample_found");
    expect(resultArr.primaryCounterexample?.input[0].value === 42).toBeTrue();
  });

  it("runFuzz: with expected output and expected exception tests", async () => {
    // 1. Expected output matches actual output -> passes
    const passRes = await runFuzz({
      filePath: tsFixture,
      functionName: "testAsyncGreeting",
      tests: [{ input: { name: "Alice" }, expectedOutput: "Hello Alice" }],
      maxTests: 1,
      suiteTimeout: 3000,
    });
    expect(passRes.status).toBe("success");
    expect(passRes.totalTests).toBeGreaterThan(0);

    // 2. Expected output mismatch -> counterexample found and direct reproducer synthesized
    const mismatchRes = await runFuzz({
      filePath: tsFixture,
      functionName: "testAsyncGreeting",
      tests: [{ input: { name: "Alice" }, expectedOutput: "Goodbye Alice" }],
      maxTests: 1,
      suiteTimeout: 3000,
    });
    expect(mismatchRes.status).toBe("counterexample_found");
    expect(["badValue", "disagree"]).toContain(
      mismatchRes.primaryCounterexample?.category ?? "ok"
    );
    expect(mismatchRes.summaryText).toContain("Actual Output");
    expect(mismatchRes.summaryText).toContain("Hello Alice");
    expect(mismatchRes.summaryText).toContain("Expected Output");
    expect(mismatchRes.summaryText).toContain("Goodbye Alice");
    expect(mismatchRes.reproducerCode).toContain("Goodbye Alice");

    // 3. Expected exception matches thrown exception -> passes
    const expectExcPass = await runFuzz({
      filePath: tsFixture,
      functionName: "testAsyncGreeting",
      tests: [{ input: { name: "boom" }, expectedException: true }],
      maxTests: 1,
      suiteTimeout: 3000,
    });
    expect(expectExcPass.status).toBe("success");
  });

  it("runFuzz: automatically loads pinned tests and options from companion .nano.json5", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-nano-test-"));
    try {
      const tsFile = path.join(tmpDir, "calculator.ts");
      fs.writeFileSync(
        tsFile,
        `export function add(a: number, b: number): number {
  if (a === 99 && b === 99) throw new Error("bad combo");
  return a + b;
}`
      );

      // Save a pinned test that triggers the exception
      FuzzConfigStore.updatePinnedTest(tsFile, "add", {
        input: [
          { name: "a", offset: 0, value: 99, origin: { type: "user" } },
          { name: "b", offset: 1, value: 99, origin: { type: "user" } },
        ],
        output: [],
        pinned: true,
      });

      const res = await runFuzz({
        filePath: tsFile,
        functionName: "add",
        maxTests: 1,
        suiteTimeout: 3000,
      });

      expect(res.status).toBe("counterexample_found");
      expect(res.primaryCounterexample?.category).toBe("exception");
      expect(res.primaryCounterexample?.input[0].value === 99).toBe(true);
      expect(res.primaryCounterexample?.input[1].value === 99).toBe(true);
    } finally {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
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

  it("synthesis: generates validator, transformer, and generator templates for targets", async () => {
    const list = await listTargets(tsFixture);
    const targetFn = list.functions.find(
      (f) => f.name === "testStandardVoidReturnUndefined"
    );
    expect(targetFn).toBeDefined();
    expect(targetFn?.validatorTemplate).toContain(
      "testStandardVoidReturnUndefinedValidator"
    );
    expect(targetFn?.transformerTemplate).toContain(
      "testStandardVoidReturnUndefinedTransformer"
    );
    expect(targetFn?.generatorTemplate).toContain(
      "testStandardVoidReturnUndefinedGenerator"
    );

    const program = ProgramFactory.fromFile(tsFixture);
    const fnDef = program.functions["testStandardVoidReturnUndefined"];
    const valSkel = synthesizeValidator(fnDef, "typescript", [
      "testStandardVoidReturnUndefinedValidator",
    ]);
    expect(valSkel.name).toBe("testStandardVoidReturnUndefinedValidator1");
    expect(valSkel.skeleton).toContain(
      "testStandardVoidReturnUndefinedValidator1"
    );
    expect(valSkel.fullTemplate).toContain(
      'import { FuzzTestResult } from "@nanofuzz/runtime";'
    );

    const transSkel = synthesizeTransformer(fnDef, "typescript", [
      "testStandardVoidReturnUndefinedTransformer",
    ]);
    expect(transSkel.name).toBe("testStandardVoidReturnUndefinedTransformer1");
    expect(transSkel.skeleton).toContain(
      "testStandardVoidReturnUndefinedTransformer1"
    );

    const genSkel = synthesizeUserGenerator(fnDef, "typescript", [
      "testStandardVoidReturnUndefinedGenerator",
    ]);
    expect(genSkel.name).toBe("testStandardVoidReturnUndefinedGenerator1");
    expect(genSkel.skeleton).toContain(
      "testStandardVoidReturnUndefinedGenerator1"
    );
  });

  it("formatLineRanges: formats individual and grouped lines", () => {
    expect(formatLineRanges([])).toBe("");
    expect(formatLineRanges([5])).toBe("5");
    expect(formatLineRanges([1, 2, 3, 5, 8, 9, 10])).toBe("1-3, 5, 8-10");
    expect(formatLineRanges([10, 2, 1, 3, 9, 8, 5])).toBe("1-3, 5, 8-10");
  });

  it("summary: coverage details including uncovered and partially covered lines", () => {
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
      coverage: {
        statementsTotal: 20,
        statementsCovered: 15,
        statementCoveragePercent: 75,
        branchesTotal: 4,
        branchesCovered: 3,
        branchCoveragePercent: 75,
        functionsTotal: 2,
        functionsCovered: 2,
        functionCoveragePercent: 100,
        uncoveredLinesByFile: {
          [tsFixture]: [12, 13, 14, 25, 30],
        },
        partiallyCoveredLinesByFile: {
          [tsFixture]: [8, 15],
        },
      },
    });

    expect(summary).toContain("Code Coverage Summary");
    expect(summary).toContain("Statement Coverage: **75%**");
    expect(summary).toContain("- **Uncovered Lines**:");
    expect(summary).toContain("12-14, 25, 30");
    expect(summary).toContain("- **Partially Covered Lines**:");
    expect(summary).toContain("8, 15");
  });
});
