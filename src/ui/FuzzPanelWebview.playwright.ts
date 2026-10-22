import { test, expect, Page } from "@playwright/test";
import * as path from "path";
import * as vscode from "vscode";
import { FuzzPanelTestServer } from "./FuzzPanelWebviewHarness";
import * as fp from "./FuzzPanelController";
import * as fuzzer from "../fuzzer/Types";
import {
  IFuzzer,
  getDefaultFuzzExecutionOptions,
} from "../fuzzer/FuzzerFactory";
import * as ProgramFactory from "../fuzzer/analysis/ProgramFactory";
import * as JSONN from "../Jsonn";
import {
  FuzzPanelFuzzRunMessage,
  FuzzPanelMessageFromWebView,
} from "./FuzzPanelController";

function createMockResults(
  count: number,
  startIdx = 0
): fuzzer.FuzzTestResults {
  const results: fuzzer.FuzzTestResult[] = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    results.push({
      category: "ok",
      pinned: false,
      inputGenerated: {
        tick: idx,
        value: [{ tag: "ArgValueTypeWrapped", value: idx }],
        source: { type: "generator", generator: "RandomInputGenerator" },
      },
      input: [
        {
          name: "a",
          offset: 0,
          value: idx,
          origin: { type: "generator", generator: "RandomInputGenerator" },
        },
      ],
      output: [
        {
          name: "output",
          offset: 0,
          value: idx * 2,
          origin: { type: "put" },
        },
      ],
      exception: false,
      timeout: false,
      passedImplicit: "pass",
      passedHuman: "pass",
      passedValidator: "pass",
      passedValidators: [],
      harnessErrors: [],
      timers: { gen: 0, transform: 0, run: 0 },
      interestingReasons: [],
    });
  }

  return {
    toolVersion: "0.4.0",
    results,
    interesting: {
      inputs: [],
    },
    env: cast<fuzzer.FuzzEnv>({}),
    stopReason: fuzzer.FuzzStopReason.MAXTESTS,
    stats: {
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
        inputsInterrupted: 0,
        failedTests: 0,
      },
      generators: {
        RandomInputGenerator: {
          counters: {
            inputsGenerated: results.length,
            dupesGenerated: 0,
            dupeTicks: [],
          },
          timers: {
            run: 0,
            val: 0,
            gen: 10,
            measure: 0,
            transform: 0,
          },
        },
        MutationInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
        AiInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
        UserInputGenerator: {
          counters: { inputsGenerated: 0, dupesGenerated: 0, dupeTicks: [] },
          timers: { run: 0, val: 0, gen: 0, measure: 0, transform: 0 },
        },
      },
      outcomes: {
        total: results.length,
        exceptions: 0,
        timeouts: 0,
        oracles: {
          human: { pass: results.length, fail: 0, unknown: 0 },
          property: { pass: results.length, fail: 0, unknown: 0 },
          heuristic: { pass: results.length, fail: 0, unknown: 0 },
        },
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

interface FuzzPanelTestInstance {
  _results?: fuzzer.FuzzTestResults;
  _state: fp.FuzzPanelState;
  _tester: { state: string };
  _fuzzEnv: fuzzer.FuzzEnv;
  _updateHtml: () => void;
}

test.describe("FuzzPanel Webview End-to-End Flow", () => {
  let server: FuzzPanelTestServer;
  let serverUrl: string;
  let panel: FuzzPanelTestInstance;
  let mockHtml = "";
  let activePage: Page | undefined;

  test.beforeEach(async () => {
    const testFile = path.resolve(
      "./src/fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
    );
    const pgm = ProgramFactory.fromFile(testFile);
    const fnDef = pgm.functions["testChangeInput"];

    const mockTester: IFuzzer = {
      state: "init",
      env: {
        function: fnDef,
        options: fp.getDefaultFuzzOptions(),
        validators: [],
        transformers: [],
        userGenerators: [],
        executionOptions: getDefaultFuzzExecutionOptions(),
      },
      executionOptions: getDefaultFuzzExecutionOptions(),
      workerCount: 1,
      engine: "v2",
      options: fp.getDefaultFuzzOptions(),
      isStale: () => "optionschanged",
      test: async () => createMockResults(10),
      getInputGeneratorDiagnostics: () => [],
    };

    const mockWebviewPanel = {
      viewType: "FuzzPanel",
      title: "Test",
      options: {},
      visible: true,
      active: true,
      iconPath: undefined,
      webview: {
        options: {},
        cspSource: "'self'",
        html: "",
        asWebviewUri: (uri: vscode.Uri) => {
          const p = uri.fsPath || uri.path || String(uri);
          const rel = path.relative(process.cwd(), p).replace(/\\/g, "/");
          return "/" + (rel.startsWith("/") ? rel.slice(1) : rel);
        },
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: async (msg: unknown) => {
          if (activePage) {
            await activePage.evaluate((m) => {
              window.postMessage(m, "*");
            }, msg);
          }
          return true;
        },
      },
      onDidDispose: () => ({ dispose: () => {} }),
      onDidChangeViewState: () => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    };

    const FuzzPanelCtor = cast<{
      new (
        p: vscode.WebviewPanel,
        u: vscode.Uri,
        t: IFuzzer
      ): FuzzPanelTestInstance;
    }>(fp.FuzzPanel);

    panel = new FuzzPanelCtor(
      cast<vscode.WebviewPanel>(mockWebviewPanel),
      cast<vscode.Uri>({ fsPath: process.cwd() }),
      mockTester
    );

    mockHtml = mockWebviewPanel.webview.html;

    server = new FuzzPanelTestServer(() => mockHtml);
    serverUrl = await server.start();
  });

  test.afterEach(async () => {
    activePage = undefined;
    if (server) {
      await server.stop();
    }
  });

  async function setupVsCodeMock(
    page: Page,
    onMessage?: (msg: FuzzPanelMessageFromWebView) => void
  ): Promise<void> {
    await page.exposeFunction("__nanofuzzPostToHost", (msgStr: string) => {
      const parsed = cast<Record<string, unknown>>(JSON.parse(msgStr));
      const payload = cast<FuzzPanelMessageFromWebView>(
        "jsonn" in parsed && typeof parsed.jsonn === "string"
          ? JSONN.parse(parsed.jsonn)
          : parsed
      );
      if (onMessage) {
        onMessage(payload);
      }
    });

    await page.addInitScript(() => {
      const win = window;
      Reflect.set(win, "__nanofuzzMessages", []);
      Reflect.set(win, "acquireVsCodeApi", () => ({
        postMessage: (msg: unknown) => {
          const msgs = Reflect.get(win, "__nanofuzzMessages");
          if (Array.isArray(msgs)) {
            msgs.push(msg);
          }
          const postFn = Reflect.get(win, "__nanofuzzPostToHost");
          if (typeof postFn === "function") {
            postFn(JSON.stringify(msg));
          }
        },
        setState: (state: unknown) => {
          Reflect.set(win, "__nanofuzzState", state);
        },
        getState: () => Reflect.get(win, "__nanofuzzState"),
      }));
    });
  }

  test("loads webview, clicks Start -> results populate -> clicks Continue -> more results populate", async ({
    page,
  }) => {
    activePage = page;
    const messagesReceived: FuzzPanelMessageFromWebView[] = [];
    await setupVsCodeMock(page, (m) => messagesReceived.push(m));

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
    await expect
      .poll(() => messagesReceived.some((m) => m.command === "fuzz.run"))
      .toBe(true);

    // 3. Populate initial results (10 results) - live IPC update without page reload!
    const initialResults = createMockResults(10);
    initialResults.env = panel._fuzzEnv;
    panel._results = initialResults;
    panel._state = fp.FuzzPanelState.done;
    panel._tester.state = "ready";
    panel._updateHtml();

    // Verify 10 rows populated in the ok results grid via live DOM update
    const okRows = page.locator("#fuzzResultsGrid-ok-tbody tr");
    await expect(okRows).toHaveCount(10);

    // Verify continue button is now visible
    const continueBtnAfterRun = page.locator("#fuzz\\.continue");
    await expect(continueBtnAfterRun).toBeVisible();
    await expect(continueBtnAfterRun).not.toHaveClass(/hidden/);

    // 4. Click Continue
    await continueBtnAfterRun.click();

    // Verify host received fuzz.continue message
    await expect
      .poll(() => messagesReceived.some((m) => m.command === "fuzz.continue"))
      .toBe(true);

    // 5. Populate more results (20 results total) - live IPC update without page reload!
    const continuedResults = createMockResults(20);
    continuedResults.env = panel._fuzzEnv;
    panel._results = continuedResults;
    panel._updateHtml();

    // Verify table now has 20 rows!
    const okRowsAfterContinue = page.locator("#fuzzResultsGrid-ok-tbody tr");
    await expect(okRowsAfterContinue).toHaveCount(20);

    // 6. Click Start Over (Clear)
    const clearBtn = page.locator("#fuzz\\.clear");
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    // Verify host received fuzz.clear message
    await expect
      .poll(() => messagesReceived.some((m) => m.command === "fuzz.clear"))
      .toBe(true);

    // Reset panel to init state - live IPC update without page reload!
    panel._results = undefined;
    panel._state = fp.FuzzPanelState.init;
    panel._tester.state = "init";
    panel._updateHtml();

    // Continue button and results table are now hidden/empty
    await expect(page.locator("#fuzz\\.continue")).toHaveClass(/hidden/);
    await expect(page.locator("#fuzzResultsGrid-ok-tbody tr")).toHaveCount(0);
  });

  test("extracts edited argument bounds when clicking Start", async ({
    page,
  }) => {
    activePage = page;
    const messagesReceived: FuzzPanelMessageFromWebView[] = [];
    await setupVsCodeMock(page, (m) => messagesReceived.push(m));

    await page.goto(serverUrl);

    // Wait for the argument definitions to be rendered in the DOM
    const minInput = page.locator("#argDef-1-min");
    const maxInput = page.locator("#argDef-1-max");
    await expect(minInput).toBeVisible();
    await expect(maxInput).toBeVisible();

    const minField = page.locator("#argDef-1-min input");
    const maxField = page.locator("#argDef-1-max input");
    await minField.fill("25");
    await expect(minField).toHaveValue("25");
    await maxField.fill("75");
    await expect(maxField).toHaveValue("75");

    // Click Start testing
    await page.locator("#fuzz\\.run").click();

    expect(messagesReceived.length).toBeGreaterThan(0);
    const runMsg = messagesReceived.find((m) => m.command === "fuzz.run");
    expect(runMsg).toBeDefined();

    const config: FuzzPanelFuzzRunMessage =
      runMsg && "json" in runMsg
        ? JSONN.parse(runMsg.json)
        : { fuzzer: cast<FuzzPanelFuzzRunMessage["fuzzer"]>({}), args: [] };
    expect(config.args).toBeDefined();
    expect(config.args.length).toBeGreaterThan(0);

    // Check that numeric overrides were captured
    const numOverride = config.args.find((a) => a.number !== undefined);
    expect(numOverride).toBeDefined();
    expect(numOverride?.number?.min).toBe(25);
    expect(numOverride?.number?.max).toBe(75);
  });

  test("busyTesting shows pause button, disables categorize controls, and done shows active tabs without expectedOutput column", async ({
    page,
  }) => {
    activePage = page;
    await setupVsCodeMock(page);
    await page.goto(serverUrl);

    // Initial state: run visible, pause hidden
    await expect(page.locator("#fuzz\\.run")).toBeVisible();
    await expect(page.locator("#fuzzPauseWrapper")).toHaveClass(/hidden/);

    // Transition to busyTesting
    panel._state = fp.FuzzPanelState.busyTesting;
    panel._updateHtml();

    // Verify pause button is now visible and run button is hidden
    await expect(page.locator("#fuzzPauseWrapper")).not.toHaveClass(/hidden/);
    await expect(page.locator("#fuzz\\.pause")).toBeVisible();
    await expect(page.locator("#fuzz\\.run")).toHaveClass(/hidden/);

    // Verify categorization controls are disabled
    await expect(page.locator("#fuzz-useImplicit")).toHaveAttribute(
      "disabled",
      "true"
    );
    await expect(page.locator("#fuzz-useProperty")).toHaveAttribute(
      "disabled",
      "true"
    );

    // Transition to done with results
    panel._results = createMockResults(5);
    panel._results.env = panel._fuzzEnv;
    panel._state = fp.FuzzPanelState.done;
    panel._tester.state = "ready";
    panel._updateHtml();

    // Verify pause button hidden, continue & retest wrappers have tooltips
    await expect(page.locator("#fuzzPauseWrapper")).toHaveClass(/hidden/);
    await expect(page.locator("#fuzzRetestWrapper")).toHaveAttribute(
      "aria-label",
      "Retest these examples"
    );
    await expect(page.locator("#fuzzContinueWrapper")).toHaveAttribute(
      "aria-label",
      "Generate more examples"
    );

    // Verify tabs only render active categories (ok + runInfo)
    const tabs = page.locator("#fuzzResultsTabStrip vscode-panel-tab");
    await expect(tabs).toHaveCount(2);
    await expect(page.locator("#tab-ok")).toBeVisible();
    await expect(page.locator("#tab-runInfo")).toBeVisible();

    // Verify no expectedOutput column in table header
    const headers = page.locator("#fuzzResultsGrid-ok-thead th");
    const headerTexts = await headers.allTextContents();
    expect(headerTexts.some((h) => h.includes("expectedOutput"))).toBe(false);

    // Verify clicking interesting inputs button on Run Info tab
    await page.locator("#tab-runInfo").click();
    const interestingBtn = page.locator(
      "#fuzz\\.options\\.interesting\\.inputs\\.button"
    );
    if (await interestingBtn.count()) {
      const interestingTable = page.locator(
        "#fuzz\\.options\\.interesting\\.inputs"
      );
      await expect(interestingTable).toHaveClass(/hidden/);
      await interestingBtn.click();
      await expect(interestingTable).not.toHaveClass(/hidden/);
    }
  });
});

function cast<T>(val: unknown): T;
function cast(val: unknown): unknown {
  return val;
}
