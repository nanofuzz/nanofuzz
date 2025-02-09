import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import * as vscode from "vscode";
import { FunctionDef } from "fuzzer/Fuzzer";

/** !!!!!! TODO !!!!!!
 *
 * Features:
 * - Re-determine unit tests to inject at start of fuzzing
 *   (because the ranges may have changed)
 * - Track provenance of inputs, outputs, and judgements
 * - Telemetry logging for model queries
 * - CodeLens to insert generated specification if missing
 * - Support at least one other model, e.g., Copilot
 *
 * Fix:
 * - Retry/fail logic for Gemini back-end failures (e.g., overloaded)
 *
 * Could be better:
 * - Analyze spec during CodeLens analysis phase
 * - Check injected tests to ensure they meet the requirements
 * - Pipeline & sequence queries by concrete implementation
 * - Use real prompt parameterization
 * - Prompt cache invalidation
 * - Singleton concrete models by model, module, fnref
 * - We really need to have just one override format, not two
 * -
 */
export abstract class ProgramModelFactory {
  public static create(fn: FunctionDef): AbstractProgramModel {
    if (!ProgramModelFactory.isConfigured()) {
      throw new Error(
        "Cannot generate ProgramModel because no model is configured"
      );
    }

    return new GeminiProgramModel(fn);
  } // !!!!!!

  /** !!!!!! */
  public static isConfigured(): boolean {
    return (
      vscode.workspace
        .getConfiguration("nanofuzz.ai.gemini")
        .get<string>("apitoken", "") !== ""
    );
  } // !!!!!!
}
