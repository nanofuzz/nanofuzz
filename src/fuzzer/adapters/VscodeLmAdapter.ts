import * as vscode from "vscode";
import * as JSONN from "../../Jsonn";
import {
  getToolName,
  listTargets,
  runFuzz,
  showResults,
  shrinkInputs,
  ShowResultsOptions,
  ShowResultsResult,
  AgentShrinkOptions,
  AgentTestCase,
} from "../../ui/Agent";
import { CoverageScope } from "../measures/Types";
import { findBugs, FindBugsOptions, FindBugsPhase } from "../../ui/FindBugs";
import { getDisplayPath } from "../../Util";

// -------------------------------------------------------------------------- //
// Tool Implementations & Helpers
// -------------------------------------------------------------------------- //

/**
 * Resolves the best-matching VS Code Language Model for a requested vendor and model name.
 * Handles fuzzy matching, non-existent model fallbacks, and vendor filtering.
 *
 * @param vendor Optional vendor name provided by the calling agent (e.g. 'google', 'copilot')
 * @param model Optional model name provided by the calling agent (e.g. 'gemini-3.7-flash')
 * @returns Object with the resolved vendor and model family/id
 */
export async function resolveMatchingModel(
  vendor?: string,
  model?: string
): Promise<{ vendor?: string; model?: string }> {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
    return { vendor, model };
  }

  const allModels = await vscode.lm.selectChatModels();
  if (!allModels || allModels.length === 0) {
    return { vendor, model };
  }

  let candidates = allModels;

  // 1. If vendor is specified, attempt vendor filtering
  if (vendor) {
    const vNorm = vendor.toLowerCase().replace(/[^a-z0-9]/g, "");
    const vendorMatches = allModels.filter((m) => {
      const v = (m.vendor || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const id = (m.id || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return v.includes(vNorm) || vNorm.includes(v) || id.startsWith(vNorm);
    });
    if (vendorMatches.length > 0) {
      candidates = vendorMatches;
    }
  }

  // 2. If model is specified, attempt model name/family/id matching
  let selected = candidates[0];
  if (model) {
    const mNorm = model.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matched = candidates.find((m) => {
      const f = (m.family || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const n = (m.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const i = (m.id || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        f.includes(mNorm) ||
        n.includes(mNorm) ||
        i.includes(mNorm) ||
        mNorm.includes(f) ||
        mNorm.includes(n) ||
        mNorm.includes(i)
      );
    });

    if (matched) {
      selected = matched;
    } else if (candidates !== allModels) {
      // Check across all vendors if the vendor filter was too restrictive
      const globalMatch = allModels.find((m) => {
        const f = (m.family || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const n = (m.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const i = (m.id || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        return (
          f.includes(mNorm) ||
          n.includes(mNorm) ||
          i.includes(mNorm) ||
          mNorm.includes(f) ||
          mNorm.includes(n) ||
          mNorm.includes(i)
        );
      });
      if (globalMatch) {
        selected = globalMatch;
      }
    }
  }

  return {
    vendor: selected.vendor,
    model: selected.family || selected.id || selected.name,
  };
} // fn: resolveMatchingModel

/**
 * Language model tool for discovering exported functions and type signatures.
 */
export class ListTargetsTool implements vscode.LanguageModelTool<ListTargetsInput> {
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ListTargetsInput>
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const toolName = getToolName();
    return {
      invocationMessage: `Listing ${toolName} fuzz targets in \`${options.input.filePath}\``,
    };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListTargetsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const targets = await listTargets(options.input.filePath);
    const text = JSONN.stringify(targets, null, 2);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text),
    ]);
  }
}

/**
 * Language model tool for running fuzzing sessions on target functions.
 */
export class FuzzFunctionTool implements vscode.LanguageModelTool<FuzzFunctionInput> {
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FuzzFunctionInput>
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const toolName = getToolName();
    const { functionName, filePath, timeoutMs, maxTests, maxFailures } =
      options.input;
    const displayPath = getDisplayPath(filePath);
    const target = `'${displayPath}::${functionName}'`;

    const constraints: string[] = [];
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      constraints.push(formatDuration(timeoutMs));
    }
    if (typeof maxTests === "number" && maxTests > 0) {
      constraints.push(`${formatCount(maxTests)} tests`);
    }
    if (typeof maxFailures === "number" && maxFailures > 0) {
      constraints.push(
        maxFailures === 1 ? "1 failure" : `${maxFailures} failures`
      );
    }

    const constraintSuffix =
      constraints.length > 0 ? ` up to ${constraints.join(" or ")}` : "";

    return {
      invocationMessage: `Running ${toolName} on ${target}${constraintSuffix}`,
      confirmationMessages: {
        title: `${toolName} ${target}`,
        message: `Run ${toolName} on ${target}${constraintSuffix}?`,
      },
    };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FuzzFunctionInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const {
      filePath,
      functionName,
      maxTests,
      timeoutMs,
      maxFailures,
      seed,
      model,
      vendor,
      inputs,
      tests,
      exportSuite,
      exportFilePath,
      coverageScope,
      fnTimeout,
      useTransformer,
    } = options.input;

    const resolved = await resolveMatchingModel(vendor, model);

    const toolName = getToolName();
    const displayPath = getDisplayPath(filePath);
    const target = `'${displayPath}::${functionName}'`;

    // Create a live status bar item on the bottom toolbar
    const statusBarItem =
      typeof vscode.window?.createStatusBarItem === "function"
        ? vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment?.Left,
            10000
          )
        : undefined;
    if (statusBarItem) {
      statusBarItem.name = `${toolName} Progress`;
      statusBarItem.text = `$(beaker) ${toolName}: ${target}`;
      statusBarItem.tooltip = `Fuzzing ${target} with ${toolName}`;
      statusBarItem.show();
    }

    const runFuzzWithOptions = async (
      progress?: vscode.Progress<{ message?: string; increment?: number }>
    ) => {
      let lastReportedPct = -1;
      return await runFuzz(
        {
          filePath,
          functionName,
          maxTests,
          fnTimeout,
          suiteTimeout: timeoutMs,
          maxFailures,
          seed,
          model: resolved.model,
          vendor: resolved.vendor,
          inputs,
          tests,
          exportSuite,
          exportFilePath,
          coverageScope,
          useTransformer,
          enableCopilotAi: true,
        },
        () => token.isCancellationRequested,
        (status) => {
          let detail = "";
          if (status.type === "compiling") {
            detail = "compiling...";
          } else if (status.type === "instrumenting") {
            detail = "instrumenting...";
          } else if (status.type === "testing") {
            const testsCount = status.stats?.outcomes?.total ?? 0;
            const formattedTests =
              testsCount >= 1000 ? formatCount(testsCount) : `${testsCount}`;
            const rawPct =
              status.pct <= 1 && status.pct > 0 ? status.pct * 100 : status.pct;
            const pct = Math.min(100, Math.max(0, Math.round(rawPct)));
            detail = `${formattedTests} tests (${pct}%)`;
            if (pct !== lastReportedPct || testsCount % 500 === 0) {
              lastReportedPct = pct;
              progress?.report({
                message: `${formattedTests} tests (${pct}% complete)`,
              });
            }
          } else if (status.type === "waiting-for-generator") {
            detail = "waiting for AI generator...";
            progress?.report({ message: detail });
          } else if (status.type === "testing-complete") {
            detail = "done";
            progress?.report({ message: detail });
          }

          if (statusBarItem && detail) {
            statusBarItem.text = `$(beaker) ${toolName}: ${target} - ${detail}`;
          }
        }
      );
    };

    let result: Awaited<ReturnType<typeof runFuzzWithOptions>>;
    try {
      const hasWithProgress =
        typeof vscode.window?.withProgress === "function" &&
        vscode.ProgressLocation?.Window !== undefined;

      result = hasWithProgress
        ? await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: `${toolName}: ${target}`,
            },
            runFuzzWithOptions
          )
        : await runFuzzWithOptions();
    } finally {
      statusBarItem?.dispose();
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result.summaryText),
    ]);
  }
}

/**
 * Language model tool for multi-turn bug discovery workflows.
 */
export class FindBugsTool implements vscode.LanguageModelTool<FindBugsInput> {
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FindBugsInput>
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const toolName = getToolName();
    const phase = options.input.phase ?? "init";
    return {
      invocationMessage: `${toolName} Find Bugs: Phase [${phase}]`,
    };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FindBugsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await findBugs(options.input);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result.summaryText),
    ]);
  }
}

/**
 * Language model tool for displaying fuzz test results in FuzzPanel.
 */
export class ShowResultsTool implements vscode.LanguageModelTool<ShowResultsInput> {
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ShowResultsInput>
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const toolName = getToolName();
    const { functionName } = options.input;
    return {
      invocationMessage: `Displaying ${toolName} results for \`${functionName}\` in FuzzPanel`,
    };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ShowResultsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const res: ShowResultsResult = await showResults(options.input);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(res.message),
    ]);
  }
}

/**
 * Language model tool for standalone input shrinking.
 */
export class ShrinkInputsTool implements vscode.LanguageModelTool<ShrinkInputsInput> {
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ShrinkInputsInput>
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const toolName = getToolName();
    const { functionName, filePath } = options.input;
    return {
      invocationMessage: `Shrinking test inputs for \`${functionName}\` in \`${filePath}\` with ${toolName}`,
    };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ShrinkInputsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const res = await shrinkInputs(options.input);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(res.summaryText),
    ]);
  }
}

/**
 * Registers all Language Model Tools with VS Code.
 *
 * @param context Extension context or object containing subscriptions array
 * @returns Array of disposables for the registered tools
 */
export function registerLmTools(context: {
  subscriptions: vscode.Disposable[];
}): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  if (typeof vscode.lm?.registerTool === "function") {
    const listTool = vscode.lm.registerTool(
      "nanofuzz_listTargets",
      new ListTargetsTool()
    );
    const fuzzTool = vscode.lm.registerTool(
      "nanofuzz_fuzzFunction",
      new FuzzFunctionTool()
    );
    const bugsTool = vscode.lm.registerTool(
      "nanofuzz_findBugs",
      new FindBugsTool()
    );
    const showResultsTool = vscode.lm.registerTool(
      "nanofuzz_showResults",
      new ShowResultsTool()
    );
    const shrinkTool = vscode.lm.registerTool(
      "nanofuzz_shrinkInputs",
      new ShrinkInputsTool()
    );
    disposables.push(listTool, fuzzTool, bugsTool, showResultsTool, shrinkTool);
    context.subscriptions.push(
      listTool,
      fuzzTool,
      bugsTool,
      showResultsTool,
      shrinkTool
    );
  }

  return disposables;
} // fn: registerLmTools

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Input arguments for the nanofuzz_listTargets tool
 */
export type ListTargetsInput = {
  filePath: string;
};

/**
 * Input arguments for the nanofuzz_fuzzFunction tool
 */
export type FuzzFunctionInput = {
  filePath: string;
  functionName: string;
  maxTests?: number;
  timeoutMs?: number;
  maxFailures?: number;
  seed?: string;
  model?: string;
  vendor?: string;
  inputs?: (Record<string, unknown> | unknown[])[];
  tests?: (AgentTestCase | Record<string, unknown> | unknown[])[];
  exportSuite?: boolean;
  exportFilePath?: string;
  coverageScope?: CoverageScope;
  fnTimeout?: number;
  useTransformer?: boolean;
};

/**
 * Input arguments for the nanofuzz_findBugs tool
 */
export type FindBugsInput = FindBugsOptions;
export type { FindBugsPhase };

/**
 * Input arguments for the nanofuzz_showResults tool
 */
export type ShowResultsInput = ShowResultsOptions;

/**
 * Input arguments for the nanofuzz_shrinkInputs tool
 */
export type ShrinkInputsInput = AgentShrinkOptions;

/**
 * Formats duration in milliseconds into a concise string (e.g. 500ms, 3s, 5m, 1h).
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
  }
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
} // fn: formatDuration

/**
 * Formats a count into a concise metric format (e.g. 100, 5k, 100k, 1M).
 */
function formatCount(count: number): string {
  if (count < 1000) {
    return `${count}`;
  }
  if (count < 1_000_000) {
    const k = count / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  const m = count / 1_000_000;
  return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
} // fn: formatCount
