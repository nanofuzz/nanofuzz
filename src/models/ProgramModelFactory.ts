import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import * as vscode from "vscode";
import { FunctionDef } from "fuzzer/Fuzzer";

// !!!!!!!
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
