import * as path from "node:path";
import * as vscode from "vscode";
import * as Config from "../../Config";
import * as ParserAdapter from "./ParserAdapter";
import {
  ListTargetsTool,
  FuzzFunctionTool,
  registerLmTools,
  resolveMatchingModel,
} from "./VscodeLmAdapter";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

function getTextContent(result: vscode.LanguageModelToolResult): string {
  const first = result.content[0];
  if (
    typeof first === "object" &&
    first !== null &&
    "value" in first &&
    typeof first.value === "string"
  ) {
    return first.value;
  }
  return "";
}

describe("VscodeLmAdapter", () => {
  const tsFixture = path.resolve(
    __dirname,
    "../test_fixtures/Fuzzer.testfixtures.ts"
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

  it("list: prepare", () => {
    const tool = new ListTargetsTool();
    const prepared = tool.prepareInvocation({
      input: { filePath: tsFixture },
    });
    expect(prepared).toBeDefined();
    if (prepared && !("then" in prepared)) {
      expect(prepared.invocationMessage).toContain("NaNofuzz");
      expect(prepared.invocationMessage).toContain(tsFixture);
    }
  });

  it("list: invoke", async () => {
    const tool = new ListTargetsTool();
    const token = new vscode.CancellationTokenSource().token;
    const result = await tool.invoke(
      {
        input: { filePath: tsFixture },
        toolInvocationToken: undefined,
      },
      token
    );

    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(getTextContent(result)).toContain("testStandardVoidReturnUndefined");
  });

  it("fuzz: prepare", () => {
    const tool = new FuzzFunctionTool();
    const prepared = tool.prepareInvocation({
      input: {
        filePath: tsFixture,
        functionName: "testStandardVoidReturnUndefined",
      },
    });

    expect(prepared).toBeDefined();
    if (prepared && !("then" in prepared)) {
      expect(prepared.invocationMessage).toContain(
        "testStandardVoidReturnUndefined"
      );
      expect(prepared.confirmationMessages).toBeDefined();
      expect(prepared.confirmationMessages?.message).toContain("NaNofuzz");
    }
  });

  it("fuzz: invoke pass", async () => {
    const tool = new FuzzFunctionTool();
    const token = new vscode.CancellationTokenSource().token;
    const result = await tool.invoke(
      {
        input: {
          filePath: tsFixture,
          functionName: "testStandardVoidReturnUndefined",
          maxTests: 10,
          timeoutMs: 2000,
          model: "gemini-3.7-flash",
          vendor: "google",
        },
        toolInvocationToken: undefined,
      },
      token
    );

    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(getTextContent(result)).toContain("✅ NaNofuzz Passed");
  });

  it("fuzz: invoke fail", async () => {
    const tool = new FuzzFunctionTool();
    const token = new vscode.CancellationTokenSource().token;
    const result = await tool.invoke(
      {
        input: {
          filePath: tsFixture,
          functionName: "testStandardVoidReturnException",
          maxTests: 5,
          timeoutMs: 3000,
        },
        toolInvocationToken: undefined,
      },
      token
    );

    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(getTextContent(result)).toContain(
      "❌ NaNofuzz Counterexample Discovered"
    );
  });

  it("fuzz: invoke with concrete seed inputs", async () => {
    const tool = new FuzzFunctionTool();
    const token = new vscode.CancellationTokenSource().token;
    const result = await tool.invoke(
      {
        input: {
          filePath: tsFixture,
          functionName: "testAsyncGreeting",
          inputs: [{ name: "boom" }],
          maxTests: 1,
          timeoutMs: 3000,
        },
        toolInvocationToken: undefined,
      },
      token
    );

    expect(result).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(getTextContent(result)).toContain(
      "❌ NaNofuzz Counterexample Discovered"
    );
    expect(getTextContent(result)).toContain("boom");
  });

  it("resolveMatchingModel: exact and fuzzy", async () => {
    const res1 = await resolveMatchingModel("google", "gemini-3.7-flash");
    expect(res1.vendor).toBe("google");
    expect(res1.model).toBe("gemini-3.7-flash");

    const res2 = await resolveMatchingModel(
      "fictional-corp",
      "gemini-3.7-flash"
    );
    expect(res2.model).toBe("gemini-3.7-flash");

    const res3 = await resolveMatchingModel("copilot", "fictional-model-999");
    expect(res3.vendor).toBe("copilot");
    expect(res3.model).toBeDefined();
  });

  it("register: success", () => {
    const subscriptions: vscode.Disposable[] = [];
    const disposables = registerLmTools({ subscriptions });
    expect(disposables.length).toBe(2);
    expect(subscriptions.length).toBe(2);
  });
});
