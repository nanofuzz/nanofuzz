import { test, expect } from "@playwright/test";
import * as path from "path";
import { FuzzPanelTestServer } from "./FuzzPanelWebviewHarness";
import * as fp from "./FuzzPanelController";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import * as JSONN from "../Jsonn";
import { FuzzPanelFuzzRunMessage } from "./FuzzPanelController";

function createMockResults(count: number, startIdx = 0): any {
  const results = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    results.push({
      category: "ok",
      input: [
        {
          name: "a",
          offset: 0,
          value: idx,
          origin: { type: "generator", generator: "RandomInputGenerator" },
        },
      ],
      output: [{ value: idx * 2 }],
      passedImplicit: true,
      passedHuman: true,
      passedValidator: "pass",
      passedValidators: [],
      pinned: false,
    });
  }

  return {
    toolVersion: "0.4.0",
    results,
    interesting: {
      inputs: [],
    },
    stats: {
      startTime: 0,
      stopTime: 100,
      tests: results.length,
      dupes: 0,
      elapsedTime: 100,
      stopReason: "maxTests",
      timers: {
        total: 100,
        compile: 0,
        instrument: 0,
        put: 80,
        val: 10,
        gen: 10,
        transform: 0,
        measure: 0,
      },
      counters: {
        testingRuns: 1,
        inputsGenerated: results.length,
        dupesGenerated: 0,
        inputsInjected: 0,
        erroredTests: 0,
        passedTests: results.length,
        inputsSkipped: 0,
        failedTests: 0,
      },
      generators: {
        RandomInputGenerator: {
          counters: { inputsGenerated: results.length, dupesGenerated: 0 },
          timers: { gen: 10 },
        },
        MutationInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { gen: 0 },
        },
        AiInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { gen: 0 },
        },
        UserInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0 },
          timers: { gen: 0 },
        },
      },
      outcomes: {
        categories: {
          ok: results.length,
          failure: 0,
          timeout: 0,
          exception: 0,
          badValue: 0,
          disagree: 0,
          skip: 0,
        },
      },
      measures: {},
    },
  };
}

test.describe("FuzzPanel Webview End-to-End Flow", () => {
  let server: FuzzPanelTestServer;
  let serverUrl: string;
  let panel: any;
  let mockWebviewPanel: any;
  let currentHtml = "";

  test.beforeEach(async () => {
    const testFile = path.resolve(
      "./src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const pgm = ProgramFactory.fromFile(testFile);
    const fnDef = pgm.functions["testChangeInput"];

    const mockTester = {
      state: "init",
      env: {
        function: fnDef,
        options: fp.getDefaultFuzzOptions(),
        validators: [],
        transformers: [],
        userGenerators: [],
      },
      workerCount: 1,
      engine: "v2",
      options: fp.getDefaultFuzzOptions(),
      isStale: () => "optionschanged",
      test: async () => createMockResults(10),
      getInputGeneratorDiagnostics: () => [],
    };

    mockWebviewPanel = {
      viewType: "FuzzPanel",
      title: "Test",
      options: {},
      visible: true,
      active: true,
      webview: {
        options: {},
        cspSource: "'self'",
        html: "",
        asWebviewUri: (uri: any) => {
          const p = uri.fsPath || uri.path || String(uri);
          const rel = path.relative(process.cwd(), p).replace(/\\/g, "/");
          return "/" + (rel.startsWith("/") ? rel.slice(1) : rel);
        },
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: async () => true,
      },
      onDidDispose: () => ({ dispose: () => {} }),
      onDidChangeViewState: () => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    };

    panel = new (fp.FuzzPanel as any)(
      mockWebviewPanel,
      { fsPath: process.cwd() },
      mockTester
    );

    currentHtml = mockWebviewPanel.webview.html;

    server = new FuzzPanelTestServer(() => currentHtml);
    serverUrl = await server.start();
  });

  test.afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("loads webview, clicks Start -> results populate -> clicks Continue -> more results populate", async ({
    page,
  }) => {
    page.on("console", (msg) =>
      console.log("BROWSER LOG:", msg.type(), msg.text())
    );
    page.on("pageerror", (err) => console.log("BROWSER ERROR:", err.message));

    const messagesReceived: any[] = [];

    await page.exposeFunction("__nanofuzzPostToHost", (msgStr: string) => {
      const parsed = JSON.parse(msgStr);
      const payload = parsed.jsonn ? JSONN.parse(parsed.jsonn) : parsed;
      messagesReceived.push(payload);
    });

    await page.addInitScript(() => {
      (window as any).__nanofuzzMessages = [];
      (window as any).acquireVsCodeApi = () => ({
        postMessage: (msg: any) => {
          (window as any).__nanofuzzMessages.push(msg);
          (window as any).__nanofuzzPostToHost(JSON.stringify(msg));
        },
        setState: (state: any) => {
          (window as any).__nanofuzzState = state;
        },
        getState: () => (window as any).__nanofuzzState,
      });
    });

    // 1. Initial page load
    await page.goto(serverUrl);

    // Verify main components are present
    const runBtn = page.locator("#fuzz\\.run");
    await expect(runBtn).toBeVisible();

    const continueBtn = page.locator("#fuzz\\.continue");
    await expect(continueBtn).toHaveClass(/hidden/);

    // 2. Click Start Testing
    await runBtn.click();

    // Verify host received fuzz.run message
    expect(messagesReceived.length).toBeGreaterThan(0);
    expect(messagesReceived[0].command).toBe("fuzz.run");

    // 3. Populate initial results (10 results)
    const initialResults = createMockResults(10);
    initialResults.env = panel._fuzzEnv;
    panel._results = initialResults;
    panel._state = fp.FuzzPanelState.done;
    panel._tester.state = "ready";
    panel._updateHtml();
    currentHtml = mockWebviewPanel.webview.html;

    // Reload with populated results (in client-side migration, this will be seamless live DOM update)
    await page.goto(serverUrl);

    // Verify 10 rows populated in the ok results grid
    const okRows = page.locator("#fuzzResultsGrid-ok-tbody tr");
    await expect(okRows).toHaveCount(10);

    // Verify continue button is now visible
    const continueBtnAfterRun = page.locator("#fuzz\\.continue");
    await expect(continueBtnAfterRun).toBeVisible();
    await expect(continueBtnAfterRun).not.toHaveClass(/hidden/);

    // 4. Click Continue
    await continueBtnAfterRun.click();

    // Verify host received fuzz.continue message
    const continueMsg = messagesReceived.find(
      (m) => m.command === "fuzz.continue"
    );
    expect(continueMsg).toBeDefined();

    // 5. Populate more results (20 results total)
    const continuedResults = createMockResults(20);
    continuedResults.env = panel._fuzzEnv;
    panel._results = continuedResults;
    panel._updateHtml();
    currentHtml = mockWebviewPanel.webview.html;

    await page.goto(serverUrl);

    // Verify table now has 20 rows!
    const okRowsAfterContinue = page.locator("#fuzzResultsGrid-ok-tbody tr");
    await expect(okRowsAfterContinue).toHaveCount(20);

    // 6. Click Start Over (Clear)
    const clearBtn = page.locator("#fuzz\\.clear");
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Verify host received fuzz.clear message
    const clearMsg = messagesReceived.find((m) => m.command === "fuzz.clear");
    expect(clearMsg).toBeDefined();

    // Reset panel to init state
    panel._results = undefined;
    panel._state = fp.FuzzPanelState.init;
    panel._tester.state = "init";
    panel._updateHtml();
    currentHtml = mockWebviewPanel.webview.html;
    await page.goto(serverUrl);

    // Continue button and results table are now hidden/empty
    await expect(page.locator("#fuzz\\.continue")).toHaveClass(/hidden/);
    await expect(page.locator("#fuzzResultsGrid-ok-tbody tr")).toHaveCount(0);
  });

  test("extracts edited argument bounds when clicking Start", async ({
    page,
  }) => {
    const messagesReceived: any[] = [];

    await page.exposeFunction("__nanofuzzPostToHost", (msgStr: string) => {
      const parsed = JSON.parse(msgStr);
      const payload = parsed.jsonn ? JSONN.parse(parsed.jsonn) : parsed;
      messagesReceived.push(payload);
    });

    await page.addInitScript(() => {
      (window as any).__nanofuzzMessages = [];
      (window as any).acquireVsCodeApi = () => ({
        postMessage: (msg: any) => {
          (window as any).__nanofuzzMessages.push(msg);
          (window as any).__nanofuzzPostToHost(JSON.stringify(msg));
        },
        setState: (state: any) => {
          (window as any).__nanofuzzState = state;
        },
        getState: () => (window as any).__nanofuzzState,
      });
    });

    await page.goto(serverUrl);

    // Find the number argument input (argDef-1 is the number property 'a')
    const minInput = page.locator("#argDef-1-min");
    const maxInput = page.locator("#argDef-1-max");

    if (await minInput.count()) {
      await minInput.locator("input").fill("25");
      await maxInput.locator("input").fill("75");
    }

    // Click Start testing
    await page.locator("#fuzz\\.run").click();

    expect(messagesReceived.length).toBeGreaterThan(0);
    const runMsg = messagesReceived.find((m) => m.command === "fuzz.run");
    expect(runMsg).toBeDefined();

    const config: FuzzPanelFuzzRunMessage = JSONN.parse(runMsg.json);
    expect(config.args).toBeDefined();
    expect(config.args.length).toBeGreaterThan(0);

    // Check that numeric overrides were captured
    const numOverride = config.args.find((a) => a.number);
    expect(numOverride).toBeDefined();
    expect(numOverride?.number?.min).toBe(25);
    expect(numOverride?.number?.max).toBe(75);
  });
});
