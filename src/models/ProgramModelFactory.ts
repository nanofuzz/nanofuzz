import { AbstractProgramModel } from "./AbstractProgramModel";
import { CopilotProgramModel } from "./CopilotProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import { FunctionDef } from "fuzzer/Fuzzer";
import * as JSON5 from "json5";

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

// !!!!!!
const modelCache: Record<string, AbstractProgramModel> = {};

// !!!!!!!
export const ProgramModelFactory = {
  create: (fn: FunctionDef): AbstractProgramModel => {
    if (!ProgramModelFactory.isConfigured()) {
      throw new Error(
        "Cannot generate ProgramModel because no model is configured"
      );
    }

    const fnRefString = JSON5.stringify(fn.getRef());
    if (fnRefString in modelCache) {
      return modelCache[fnRefString];
    } else {
      const model = new CopilotProgramModel(fn); // !!!!!!!!
      //const model= new GeminiProgramModel(fn); // !!!!!!
      modelCache[fnRefString] = model;
      return model;
    }
  }, // !!!!!!

  /** !!!!!! */
  isConfigured: (): boolean => {
    return vscode !== undefined
      ? vscode.workspace
          .getConfiguration("nanofuzz.ai.gemini") // !!!!!!!!!
          .get("apitoken", "") !== ""
      : false;
  }, // !!!!!!
};
