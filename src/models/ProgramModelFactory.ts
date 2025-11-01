import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import { FunctionDef } from "fuzzer/Fuzzer";

let vscode:
  | {
      workspace: {
        getConfiguration: (arg0: string) => {
          get: { (arg0: string, arg1: string): string };
        };
      };
    }
  | undefined;
try {
  vscode = require("vscode");
} catch (e) {
  console.warn(`Unable to load vscode module: not running in vscode?`);
}

// !!!!!!!
export const ProgramModelFactory = {
  create: (fn: FunctionDef): AbstractProgramModel => {
    if (!ProgramModelFactory.isConfigured()) {
      throw new Error(
        "Cannot generate ProgramModel because no model is configured"
      );
    }

    return new GeminiProgramModel(fn);
  }, // !!!!!!

  /** !!!!!! */
  isConfigured: (): boolean => {
    return vscode !== undefined
      ? vscode.workspace
          .getConfiguration("nanofuzz.ai.gemini")
          .get("apitoken", "") !== ""
      : false;
  }, // !!!!!!
};
