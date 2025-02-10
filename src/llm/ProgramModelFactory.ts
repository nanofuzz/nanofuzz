import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import * as vscode from "vscode";
import { FunctionDef } from "fuzzer/Fuzzer";

/** !!!!!! TODO !!!!!!
 *
 * Features:
 * - NoInput should be respected in suggested tests (e.g., unions)
 * - Statistics about number of tests suggested (i)
 * - Telemetry logging for model queries
 * - CodeLens to insert generated specification if missing
 * - Support at least one other model, e.g., Copilot
 *
 * Fix:
 * - Suggested tests should not bypass the fuzz counter like saved tests
 * - Retry/fail logic for Gemini back-end failures (e.g., overloaded)
 * - Missing tests for models, specs
 *
 * Could be better:
 * - _getSuggestedInputs() should return test cases not inputs
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
