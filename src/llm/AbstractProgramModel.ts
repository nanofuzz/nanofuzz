import { FunctionRef } from "../fuzzer/analysis/typescript/Types";
import { ProgramDef } from "../fuzzer/analysis/typescript/ProgramDef";
import * as vscode from "vscode";
import { ModelInputRanges } from "./Types";

export abstract class AbstractProgramModel {
  protected readonly _cfgCategory: string;
  protected _prompts: Record<string, string> = {};
  protected _fnRef: FunctionRef;
  protected _spec = "";
  protected _state: "notready" | "ready" = "notready";
  protected _inputSchema;
  protected _overrides;

  protected constructor(
    pgm: ProgramDef,
    fnRef: FunctionRef,
    cfgCategory: string
  ) {
    const thisFn = pgm.getExportedFunctions()[fnRef.name];

    this._cfgCategory = cfgCategory;
    this._fnRef = fnRef;
    this._inputSchema = thisFn.getJsonSignature();
    this._overrides = thisFn.getJsonOverrides();
    this._concretizePrompts();
  }

  protected _getConfig<T>(section: string, dft: T): T {
    return vscode.workspace
      .getConfiguration("nanofuzz.ai." + this._cfgCategory)
      .get(section, dft);
  }

  protected _concretizePrompts(translations?: Record<string, string>): void {
    const allTranslations: Record<string, string> = {
      "fn-name": this._fnRef.name,
      "fn-source": this._fnRef.src,
      "fn-spec": this._spec,
      "fn-schema": this._inputSchema,
      "fn-overrides": this._overrides,
      ...(translations ?? {}),
    };

    for (const promptName in this._originalPrompts) {
      let prompt = this._originalPrompts[promptName];
      console.debug(`prompt was: ${prompt}`); // !!!!!!
      for (const name in allTranslations) {
        prompt = prompt.replaceAll(`<${name}>`, allTranslations[name]);
      }
      this._prompts[promptName] = prompt;
      console.debug(`prompt now: ${prompt}`); // !!!!!!
    }
    this._state = "ready";
  }

  public abstract generateSpec(): Promise<string>;

  public abstract generateExampleInputs(): Promise<any[][]>;

  public abstract predictInputRanges(): Promise<ModelInputRanges>;

  protected _originalPrompts: Record<string, string> = {
    /*L0*/ system: `You are writing correct, secure, understandable, efficient TypeScript code and are aware of the important differences among TypeScript’s === and == operators.`,

    /*L1*/ specFromCode: `Generate a natural language specification for the “<fn-name>” program in docstring format using TypeDoc annotations such as @param and @returns. Include remarks but do not include the @remarks annotation. Do not include the source code of the "<fn-name>" program. Do not include the function signature. Return the specification in this JSON schema format: {spec: string[]}

A JSON Schema descrbing the concrete inputs and outputs:
<fn-schema>

The "<fn-name>" program:
<fn-source>`,

    /*L2*/ exampleInputs: `For the following TypeScript program "<fn-name>" and its specification, provide the most important input values to test so as to determine whether the program satisfies its specification.

Return the unit test inputs in this JSON schema format. Omit any undefined values (e.g., optional inputs). Provide only literal values that are compatible with the type annotations. Each element in the array is a unit test.
<fn-schema>[]

The "<fn-name>" program:
<fn-source>
    
The “<fn-name>” specification in TypeDoc docstring format:
<fn-spec>`,

    /*L3*/ predictRanges: `Use the "<fn-name>" TypeScript specification below to understand any minimum and maximum values, lengths, array lengths, and character sets for the tree of function arguments.
    
Compare the specification to the values for the tree of arguments in this JSON object. Update any "min" "max" "minLength" "maxLength" or "charSet" properties necessary so that they match the specification. If the specification does not specify, assume what is presently in the JSON object is correct and leave the property unchanged. Omit any undefined values (e.g., optional inputs). Provide only literal values. Do not add any new fields to this schema. For any argument or subargument that you update, set the "updated" property to true.
<fn-overrides>

The "<fn-name>" program:
<fn-source>

The “<fn-name>” specification in TypeDoc docstring format:
<fn-spec>`,
  };
}
