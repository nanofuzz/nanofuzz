import * as vscode from "vscode";
import * as JSONN from "../Jsonn";
import { getToolName, listTargets, runFuzz } from "./Agent";

// -------------------------------------------------------------------------- //
// Tool Implementations
// -------------------------------------------------------------------------- //

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
    const { filePath, functionName, maxTests, timeoutMs, maxFailures, seed } =
      options.input;

    const result = await runFuzz(
      {
        filePath,
        functionName,
        maxTests,
        suiteTimeout: timeoutMs,
        maxFailures,
        seed,
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
};
