import { ProgramDef } from "fuzzer/analysis/typescript/ProgramDef";
import { FunctionRef } from "fuzzer/analysis/typescript/Types";
import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import * as vscode from "vscode";

/** !!!!!! TODO !!!!!!
 *
 * Features:
 * - Inject unit tests into fuzzer
 * - Telemetry logging for model queries
 * - CodeLens to insert generated specification if missing
 * - Support at least one other model, e.g., Copilot
 *
 * Fix:
 * - Retry/fail logic for Gemini back-end failures (e.g., overloaded)
 *
 * Could be better:
 * - Analyze spec during CodeLens analysis phase
 * - Pipeline & sequence queries by concrete implementation
 * - Use real prompt parameterization
 * - Prompt cache invalidation
 * - Singleton concrete models by model, module, fnref
 * -
 */
export abstract class ProgramModelFactory {
  public static create(
    pgm: ProgramDef,
    fnRef: FunctionRef
  ): AbstractProgramModel {
    if (!ProgramModelFactory.isConfigured()) {
      throw new Error(
        "Cannot generate ProgramModel because no model is configured"
      );
    }

    return new GeminiProgramModel(pgm, fnRef);
  } // !!!!!!

  /** !!!!!! */
  public static isConfigured(): boolean {
    return (
      vscode.workspace
        .getConfiguration("nanofuzz.ai.gemini")
        .get("apitoken", "") !== ""
    );
  } // !!!!!!
}
