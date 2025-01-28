import { ProgramDef } from "fuzzer/analysis/typescript/ProgramDef";
import { FunctionRef } from "fuzzer/analysis/typescript/Types";
import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import * as vscode from "vscode";

/** !!!!!! TODO !!!!!!
 *
 * - Retrieve spec from program code if present
 * - Pipeline & sequence queries by concrete implementation
 * - Prompt cache invalidation
 * - Singletons by model, module, fnref
 * - Handle Gemini back-end failures (e.g., overloaded; try again later)
 * - CodeLens to insert generated specification
 * - Support some other models
 * - Telemetry logging for model queries
 * - FuzzPanel buttons aren't getting disabled on busyAnalyzing
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
