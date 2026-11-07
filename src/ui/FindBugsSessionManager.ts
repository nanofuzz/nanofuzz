import { Logger, LoggerEntry } from "../telemetry/Logger";
import {
  FindBugsPhase,
  FindBugsTool,
  FindBugsInvariantSource,
} from "./FindBugs";
import * as crypto from "node:crypto";

/**
 * Record of a single fuzz execution within a FindBugs session.
 */
export type FuzzRunStatsSnapshot = {
  functionName: string;
  filePath: string;
  timestamp: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  erroredTests: number;
  skippedTests: number;
  timeouts: number;
  exceptions: number;
  durationMs: number;
  suiteTimeout?: number;
  maxTests?: number;
  statementCoveragePct?: number;
  branchCoveragePct?: number;
};

/**
 * Record of a phase transition.
 */
export type PhaseTransitionRecord = {
  phaseFrom: FindBugsPhase;
  phaseTo: FindBugsPhase | "complete";
  transitionTimestamp: number;
  durationMs: number;
  fuzzRunsCount: number;
  testsExecuted: number;
  failedTests: number;
};

/**
 * Complete state and telemetry data for a FindBugs workflow session.
 */
export type WorkflowSession = {
  sessionId: string;
  tool: FindBugsTool;
  invariantSource: FindBugsInvariantSource;
  workerCount: number;
  startedAt: number;
  lastPhaseStartedAt: number;
  currentPhase: FindBugsPhase;
  fuzzRuns: FuzzRunStatsSnapshot[];
  transitions: PhaseTransitionRecord[];
};

/**
 * In-memory manager for active FindBugs workflow sessions.
 */
class FindBugsSessionManager {
  private _sessions: Map<string, WorkflowSession> = new Map();
  private _latestSessionId: string | undefined = undefined;

  /**
   * Gets an existing session by ID or creates a new one.
   */
  public getOrCreateSession(
    sessionId: string | undefined,
    tool: FindBugsTool,
    invariantSource: FindBugsInvariantSource,
    workerCount: number,
    initialPhase: FindBugsPhase
  ): WorkflowSession {
    const id =
      sessionId && this._sessions.has(sessionId)
        ? sessionId
        : sessionId || crypto.randomUUID();
    let session = this._sessions.get(id);

    if (!session) {
      const now = Date.now();
      session = {
        sessionId: id,
        tool,
        invariantSource,
        workerCount,
        startedAt: now,
        lastPhaseStartedAt: now,
        currentPhase: initialPhase,
        fuzzRuns: [],
        transitions: [],
      };
      this._sessions.set(id, session);
    } else {
      session.tool = tool;
      session.invariantSource = invariantSource;
      session.workerCount = workerCount;
    }

    this._latestSessionId = id;
    return session;
  } // fn: getOrCreateSession

  /**
   * Retrieves a session by ID or returns the latest active session.
   */
  public getSession(sessionId?: string): WorkflowSession | undefined {
    if (sessionId && this._sessions.has(sessionId)) {
      return this._sessions.get(sessionId);
    }
    if (this._latestSessionId && this._sessions.has(this._latestSessionId)) {
      return this._sessions.get(this._latestSessionId);
    }
    return undefined;
  } // fn: getSession

  /**
   * Records a fuzzing run's execution stats in the session.
   */
  public recordFuzzRun(stats: FuzzRunStatsSnapshot, sessionId?: string): void {
    const session = this.getSession(sessionId);
    if (session) {
      session.fuzzRuns.push(stats);
    }
  } // fn: recordFuzzRun

  /**
   * Handles a phase transition, calculates timing deltas, and emits telemetry.
   */
  public recordTransition(
    session: WorkflowSession,
    nextPhase: FindBugsPhase | "complete"
  ): PhaseTransitionRecord {
    const now = Date.now();
    const durationMs = Math.max(0, now - session.lastPhaseStartedAt);

    // Sum tests and runs since the last transition
    const lastTransitionTime =
      session.transitions.length > 0
        ? session.transitions[session.transitions.length - 1]
            .transitionTimestamp
        : session.startedAt;

    const runsSince = session.fuzzRuns.filter(
      (r) => r.timestamp >= lastTransitionTime
    );
    const testsExecuted = runsSince.reduce((sum, r) => sum + r.totalTests, 0);
    const failedTests = runsSince.reduce((sum, r) => sum + r.failedTests, 0);

    const record: PhaseTransitionRecord = {
      phaseFrom: session.currentPhase,
      phaseTo: nextPhase,
      transitionTimestamp: now,
      durationMs,
      fuzzRunsCount: runsSince.length,
      testsExecuted,
      failedTests,
    };

    session.transitions.push(record);
    session.lastPhaseStartedAt = now;
    if (nextPhase !== "complete") {
      session.currentPhase = nextPhase;
    }

    // Log telemetry event for every phase transition
    const transitionPayload = {
      sessionId: session.sessionId,
      tool: session.tool,
      invariantSource: session.invariantSource,
      workerCount: session.workerCount,
      phaseFrom: record.phaseFrom,
      phaseTo: record.phaseTo,
      stepDurationMs: record.durationMs,
      totalElapsedMs: now - session.startedAt,
      fuzzRunsCount: record.fuzzRunsCount,
      testsExecuted: record.testsExecuted,
      failedTests: record.failedTests,
      totalFuzzRuns: session.fuzzRuns.length,
      cumulativeTests: session.fuzzRuns.reduce(
        (sum, r) => sum + r.totalTests,
        0
      ),
    };

    try {
      Logger.getLogger().push(
        new LoggerEntry(
          "findBugs.stepTransition",
          JSON.stringify(transitionPayload)
        )
      );
    } catch {
      // Logger may not be initialized in isolated test environments
    }

    return record;
  } // fn: recordTransition

  /**
   * Finalizes a session upon workflow completion and logs overall summary telemetry.
   */
  public finalizeSession(session: WorkflowSession): string {
    const now = Date.now();
    const totalDurationMs = Math.max(0, now - session.startedAt);
    const totalTests = session.fuzzRuns.reduce(
      (sum, r) => sum + r.totalTests,
      0
    );
    const totalFailed = session.fuzzRuns.reduce(
      (sum, r) => sum + r.failedTests,
      0
    );

    const finalPayload = {
      sessionId: session.sessionId,
      tool: session.tool,
      invariantSource: session.invariantSource,
      workerCount: session.workerCount,
      totalDurationMs,
      totalFuzzRuns: session.fuzzRuns.length,
      totalTestsExecuted: totalTests,
      totalFailedTests: totalFailed,
      transitions: session.transitions,
    };

    try {
      Logger.getLogger().push(
        new LoggerEntry(
          "findBugs.workflowComplete",
          JSON.stringify(finalPayload)
        )
      );
    } catch {
      // Logger may not be initialized in isolated test environments
    }

    return this.buildTelemetrySummaryMarkdown(session, totalDurationMs);
  } // fn: finalizeSession

  /**
   * Builds formatted markdown ledger summarizing workflow timings and metrics.
   */
  public buildTelemetrySummaryMarkdown(
    session: WorkflowSession,
    totalDurationMs: number
  ): string {
    const lines: string[] = [
      `### ⏱️ Workflow Execution Telemetry`,
      `- **Session ID**: \`${session.sessionId}\``,
      `- **Testing Engine**: \`${session.tool}\`${session.tool !== "nanofuzz" ? ` (workers: ${session.workerCount})` : " (workers: auto)"}`,
      `- **Invariant Source**: \`${session.invariantSource}\``,
      `- **Total Duration**: ${formatMs(totalDurationMs)}`,
      `- **Total Fuzzer Runs**: ${session.fuzzRuns.length}`,
      `- **Total Executions**: ${session.fuzzRuns.reduce((sum, r) => sum + r.totalTests, 0).toLocaleString()}`,
      "",
      `| Step / Phase Transition | Duration | Fuzz Runs | Tests Executed | Failures |`,
      `| :--- | :---: | :---: | :---: | :---: |`,
    ];

    for (const t of session.transitions) {
      lines.push(
        `| \`${t.phaseFrom}\` → \`${t.phaseTo}\` | ${formatMs(t.durationMs)} | ${t.fuzzRunsCount} | ${t.testsExecuted.toLocaleString()} | ${t.failedTests} |`
      );
    }

    return lines.join("\n");
  } // fn: buildTelemetrySummaryMarkdown

  /**
   * Returns true if there is an active session that has not completed.
   */
  public hasActiveSession(sessionId?: string): boolean {
    const s = this.getSession(sessionId);
    return s !== undefined && s.currentPhase !== "complete";
  } // fn: hasActiveSession

  /**
   * Returns true if at least one deep fuzzing run has executed in this session.
   * A true deep run must have been invoked with suiteTimeout >= 60000 ms and maxTests === 0.
   */
  public hasCompletedDeepRun(sessionId?: string): boolean {
    const s = this.getSession(sessionId);
    if (!s || s.fuzzRuns.length === 0) return false;
    return s.fuzzRuns.some(
      (r) =>
        (r.suiteTimeout ?? 0) >= 60000 &&
        (r.maxTests === 0 || r.maxTests === Number.MAX_SAFE_INTEGER)
    );
  } // fn: hasCompletedDeepRun

  /**
   * Resets sessions (for testing).
   */
  public clear(): void {
    this._sessions.clear();
    this._latestSessionId = undefined;
  } // fn: clear
} // class: FindBugsSessionManager

/**
 * Singleton instance of FindBugsSessionManager.
 */
export const sessionManager = new FindBugsSessionManager();

/**
 * Formats milliseconds into human-readable duration string.
 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m ${remSec}s`;
} // fn: formatMs
