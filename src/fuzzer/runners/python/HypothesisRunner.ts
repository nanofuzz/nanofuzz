import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as JSONN from "../../../Jsonn";
import {
  AgentFuzzOptions,
  AgentFuzzResult,
  AgentFuzzStatus,
  AgentCounterexample,
  AgentCoverageSummary,
  AgentGeneratorSummary,
  buildSummaryMarkdown,
  shrinkInputs,
} from "../../../ui/Agent";
import { PythonRunner } from "./PythonRunner";
import { getToolVersion } from "../../../ToolVersion";
import { determineWorkerCount } from "../../Util";
import * as Config from "../../../Config";
import {
  FuzzResultCategory,
  FuzzStatusUpdater,
  FuzzStopReason,
} from "../../Types";
import { ArgValueType } from "../../analysis/Types";

/**
 * Runner that executes property-based tests via Hypothesis or Hypofuzz,
 * parses structured execution reports, and delegates counterexample shrinking to NaNofuzz.
 */
export class HypothesisRunner {
  private _options: AgentFuzzOptions;
  private _tool: "hypothesis" | "hypofuzz";
  private _cancelFn?: () => boolean;
  private _updateFn?: FuzzStatusUpdater;

  public constructor(
    options: AgentFuzzOptions,
    tool: "hypothesis" | "hypofuzz",
    cancelFn?: () => boolean,
    updateFn?: FuzzStatusUpdater
  ) {
    this._options = options;
    this._tool = tool;
    this._cancelFn = cancelFn;
    this._updateFn = updateFn;
  }

  /**
   * Executes the test run and returns a standardized AgentFuzzResult.
   */
  public async run(): Promise<AgentFuzzResult> {
    const filePath = path.resolve(this._options.filePath);
    const baseName = path.basename(filePath);
    if (
      !baseName.startsWith("test_") &&
      !baseName.endsWith("_test.py") &&
      !filePath.includes("/tests/") &&
      !filePath.includes("/test/")
    ) {
      throw new Error(
        `Invalid test file '${filePath}'. When using ${this._tool}, filePath must point to a test file (e.g. tests/test_pbt_<entrypoint>.py), not the source implementation file.`
      );
    }

    const functionName = this._options.functionName;
    const pythonEnv = PythonRunner.envFor(filePath);

    const reportFile = path.join(
      os.tmpdir(),
      `nanofuzz_pbt_report_${crypto.randomUUID()}.msgpack`
    );

    const suiteTimeoutMs = this._options.suiteTimeout ?? 300000;
    const suiteTimeoutSec = Math.max(1, Math.round(suiteTimeoutMs / 1000));
    const bridgePath = resolveBridgePath();
    const bridgeDir = path.dirname(bridgePath);

    let injectedFile: string | undefined;
    const injectedInputs = [
      ...(this._options.inputs ?? []),
      ...(this._options.tests ?? []),
    ];
    if (injectedInputs.length > 0) {
      injectedFile = path.join(
        os.tmpdir(),
        `nanofuzz_pbt_injected_${crypto.randomUUID()}.msgpack`
      );
      fs.writeFileSync(injectedFile, Buffer.from(JSONN.pack(injectedInputs)));
    }

    const env: Record<string, string> = {
      ...process.env,
      ...pythonEnv.env,
      NANOFUZZ_PBT_OUT_FILE: reportFile,
      NANOFUZZ_SUITE_TIMEOUT_SEC: String(suiteTimeoutSec),
      NANOFUZZ_MAX_FAILURES: String(this._options.maxFailures ?? 0),
      NANOFUZZ_MAX_TESTS: String(this._options.maxTests ?? 0),
    };

    if (injectedFile) {
      env.NANOFUZZ_PBT_INJECTED_FILE = injectedFile;
    }

    // Prepend bridge directory to PYTHONPATH
    const currentPyPath = env.PYTHONPATH
      ? env.PYTHONPATH.split(path.delimiter)
      : [];
    if (!currentPyPath.includes(bridgeDir)) {
      env.PYTHONPATH = [bridgeDir, ...currentPyPath].join(path.delimiter);
    }

    const workerCount = determineWorkerCount(
      this._options.workers ?? Config.get("nanofuzz.fuzzer.workers", "auto"),
      false
    );

    const args = buildCliArgs(
      this._tool,
      filePath,
      functionName,
      workerCount,
      pythonEnv.interpreter
    );

    const startTime = Date.now();
    let processExited = false;
    let proc: child_process.ChildProcess | undefined;
    let stdoutText = "";
    let stderrText = "";
    let exitCode: number | null = null;

    const fileDir = path.dirname(filePath);
    // If the test file is inside a tests/ or test/ folder, run from the project root
    // so coverage.py and pytest can locate project source files in src/.
    const projectRoot =
      path.basename(fileDir) === "tests" || path.basename(fileDir) === "test"
        ? path.resolve(fileDir, "..")
        : fileDir;

    env.NANOFUZZ_PROJECT_ROOT = projectRoot;

    try {
      proc = child_process.spawn(pythonEnv.interpreter, args, {
        cwd: projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (this._updateFn) {
        this._updateFn({
          type: "testing",
          fnName: functionName,
          lang: "python",
          inputs: [],
          stats: {
            counters: {
              inputsInjected: 0,
              inputsGenerated: 0,
              dupesGenerated: 0,
              dupesSequential: 0,
              erroredTests: 0,
              failedTests: 0,
              passedTests: 0,
              inputsSkipped: 0,
              inputsInterrupted: 0,
            },
            outcomes: {
              total: 0,
              exceptions: 0,
              timeouts: 0,
              categories: {
                ok: 0,
                badValue: 0,
                exception: 0,
                timeout: 0,
                failure: 0,
                disagree: 0,
                skip: 0,
              },
              oracles: {
                heuristic: { pass: 0, fail: 0, unknown: 0 },
                human: { pass: 0, fail: 0, unknown: 0 },
                property: { pass: 0, fail: 0, unknown: 0 },
              },
            },
            timers: {
              startTime: performance.now(),
              startGenTime: performance.now(),
            },
          },
          pct: 0,
          stillInjecting: false,
          isCancelled: false,
        });
      }

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutText += data.toString("utf8");
      });
      proc.stderr?.on("data", (data: Buffer) => {
        stderrText += data.toString("utf8");
      });

      // Cancellation and timeout watchdog + periodic progress updater
      const maxTestsTarget = this._options.maxTests ?? 0;
      const maxFailuresTarget = this._options.maxFailures ?? 0;
      const hardTimeoutMs = suiteTimeoutMs + 3000;
      let lastReportCheck = 0;
      let terminating = false;
      const watchdogInterval = setInterval(() => {
        if (processExited) {
          clearInterval(watchdogInterval);
          return;
        }

        const elapsed = Date.now() - startTime;
        if (this._cancelFn?.()) {
          clearInterval(watchdogInterval);
          sendSignal(proc, "SIGINT");
          return;
        }

        // Sample progress from report file and detect target completion
        try {
          if (fs.existsSync(reportFile)) {
            const raw = fs.readFileSync(reportFile);
            const interim = parsePbtRunReport(JSONN.unpack(raw));
            if (interim) {
              const total = interim.total_executions;
              const passed = interim.pass_count;
              const failed = interim.fail_count;

              if (this._updateFn && elapsed - lastReportCheck >= 500) {
                lastReportCheck = elapsed;
                const pct =
                  suiteTimeoutMs > 0
                    ? Math.min(
                        100,
                        Math.round((elapsed / suiteTimeoutMs) * 100)
                      )
                    : 0;
                this._updateFn({
                  type: "testing",
                  fnName: functionName,
                  lang: "python",
                  inputs: [],
                  stats: {
                    counters: {
                      inputsInjected: 0,
                      inputsGenerated: total,
                      dupesGenerated: 0,
                      dupesSequential: 0,
                      erroredTests: 0,
                      failedTests: failed,
                      passedTests: passed,
                      inputsSkipped: 0,
                      inputsInterrupted: 0,
                    },
                    outcomes: {
                      total,
                      exceptions: failed,
                      timeouts: interim.timeout_count,
                      categories: {
                        ok: passed,
                        badValue: 0,
                        exception: failed,
                        timeout: interim.timeout_count,
                        failure: failed,
                        disagree: 0,
                        skip: 0,
                      },
                      oracles: {
                        heuristic: { pass: passed, fail: failed, unknown: 0 },
                        human: { pass: 0, fail: 0, unknown: 0 },
                        property: { pass: passed, fail: failed, unknown: 0 },
                      },
                    },
                    timers: {
                      startTime: performance.now() - elapsed,
                      startGenTime: performance.now() - elapsed,
                    },
                  },
                  pct,
                  stillInjecting: false,
                  isCancelled: false,
                });
              }

              // Check if targets are met or runner signaled completion
              const targetReached =
                (maxTestsTarget > 0 && total >= maxTestsTarget) ||
                (maxFailuresTarget > 0 && failed >= maxFailuresTarget) ||
                interim.stop_reason === "max_tests" ||
                interim.stop_reason === "max_failures" ||
                interim.stop_reason === "timeout";

              if (targetReached && !terminating) {
                terminating = true;
                clearInterval(watchdogInterval);
                sendSignal(proc, "SIGINT");
                setTimeout(() => {
                  if (!processExited && proc) {
                    proc.kill("SIGKILL");
                  }
                }, 3000).unref();
                return;
              }
            }
          }
        } catch {
          // Ignore interim read/parse race conditions
        }

        if (elapsed >= hardTimeoutMs && !terminating) {
          terminating = true;
          clearInterval(watchdogInterval);
          sendSignal(proc, "SIGINT");
          setTimeout(() => {
            if (!processExited && proc) {
              proc.kill("SIGKILL");
            }
          }, 3000).unref();
        }
      }, 200);

      await new Promise<void>((resolve) => {
        proc?.on("close", (code) => {
          exitCode = code;
          processExited = true;
          clearInterval(watchdogInterval);
          resolve();
        });
        proc?.on("error", (err) => {
          stderrText += String(err);
          processExited = true;
          clearInterval(watchdogInterval);
          resolve();
        });
      });
    } catch (err) {
      if (!fs.existsSync(reportFile)) {
        throw err;
      }
    }

    // Read report file written by bridge
    let reportData: PbtRunReport | undefined;
    if (fs.existsSync(reportFile)) {
      try {
        const raw = fs.readFileSync(reportFile);
        reportData = parsePbtRunReport(JSONN.unpack(raw));
      } finally {
        try {
          fs.unlinkSync(reportFile);
        } catch {
          // Ignore unlink errors
        }
      }
    }

    if (injectedFile && fs.existsSync(injectedFile)) {
      try {
        fs.unlinkSync(injectedFile);
      } catch {
        // Ignore unlink errors
      }
    }

    if (!reportData) {
      const errDetail = stderrText.trim() ? `\nStderr:\n${stderrText}` : "";
      throw new Error(
        `Hypothesis runner failed to produce execution report (exit code: ${exitCode}).${errDetail}`
      );
    }

    if (reportData.stop_reason === "no_hypothesis_tests") {
      const toolLabel = this._tool === "hypofuzz" ? "Hypofuzz" : "Hypothesis";
      const out = (stdoutText + "\n" + stderrText).trim();
      throw new Error(
        `No tests found by ${toolLabel} in '${filePath}' matching '${functionName}'.\n${out}`
      );
    }

    const totalTests = reportData?.total_executions ?? 0;
    if (totalTests === 0) {
      const toolLabel = this._tool === "hypofuzz" ? "Hypofuzz" : "Hypothesis";
      const out = (stdoutText + "\n" + stderrText).trim();
      throw new Error(
        `${toolLabel} executed 0 tests in '${filePath}' (exit code: ${exitCode}).\n${out}`
      );
    }
    const failedTests = reportData?.fail_count ?? 0;
    const passedTests =
      reportData?.pass_count ?? Math.max(0, totalTests - failedTests);
    const timeouts = reportData?.timeout_count ?? 0;
    const exceptions = failedTests;

    const injectedCount =
      (this._options.inputs?.length ?? 0) + (this._options.tests?.length ?? 0);

    const generators: AgentGeneratorSummary = {
      randomInputs: Math.max(0, totalTests - injectedCount),
      mutationInputs: 0,
      aiInputs: 0,
      aiQueriesSent: 0,
      userInputs: 0,
      injectedInputs: injectedCount,
    };

    let primaryCounterexample: AgentCounterexample | undefined;
    const counterexamples: AgentCounterexample[] = [];

    if (reportData?.primary_counterexample) {
      const rawCe = reportData.primary_counterexample;
      let finalInputs = rawCe.inputs;
      let isShrunk = false;
      let shrinkSteps = 0;

      // Delegate counterexample shrinking to NaNofuzz ArgDefShrinker
      const shrinkRes = await shrinkInputs({
        filePath,
        functionName,
        inputs: [rawCe.inputs],
        fnTimeout: this._options.fnTimeout,
      });

      if (shrinkRes.shrunkInputs.length > 0) {
        const shrunk = shrinkRes.shrunkInputs[0];
        if (shrunk.status === "shrunk" && isRecord(shrunk.shrunkenInput)) {
          finalInputs = shrunk.shrunkenInput;
          isShrunk = true;
          shrinkSteps = shrunk.shrinkSteps;
        }
      }

      const inputElements = Object.entries(finalInputs).map(
        ([name, value], offset) => ({
          name,
          offset,
          value: toArgValue(value),
        })
      );

      const ceCategory: FuzzResultCategory = "failure";
      primaryCounterexample = {
        input: inputElements,
        category: ceCategory,
        exception: true,
        exceptionMessage: rawCe.exception_message,
        exceptionDisplay: `${rawCe.exception_type}: ${rawCe.exception_message}`,
        timeout: false,
        passedImplicit: "fail",
        passedHuman: "unknown",
        passedValidator: "fail",
        shrunk: isShrunk,
        shrinkSteps,
        origin: this._tool === "hypofuzz" ? "Hypofuzz" : "Hypothesis",
      };
      counterexamples.push(primaryCounterexample);
    }

    const isCancelled = Boolean(this._cancelFn?.());
    let status: AgentFuzzStatus = "success";
    if (isCancelled) {
      status = "cancelled";
    } else if (failedTests > 0 || counterexamples.length > 0) {
      status = "counterexample_found";
    }

    const stopReason = isCancelled
      ? FuzzStopReason.PAUSE
      : reportData?.stop_reason === "timeout" ||
          Date.now() - startTime >= suiteTimeoutMs
        ? FuzzStopReason.MAXTIME
        : FuzzStopReason.NOMOREINPUTS;

    let coverageSummary: AgentCoverageSummary | undefined;
    if (reportData?.coverage) {
      const cov = reportData.coverage;
      coverageSummary = {
        statementsTotal: cov.statements_total,
        statementsCovered: cov.statements_covered,
        statementCoveragePercent: cov.statement_pct,
        branchesTotal: cov.branches_total,
        branchesCovered: cov.branches_covered,
        branchCoveragePercent: cov.branch_pct,
        functionsTotal: 0,
        functionsCovered: 0,
        functionCoveragePercent: 100,
        uncoveredLinesByFile: cov.uncovered_lines,
      };
    }

    const resultBase: Omit<AgentFuzzResult, "summaryText"> = {
      status,
      filePath,
      functionName,
      language: "python",
      toolVersion: getToolVersion(),
      totalTests,
      passedTests,
      failedTests,
      erroredTests: 0,
      skippedTests: 0,
      timeouts,
      exceptions,
      stopReason,
      counterexamples,
      primaryCounterexample,
      generators,
      coverage: coverageSummary,
      isPropertyTest: reportData?.is_property_test,
    };

    const summaryText = buildSummaryMarkdown(resultBase);

    return {
      ...resultBase,
      summaryText,
    };
  } // fn: run
} // class: HypothesisRunner

// -------------------------------------------------------------------------- //
// Private Helper Functions
// -------------------------------------------------------------------------- //

interface PbtRunReport {
  total_executions: number;
  pass_count: number;
  fail_count: number;
  timeout_count: number;
  primary_counterexample?: {
    test_name: string;
    inputs: Record<string, unknown>;
    exception_type: string;
    exception_message: string;
  };
  stop_reason: string;
  duration_ms: number;
  coverage?: {
    statements_total: number;
    statements_covered: number;
    statement_pct: number;
    branches_total: number;
    branches_covered: number;
    branch_pct: number;
    uncovered_lines?: Record<string, number[]>;
  };
  is_property_test?: boolean;
}

function parsePbtRunReport(val: unknown): PbtRunReport | undefined {
  if (!isRecord(val)) return undefined;
  const is_property_test =
    typeof val.is_property_test === "boolean"
      ? val.is_property_test
      : undefined;
  const total_executions =
    typeof val.total_executions === "number" ? val.total_executions : 0;
  const pass_count = typeof val.pass_count === "number" ? val.pass_count : 0;
  const fail_count = typeof val.fail_count === "number" ? val.fail_count : 0;
  const timeout_count =
    typeof val.timeout_count === "number" ? val.timeout_count : 0;
  const stop_reason =
    typeof val.stop_reason === "string" ? val.stop_reason : "completed";
  const duration_ms = typeof val.duration_ms === "number" ? val.duration_ms : 0;

  let primary_counterexample: PbtRunReport["primary_counterexample"];
  if (isRecord(val.primary_counterexample)) {
    const rawCe = val.primary_counterexample;
    primary_counterexample = {
      test_name: typeof rawCe.test_name === "string" ? rawCe.test_name : "",
      inputs: isRecord(rawCe.inputs) ? rawCe.inputs : {},
      exception_type:
        typeof rawCe.exception_type === "string"
          ? rawCe.exception_type
          : "Error",
      exception_message:
        typeof rawCe.exception_message === "string"
          ? rawCe.exception_message
          : "",
    };
  }

  let coverage: PbtRunReport["coverage"];
  if (isRecord(val.coverage)) {
    const rawCov = val.coverage;
    const statements_total =
      typeof rawCov.statements_total === "number" ? rawCov.statements_total : 0;
    const statements_covered =
      typeof rawCov.statements_covered === "number"
        ? rawCov.statements_covered
        : 0;
    const statement_pct =
      typeof rawCov.statement_pct === "number" ? rawCov.statement_pct : 0;
    const branches_total =
      typeof rawCov.branches_total === "number" ? rawCov.branches_total : 0;
    const branches_covered =
      typeof rawCov.branches_covered === "number" ? rawCov.branches_covered : 0;
    const branch_pct =
      typeof rawCov.branch_pct === "number" ? rawCov.branch_pct : 0;

    let uncovered_lines: Record<string, number[]> | undefined;
    if (isRecord(rawCov.uncovered_lines)) {
      uncovered_lines = {};
      for (const [k, v] of Object.entries(rawCov.uncovered_lines)) {
        if (Array.isArray(v)) {
          uncovered_lines[k] = v.map(Number);
        }
      }
    }

    coverage = {
      statements_total,
      statements_covered,
      statement_pct,
      branches_total,
      branches_covered,
      branch_pct,
      uncovered_lines,
    };
  }

  return {
    total_executions,
    pass_count,
    fail_count,
    timeout_count,
    primary_counterexample,
    stop_reason,
    duration_ms,
    coverage,
    is_property_test,
  };
} // fn: parsePbtRunReport

function toArgValue(val: unknown): ArgValueType {
  if (
    val === null ||
    val === undefined ||
    typeof val === "boolean" ||
    typeof val === "number" ||
    typeof val === "string" ||
    typeof val === "bigint"
  ) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(toArgValue);
  }
  if (isRecord(val)) {
    const res: Record<string, ArgValueType> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = toArgValue(v);
    }
    return res;
  }
  return String(val);
} // fn: toArgValue

/**
 * Resolves the location of HypothesisRunnerHost.py.
 */
function resolveBridgePath(): string {
  const candidates = [
    path.join(__dirname, "HypothesisRunnerHost.py"),
    path.join(__dirname, "..", "extension", "HypothesisRunnerHost.py"),
    path.resolve(
      path.join(process.cwd(), "build", "extension", "HypothesisRunnerHost.py")
    ),
    path.resolve(
      path.join(
        process.cwd(),
        "src",
        "fuzzer",
        "runners",
        "python",
        "HypothesisRunnerHost.py"
      )
    ),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  throw new Error("Unable to locate HypothesisRunnerHost.py");
} // fn: resolveBridgePath

/**
 * Constructs command line arguments for spawning pytest or hypofuzz.
 */
function buildCliArgs(
  tool: "hypothesis" | "hypofuzz",
  filePath: string,
  functionName: string,
  workerCount: number,
  _interpreter: string
): string[] {
  const bridgeModuleName = "HypothesisRunnerHost";

  if (tool === "hypofuzz") {
    const args = [
      "-c",
      "from hypothesis.extra.cli import main; main()",
      "fuzz",
      "--no-dashboard",
    ];
    if (workerCount > 1) {
      args.push("-n", String(workerCount));
    } else {
      args.push("-n", "1");
    }
    args.push(
      "--",
      "-o",
      "addopts=",
      "-W",
      "ignore",
      filePath,
      "-k",
      functionName,
      "-p",
      bridgeModuleName
    );
    return args;
  }

  return [
    "-m",
    "pytest",
    "-o",
    "addopts=",
    "-W",
    "ignore",
    filePath,
    "-k",
    functionName,
    "-p",
    bridgeModuleName,
    "--hypothesis-show-statistics",
    "-v",
  ];
} // fn: buildCliArgs

/**
 * Sends a signal safely to a child process.
 */
function sendSignal(
  proc: child_process.ChildProcess | undefined,
  signal: NodeJS.Signals
): void {
  if (proc && !proc.killed) {
    try {
      proc.kill(signal);
    } catch {
      // Ignore signal errors
    }
  }
} // fn: sendSignal

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
} // fn: isRecord
