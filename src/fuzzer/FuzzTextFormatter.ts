import { FunctionRef, ProgramLanguage } from "./analysis/Types";
import * as ValueMapper from "./mappers/ValueMapper";
import { CurrentRunStats, FuzzTestResult, FuzzTestResults } from "./Types";

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

  lines.push(
    ` - Executed ${outcomes.total} and skipped ${
      counters.inputsSkipped
    } tests in ${stats.timers.total.toFixed(0)} ms this run. Stopped for reason: ${
      results.stopReason
    }.`
  );
  lines.push(
    ` - Injected ${counters.inputsInjected} and generated ${
      counters.inputsGenerated
    } inputs (${counters.dupesGenerated} were dupes) this run.`
  );
  lines.push(
    ` - Total tests with exceptions: ${outcomes.exceptions}, timeouts: ${
      outcomes.timeouts
    }, errors: ${counters.erroredTests}`
  );
  lines.push(
    ` - Total tests where human validator passed: ${outcomes.oracles.human.pass}, failed: ${outcomes.oracles.human.fail}`
  );
  lines.push(
    ` - Total tests where property validator passed: ${outcomes.oracles.property.pass}, failed: ${outcomes.oracles.property.fail}`
  );
  lines.push(
    ` - Total tests where heuristic validator passed: ${outcomes.oracles.heuristic.pass}, failed: ${outcomes.oracles.heuristic.fail}`
  );

  if (results.env.options.outputFile) {
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

  lines.push(`Testing ${isCancelled ? "interrupted" : "finished"}.`);

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
  fnTimeout: number = 200,
  termWidth: number = process.stdout.columns && process.stdout.columns > 0
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
 * Formats a live candidate test execution message for status notifications.
 *
 * @param targetFnName Name of the function under test.
 * @param lang Language of the module.
 * @param inputValues Raw argument values of the test candidate.
 * @param runStats Current run stats.
 * @param stillInjecting True if still injecting pinned inputs.
 * @param isCancelled True if cancellation has been requested.
 * @returns Formatted message string for status updates.
 */
export function formatCandidateStatus(
  targetFnName: string,
  lang: ProgramLanguage,
  inputValues: unknown[],
  runStats: CurrentRunStats,
  stillInjecting: boolean = false,
  isCancelled: boolean = false
): string {
  const totalExecuted =
    runStats.counters.passedTests +
    runStats.counters.failedTests +
    runStats.counters.erroredTests +
    1;
  const args = inputValues.map((v) => ValueMapper.toLang(lang, v)).join(",");
  const prefix =
    isCancelled && stillInjecting
      ? "Interrupt pending retest of prior inputs.\r\n"
      : "";
  const action = stillInjecting ? "Retesting prior" : "Testing new";
  return `${prefix}${action} input# ${totalExecuted}: ${targetFnName}(${args})${formatRunStatsSummary(
    runStats
  )}`;
} // fn: formatCandidateStatus

/**
 * Formats a generator waiting message for status notifications.
 *
 * @param pendingGeneratorNames Names of generators currently producing inputs asynchronously.
 * @param runStats Current run stats.
 * @returns Formatted message string for generator wait status.
 */
export function formatWaitingStatus(
  pendingGeneratorNames: string[],
  runStats: CurrentRunStats
): string {
  const pendingLabel = pendingGeneratorNames.length
    ? pendingGeneratorNames.join(", ") + " "
    : "";
  return `Waiting for ${pendingLabel}input generator...${formatRunStatsSummary(
    runStats
  )}`;
} // fn: formatWaitingStatus
