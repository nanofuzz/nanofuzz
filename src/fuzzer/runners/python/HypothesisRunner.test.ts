import { HypothesisRunner } from "./HypothesisRunner";
import * as Config from "../../../Config";
import { runFuzz } from "../../../ui/Agent";
import { FuzzStopReason } from "../../Types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("fuzzer/runners/python/HypothesisRunner", () => {
  afterEach(() => {
    Config.clearOverrides();
  });

  beforeEach(() => {
    const venvPython = path.join(process.cwd(), ".venv", "bin", "python3.13");
    if (fs.existsSync(venvPython)) {
      Config.override("python.defaultInterpreterPath", venvPython);
    }
  });

  it("builds and instantiates runner cleanly", () => {
    const runner = new HypothesisRunner(
      {
        filePath: "tests/test_foo.py",
        functionName: "test_bar",
        suiteTimeout: 5000,
      },
      "hypothesis"
    );
    expect(runner).toBeDefined();
  });

  it("runFuzz routes to HypothesisRunner when experimental tool is hypothesis", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");

    // Create a temporary valid python test file
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-hypo-test-")
    );
    const testFile = path.join(tmpDir, "test_sample.py");
    fs.writeFileSync(
      testFile,
      `
from hypothesis import given, strategies as st

@given(x=st.integers(min_value=0, max_value=10))
def test_sample(x):
    assert x >= 0
`,
      "utf8"
    );

    try {
      const result = await runFuzz({
        filePath: testFile,
        functionName: "test_sample",
        suiteTimeout: 5000,
        inputs: [{ x: 5 }],
      });

      expect(result).toBeDefined();
      expect(result.language).toBe("python");
      expect(result.generators?.injectedInputs).toBe(1);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("suppresses failures in continuous exploration mode (maxFailures = 0)", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-hypo-fail-")
    );
    const testFile = path.join(tmpDir, "test_failing.py");
    fs.writeFileSync(
      testFile,
      `
from hypothesis import given, strategies as st

@given(x=st.integers(min_value=-5, max_value=5))
def test_failing(x):
    # Fails for negative numbers
    assert x >= 0
`,
      "utf8"
    );

    try {
      const result = await runFuzz({
        filePath: testFile,
        functionName: "test_failing",
        suiteTimeout: 3000,
        maxFailures: 0,
      });

      expect(result).toBeDefined();
      expect(result.status).toBe("counterexample_found");
      expect(result.totalTests).toBeGreaterThan(0);
      expect(result.failedTests).toBeGreaterThan(0);
      expect(result.passedTests).toBeGreaterThan(0);
      expect(result.counterexamples.length).toBeGreaterThan(0);
      expect(result.counterexamples[0].input.length).toBeGreaterThan(0);
      // Parameter name should be 'x', not 'arg_0'
      expect(result.counterexamples[0].input[0].name).toBe("x");
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("strictly asserts injected examples are executed", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-hypo-inject-")
    );
    const pFile = path.join(tmpDir, "test_inject.py");
    const recordFile = path.join(tmpDir, "executed.txt").replace(/\\/g, "/");
    fs.writeFileSync(
      pFile,
      `from hypothesis import given, strategies as st

@given(x=st.integers(min_value=0, max_value=100))
def test_inject(x):
    with open("${recordFile}", "a") as f:
        f.write(str(x) + "\\n")
`,
      "utf8"
    );

    try {
      const res = await runFuzz({
        filePath: pFile,
        functionName: "test_inject",
        suiteTimeout: 3000,
        inputs: [{ x: 9999 }, { x: 8888 }],
      });
      const executed = fs.existsSync(recordFile)
        ? fs.readFileSync(recordFile, "utf8").split("\n").filter(Boolean)
        : [];
      expect(executed).toContain("9999");
      expect(executed).toContain("8888");
      expect(res.generators?.injectedInputs).toBe(2);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("enforces hard timeout and terminates long-running execution", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nanofuzz-hypo-timeout-")
    );
    const pFile = path.join(tmpDir, "test_timeout.py");
    fs.writeFileSync(
      pFile,
      `import time
from hypothesis import given, settings, strategies as st

@settings(max_examples=5000)
@given(x=st.integers())
def test_timeout(x):
    time.sleep(0.05)
`,
      "utf8"
    );

    try {
      const start = Date.now();
      const res = await runFuzz({
        filePath: pFile,
        functionName: "test_timeout",
        suiteTimeout: 2000,
      });
      const elapsed = Date.now() - start;

      // Ensure timeout cap executed within reasonable grace margin (around 2s, well before 5000*0.05=250s)
      expect(elapsed).toBeLessThan(8000);
      expect(res.stopReason).toBe(FuzzStopReason.MAXTIME);
      expect(res.totalTests).toBeGreaterThan(0);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("respects maxTests limit and returns code coverage data", async () => {
    Config.override("nanofuzz.experimental.findBugs.tool", "hypothesis");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-hypo-cov-"));
    // Create dummy module and test file
    const modFile = path.join(tmpDir, "helper_logic.py");
    fs.writeFileSync(
      modFile,
      `def classify(n):
    if n > 0:
        return "positive"
    elif n < 0:
        return "negative"
    return "zero"
`,
      "utf8"
    );

    const testFile = path.join(tmpDir, "test_helper.py");
    fs.writeFileSync(
      testFile,
      `from hypothesis import given, strategies as st
from helper_logic import classify

@given(n=st.integers(min_value=-1000, max_value=1000))
def test_helper(n):
    res = classify(n)
    assert res in ("positive", "negative", "zero")
`,
      "utf8"
    );

    try {
      const res = await runFuzz({
        filePath: testFile,
        functionName: "test_helper",
        suiteTimeout: 10000,
        maxTests: 25,
      });

      expect(res).toBeDefined();
      expect(res.totalTests).toBe(25);
      expect(res.stopReason).toBe(FuzzStopReason.NOMOREINPUTS);
      expect(res.coverage).toBeDefined();
      if (res.coverage) {
        expect(res.coverage.statementsTotal).toBeGreaterThan(0);
        expect(res.coverage.statementCoveragePercent).toBeGreaterThan(0);
      }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });
});
