import { FunctionRef, ProgramLanguage } from "../fuzzer/analysis/Types";
import * as ValueMapper from "../fuzzer/mappers/ValueMapper";
import {
  CurrentRunStats,
  FuzzCompilingMessage,
  FuzzInstrumentingMessage,
  FuzzTestingCompleteMessage,
  FuzzTestingMessage,
  FuzzTestResult,
  FuzzTestResults,
  FuzzStopReason,
  FuzzWaitingForGeneratorMessage,
} from "../fuzzer/Types";

/**
 * Formats full execution results and outcome metrics into summary lines for display.
 */
export function formatRunSummary(
  results: FuzzTestResults,
  diagnostics: string[] = [],
  isCancelled: boolean = false
): string {
  const lines: string[] = [];
  const stats = results.stats;
  const outcomes = stats.outcomes;
  const counters = stats.counters;

  if (diagnostics.length) {
    lines.push(" - Input generator warnings:");
    diagnostics.forEach((diag) => {
      lines.push(`   - ${diag}`);
    });
  }

  const stopReason =
    results.stopReason === FuzzStopReason.PAUSE
      ? "interrupted"
      : results.stopReason;

  const dupeText =
    counters.dupesGenerated > 0
      ? ` (${counters.dupesGenerated} were dupes)`
      : "";

  if (counters.inputsInjected > 0) {
    lines.push(
      ` - Injected ${counters.inputsInjected} and generated ${counters.inputsGenerated} inputs${dupeText}`
    );
  } else {
    lines.push(` - Generated ${counters.inputsGenerated} inputs${dupeText}`);
  }

  const ms = stats.timers.total.toFixed(0);
  if (counters.inputsInterrupted) {
    const skippedText =
      counters.inputsSkipped > 0 ? `, skipped ${counters.inputsSkipped}` : "";
    lines.push(
      ` - Executed ${outcomes.total}${skippedText}, interrupted ${counters.inputsInterrupted} in-flight tests in ${ms} ms`
    );
  } else {
    const skippedText =
      counters.inputsSkipped > 0
        ? ` and skipped ${counters.inputsSkipped}`
        : "";
    lines.push(` - Executed ${outcomes.total}${skippedText} tests in ${ms} ms`);
  }

  lines.push(
    `   - Tests with exceptions: ${outcomes.exceptions}, timeouts: ${
      outcomes.timeouts
    }, errors: ${counters.erroredTests}`
  );

  const useHuman = results.env?.options?.useHuman ?? false;
  const hasHuman =
    useHuman &&
    ((outcomes.oracles?.human?.pass ?? 0) +
      (outcomes.oracles?.human?.fail ?? 0) >
      0 ||
      Boolean(
        results.results?.some(
          (r) => r.expectedOutput && r.expectedOutput.length > 0
        )
      ));
  if (hasHuman) {
    lines.push(
      `   - Human validator passed: ${outcomes.oracles.human.pass}, failed: ${outcomes.oracles.human.fail}`
    );
  }

  const useProperty = results.env?.options?.useProperty ?? false;
  const hasProperty =
    useProperty &&
    ((results.env?.validators && results.env.validators.length > 0) ||
      (outcomes.oracles?.property?.pass ?? 0) +
        (outcomes.oracles?.property?.fail ?? 0) >
        0);
  if (hasProperty) {
    lines.push(
      `   - Property validator passed: ${outcomes.oracles.property.pass}, failed: ${outcomes.oracles.property.fail}`
    );
  }

  const useHeuristic = results.env?.options?.useImplicit ?? false;
  const hasHeuristic =
    useHeuristic &&
    (outcomes.oracles?.heuristic?.pass ?? 0) +
      (outcomes.oracles?.heuristic?.fail ?? 0) >
      0;
  if (hasHeuristic) {
    lines.push(
      `   - Heuristic validator passed: ${outcomes.oracles.heuristic.pass}, failed: ${outcomes.oracles.heuristic.fail}`
    );
  }

  if (results.env?.options?.outputFile) {
    lines.push(` - Test results: ${results.env.options.outputFile}`);
  }

  const firstFailing = outcomes.firstFailure;
  if (firstFailing) {
    lines.push(
      formatFailureBlock(
        results.env.function.getName(),
        firstFailing,
        results.env.function.getLang(),
        results.env.validators,
        results.env.options.fnTimeout
      )
    );
  }

  const stopReasonStr = stopReason ? ` Stopped for reason: ${stopReason}.` : "";
  lines.push(
    `Testing ${isCancelled ? "interrupted" : "finished"}.${stopReasonStr}`
  );

  return lines.join("\n");
} // fn: formatRunSummary

/**
 * Formats a single failing result into a terminal-width failure block.
 */
export function formatFailureBlock(
  targetFnName: string,
  result: FuzzTestResult,
  lang: ProgramLanguage,
  validators: FunctionRef[],
  fnTimeout: number = 500,
  termWidth: number = typeof process !== "undefined" &&
  process.stdout &&
  process.stdout.columns &&
  process.stdout.columns > 0
    ? process.stdout.columns
    : 80
): string {
  const border = "=".repeat(termWidth);
  const dashBorder = " -".repeat(Math.floor(termWidth / 2));
  const lines: string[] = [border];

  const argStr = result.input
    .map((i) => ValueMapper.toLang(lang, i.value))
    .join(", ");

  const origArgStr = result.inputGenerated?.value
    ? result.inputGenerated.value
        .map((v) => ValueMapper.toLang(lang, v.value))
        .join(", ")
    : argStr;

  const fnCall = `${targetFnName}(${argStr})`;

  const isPinned = result.inputGenerated?.injected;
  const shrinkStep = result.shrinkStep ?? 0;
  const shrinkSuffix = isPinned
    ? " \x1b[2m(Pinned Test)\x1b[0m"
    : shrinkStep > 0
      ? ` \x1b[2m(Shrunk in ${shrinkStep} step${shrinkStep === 1 ? "" : "s"})\x1b[0m`
      : "";

  const getFailedValidatorsStr = (): string => {
    const failedNames: string[] = [];
    if (result.passedValidators) {
      result.passedValidators.forEach((j, i) => {
        if (j === "fail" && validators[i]) {
          failedNames.push(validators[i].name);
        }
      });
    }
    if (failedNames.length > 0) {
      const pl = failedNames.length > 1 ? "s" : "";
      return `Property Validator${pl} (${failedNames.join(", ")})`;
    }
    if (result.passedHuman === "fail") return "Example Oracle";
    if (result.passedImplicit === "fail") return "Heuristic Validator";
    return "Unknown Validator";
  }; // fn: getFailedValidatorsStr

  switch (result.category) {
    case "badValue": {
      lines.push(`❌ FAILED by ${getFailedValidatorsStr()}:`);
      lines.push(`   - Failing test input     : ${argStr}${shrinkSuffix}`);
      lines.push(
        `   - Test output            : ${ValueMapper.toLang(
          lang,
          result.output[0]?.value
        )}`
      );
      if (
        result.passedHuman === "fail" &&
        result.expectedOutput &&
        result.expectedOutput.length > 0
      ) {
        const exp = result.expectedOutput[0];
        const expStr = exp.isTimeout
          ? "(timeout)"
          : exp.isException
            ? "(exception)"
            : ValueMapper.toLang(lang, exp.value);
        lines.push(`   - Expected output        : ${expStr}`);
      }
      break;
    }

    case "exception": {
      lines.push(`❌ EXCEPTION:`);
      lines.push(`   - Failing test input     : ${argStr}${shrinkSuffix}`);
      lines.push(`   - Test output            : (none)`);
      lines.push(`   - Failed Validator(s)    : Heuristic Validator`);

      const { excLine, stackLines } = formatExceptionAndStack(
        result.exceptionMessage,
        result.stack
      );

      if (excLine || stackLines.length > 0) {
        lines.push(dashBorder);
        if (excLine) {
          lines.push(excLine);
        }
        if (stackLines.length > 0) {
          lines.push(stackLines.join("\n"));
        }
      }
      break;
    }

    case "timeout": {
      lines.push(`❌ TIMEOUT failed by Heuristic Validator:`);
      lines.push(`   - Failing test input     : ${argStr}${shrinkSuffix}`);
      lines.push(`   - Timeout after          : ${fnTimeout} ms`);
      break;
    }

    case "disagree": {
      lines.push(`❌ DISAGREEMENT: ${fnCall}`);
      lines.push(`   - Test input             : ${argStr}`);
      lines.push(
        `   - Test output            : ${ValueMapper.toLang(
          lang,
          result.output[0]?.value
        )}`
      );
      const propFailed = getFailedValidatorsStr();
      lines.push(
        `   - Oracle Judgments       : ${propFailed} => "fail", Example Oracle => "pass"`
      );
      lines.push(
        `   - Diagnosis              : Property validator disagreed with the expected output. Check validator function for bugs.`
      );
      break;
    }

    case "failure": {
      if (result.harnessErrors.length > 0) {
        const err = result.harnessErrors[0];
        const isTransformer = err.stage === "transformer";
        const typeLabel = isTransformer
          ? "Input transformer"
          : "Property validator";
        const isTimeout = err.kind === "timeout";
        const headerText = isTimeout
          ? `${typeLabel} timed out`
          : `${typeLabel} threw an exception`;

        const testOutputStr = isTransformer
          ? "(not executed)"
          : result.output.length > 0
            ? ValueMapper.toLang(lang, result.output[0]?.value)
            : result.exception
              ? `(exception${result.exceptionMessage ? `: ${result.exceptionMessage}` : ""})`
              : result.timeout
                ? `(timeout after ${fnTimeout} ms)`
                : "(none)";

        lines.push(`❌ TESTING ERROR: ${headerText}`);
        lines.push(
          `   - ${
            isTransformer
              ? "Transformer Function   "
              : "Validator Function     "
          }: ${err.fnName}`
        );
        lines.push(
          `   - ${isTransformer ? "Was transforming:" : "Was validating:"}`
        );
        lines.push(
          `     - ${
            isTransformer ? "Test input (generated)" : "Test input           "
          }: ${isTransformer ? origArgStr : argStr}`
        );
        lines.push(`     - Test output          : ${testOutputStr}`);

        const { excLine, stackLines } = formatExceptionAndStack(
          isTimeout ? `Timeout exceeding ${fnTimeout} ms` : err.message,
          err.kind === "exception" ? err.stack : undefined
        );

        if (excLine || stackLines.length > 0) {
          lines.push(dashBorder);
          if (excLine) {
            lines.push(excLine);
          }
          if (stackLines.length > 0) {
            lines.push(stackLines.join("\n"));
          }
        }
      }
      break;
    }

    case "ok":
    case "skip":
      break;
  }

  lines.push(border);
  return lines.join("\n");
} // fn: formatFailureBlock

/**
 * Extracts and formats exception header and stack trace lines for failure blocks.
 */
export function formatExceptionAndStack(
  message?: string,
  stack?: string,
  defaultName: string = "Error"
): { excLine: string; stackLines: string[] } {
  let excLine = "";
  if (message) {
    const formattedMsg =
      message.startsWith("Error:") || message.includes(":")
        ? message
        : `${defaultName}: ${message}`;
    excLine = ` ${formattedMsg}`;
  }

  const stackLines: string[] = [];
  if (stack) {
    const rawLines = stack
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of rawLines) {
      if (/^\s*(at\s|File\s|Traceback\b)/.test(line)) {
        stackLines.push(`   \x1b[2m${line}\x1b[0m`);
      } else if (!excLine) {
        excLine = ` ${line}`;
      }
    }
  }

  return { excLine, stackLines };
} // fn: formatExceptionAndStack

/**
 * Formats passed, failed, errored, and skipped test counts for update messages.
 */
export function formatRunStatsSummary(runStats: CurrentRunStats): string {
  return `\r\n  Passed: ${runStats.counters.passedTests}\r\n  Failed: ${
    runStats.counters.failedTests
  }${
    runStats.counters.erroredTests
      ? `\r\n Errored: ${runStats.counters.erroredTests}`
      : ""
  }${
    runStats.counters.inputsSkipped
      ? `\r\n Skipped: ${runStats.counters.inputsSkipped}`
      : ""
  }`;
} // fn: formatRunStatsSummary

/**
 * Formats a live test execution message for status notifications.
 *
 * @param msg The testing message containing function details, inputs, and stats.
 * @returns Formatted message string for status updates.
 */
export function formatTestingStatus(msg: FuzzTestingMessage): string {
  const totalExecuted =
    msg.stats.counters.passedTests +
    msg.stats.counters.failedTests +
    msg.stats.counters.erroredTests +
    1;
  const args = msg.inputs.map((v) => ValueMapper.toLang(msg.lang, v)).join(",");
  const prefix =
    msg.isCancelled && msg.stillInjecting
      ? "Interrupt pending retest of prior inputs.\r\n"
      : "";
  const action = msg.stillInjecting ? "Retesting prior" : "Testing new";
  return `${prefix}${action} input# ${totalExecuted}: ${msg.fnName}(${args})${formatRunStatsSummary(
    msg.stats
  )}`;
} // fn: formatTestingStatus

/**
 * Formats a generator waiting message for status notifications.
 *
 * @param msg The waiting message containing pending generators and stats.
 * @returns Formatted message string for generator wait status.
 */
export function formatWaitingStatus(
  msg: FuzzWaitingForGeneratorMessage
): string {
  const pendingLabel = msg.pendingGenerators.length
    ? msg.pendingGenerators.join(", ") + " "
    : "";
  return `Waiting for ${pendingLabel}input generator...${formatRunStatsSummary(
    msg.stats
  )}`;
} // fn: formatWaitingStatus

/**
 * Formats a compilation message for display.
 *
 * @param msg The compilation message.
 * @returns Formatted message string.
 */
export function formatCompilingStatus(msg: FuzzCompilingMessage): string {
  return ` - Compile...: ${normalizePathForDisplay(msg.file)}`;
} // fn: formatCompilingStatus

/**
 * Formats an instrumentation message for display.
 *
 * @param msg The instrumentation message.
 * @returns Formatted message string.
 */
export function formatInstrumentingStatus(
  msg: FuzzInstrumentingMessage
): string {
  return ` - Instrument: ${normalizePathForDisplay(msg.file)}`;
} // fn: formatInstrumentingStatus

/**
 * Formats a test completion message for display.
 *
 * @param msg The test complete message.
 * @returns Formatted message string.
 */
export function formatTestingCompleteStatus(
  msg: FuzzTestingCompleteMessage
): string {
  return `Testing ${msg.cancelled ? "interrupted" : "finished"}.`;
} // fn: formatTestingCompleteStatus

/**
 * Normalizes a temporary compilation/instrumentation file path to a clean user-facing path.
 *
 * @param cleanPath Clean source path under tmpDir
 * @param tmpDir Temporary compilation directory
 * @returns Cleaned normalized display path
 */
export function normalizeDisplayPath(
  cleanPath: string,
  tmpDir: string
): string {
  const normClean = cleanPath.replace(/\\/g, "/");
  const normTmp = tmpDir.replace(/\\/g, "/");
  let displayPath = normClean.startsWith(normTmp)
    ? normClean.slice(normTmp.length).replace(/^\/+/, "")
    : normClean;
  displayPath = displayPath.replace(/^inst-[^/]+\/?/, "");
  if (typeof process !== "undefined" && process.platform === "win32") {
    if (/^[a-zA-Z]\//.test(displayPath)) {
      displayPath = displayPath.charAt(0) + ":" + displayPath.substring(1);
    }
  } else {
    if (!displayPath.startsWith("/")) {
      displayPath = "/" + displayPath;
    }
  }
  return displayPath;
} // fn: normalizeDisplayPath

/**
 * Normalizes a file path relative to current working directory when located within it.
 * Maps compiled JavaScript files back to their TypeScript source if the source exists.
 *
 * @param filePath Path to normalize for display
 * @returns Normalized user-facing path
 */
function normalizePathForDisplay(filePath: string): string {
  let displayPath = filePath.replace(/\\/g, "/");
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    const cwd = process.cwd().replace(/\\/g, "/");
    if (displayPath.startsWith(cwd + "/")) {
      displayPath = displayPath.slice(cwd.length + 1);
    }
  }
  if (displayPath.endsWith(".js")) {
    displayPath = displayPath.slice(0, -3) + ".ts";
  }
  return displayPath;
} // fn: normalizePathForDisplay
