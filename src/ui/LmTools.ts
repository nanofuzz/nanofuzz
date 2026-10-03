import * as vscode from "vscode";
import * as JSONN from "../Jsonn";
import { getToolName, listTargets, runFuzz } from "./Agent";

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
}

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
    const { functionName, filePath } = options.input;
    return {
      invocationMessage: `Running ${toolName} on \`${functionName}\` in \`${filePath}\``,
      confirmationMessages: {
        title: `Run ${toolName}`,
        message: `Run ${toolName} fuzz testing on \`${functionName}\` in \`${filePath}\`?`,
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
    } = options.input;

    const resolved = await resolveMatchingModel(vendor, model);

    const result = await runFuzz(
      {
        filePath,
        functionName,
        maxTests,
        suiteTimeout: timeoutMs,
        maxFailures,
        seed,
        model: resolved.model,
        vendor: resolved.vendor,
        enableCopilotAi: true,
      },
      () => token.isCancellationRequested
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result.summaryText),
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
    disposables.push(listTool, fuzzTool);
    context.subscriptions.push(listTool, fuzzTool);
  }

  return disposables;
}

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
};
