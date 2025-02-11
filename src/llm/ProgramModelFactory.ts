import { AbstractProgramModel } from "./AbstractProgramModel";
import { GeminiProgramModel } from "./GeminiProgramModel";
import * as vscode from "vscode";
import { FunctionDef } from "fuzzer/Fuzzer";

/** !!!!!! TODO !!!!!!
 *
 * Features:
 * - Suggest expected output
 * - Batch up LLM predictOutputs
 * - Impleent Composite Oracle from paper in Fuzzer
 * - Also generate property test & compare
 * - Score / rank tests
 * - Sticky tabs
 * - Suggested tests should respect NoOutput (i.e., unions, objects)
 * - Update tab explanations to account for LLM oracle
 * - More options llm settings
 * - Disable or hide LLM options if not active feedback if configured but running w/o
 * - Statistics about number of tests suggested (i)
 * - Telemetry logging for model queries
 * - CodeLens to insert generated specification if missing
 * - Support at least one other model, e.g., Copilot
 * - Experiment w/problems tab
 * - Process all the !!!!!!
 *
 * Fix:
 * - Validate incoming model tests
 * - Schemas for literal unions do not look right:
 *   [{type:"'hello' | 'bonjour' | 'olá' | 'ciao' | 'hej'",arrayDimensions:[],name:'z',typeName:'hellos',children:[{type:'literal',arrayDimensions:[]},{type:'literal',arrayDimensions:[]},{type:'literal',arrayDimensions:[]},{type:'literal',arrayDimensions:[]},{type:'literal',arrayDimensions:[]}]}]
 * - Retry/fail logic for model back-end failures (e.g., overloaded) (esp. within fuzzer)
 * - Add tests for models, specs
 * - Use real prompt parameterization
 * - Prompt cache invalidation & hash key
 *
 * Could be better:
 * - _getSuggestedInputs() should return test cases not inputs
 * - Analyze spec during CodeLens analysis phase (perf)
 * - Check injected tests to ensure they meet the requirements
 * - Pipeline & sequence queries by concrete implementation
 * - Singleton concrete models by model, module, fnref
 * - Would benefit from having one override format, not two
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
