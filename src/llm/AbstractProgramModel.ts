import {
  ArgTag,
  ArgType,
  FunctionRef,
} from "../fuzzer/analysis/typescript/Types";
import { ProgramDef } from "../fuzzer/analysis/typescript/ProgramDef";
import * as vscode from "vscode";
import * as JSON5 from "json5";
import { ModelArgOverrides } from "./Types";
import { ArgDef } from "fuzzer/analysis/typescript/ArgDef";
import { FunctionDef } from "fuzzer/analysis/typescript/FunctionDef";
import { FuzzArgOverride } from "fuzzer/Types";

export abstract class AbstractProgramModel {
  protected readonly _cfgCategory: string;
  protected _fnRef: FunctionRef;
  protected _spec = "";
  protected _state: "notready" | "ready" = "notready"; // !!!!!!
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
    this._inputSchema = AbstractProgramModel.getJsonSignature(thisFn);
    this._overrides = AbstractProgramModel.getModelArgOverrides(thisFn);
  } // !!!!!!

  protected _getConfig<T>(section: string, dft: T): T {
    return vscode.workspace
      .getConfiguration("nanofuzz.ai." + this._cfgCategory)
      .get(section, dft);
  } // !!!!!!

  protected _concretizePrompt(
    prompt: string,
    translations?: Record<string, string>
  ): string {
    const allTranslations: Record<string, string> = {
      "fn-name": this._fnRef.name,
      "fn-source": this._fnRef.src,
      "fn-spec": this._spec,
      "fn-schema": this._inputSchema,
      "fn-overrides": JSON5.stringify(this._overrides),
      ...(translations ?? {}),
    };

    console.debug(`prompt was: ${prompt}`); // !!!!!!
    for (const name in allTranslations) {
      prompt = prompt.replaceAll(`<${name}>`, allTranslations[name]);
    }
    console.debug(`prompt now: ${prompt}`); // !!!!!!
    return prompt;
  } // !!!!!!

  /** !!!!!! */
  protected static getJsonSignature(fn: FunctionDef): string {
    // Build the JSON signature for each argument
    const getJsonArgSignature = (arg: ArgDef<ArgType>): string => {
      const name = arg.isNamed()
        ? `name:${JSON5.stringify(arg.getName())},`
        : "";
      const value = `value${
        arg.isOptional() ? "?" : ""
      }:${arg.getTypeAnnotation({})},`;
      const typeRef = arg.getTypeRef() ? `typeName:${arg.getTypeRef()},` : "";

      return `{${name}${value}${typeRef}}`;
    };

    const inputs = `inputs: [${fn
      .getArgDefs()
      .map((arg) => getJsonArgSignature(arg))
      .join(",")}]`;
    const returnArg = fn.getReturnArg();
    const outputs = returnArg
      ? `output?: ${getJsonArgSignature(returnArg)}}`
      : fn.isVoid()
      ? ``
      : `output?: any`;
    return `{${inputs},${outputs}}`;
  } // !!!!!!

  /** !!!!!! */
  protected static getModelArgOverrides(fn: FunctionDef): ModelArgOverrides[] {
    // !!!!!!
    const getModelArgOverrideInner = (
      arg: ArgDef<ArgType>
    ): ModelArgOverrides => {
      const argIntervals = arg.getIntervals();
      const argOptions = arg.getOptions();
      const argTypeRef = arg.getTypeRef();

      let argOverride: ModelArgOverrides;
      const argOverrideBase: ModelArgOverrides = {
        type: arg.getType(),
        arrayDimensions: argOptions.dimLength.map((dim) => {
          return {
            minLength: dim.min,
            maxLength: dim.max,
          };
        }),
      };

      if (arg.isNamed()) {
        argOverrideBase["name"] = arg.getName();
      }
      if (argTypeRef) {
        argOverrideBase["typeName"] = argTypeRef;
      }

      switch (arg.getType()) {
        case ArgTag.NUMBER: {
          argOverride = {
            ...argOverrideBase,
            number: {
              minValue: Number(argIntervals[0].min),
              maxValue: Number(argIntervals[0].max),
              onlyIntegers: argOptions.numInteger,
            },
          };
          break;
        }
        case ArgTag.BOOLEAN: {
          argOverride = {
            ...argOverrideBase,
            boolean: {
              minValue: !!argIntervals[0].min,
              maxValue: !!argIntervals[0].max,
            },
          };
          break;
        }
        case ArgTag.STRING: {
          argOverride = {
            ...argOverrideBase,
            string: {
              minLength: argOptions.strLength.min,
              maxLength: argOptions.strLength.max,
              charSet: argOptions.strCharset,
            },
          };
          break;
        }
        case ArgTag.LITERAL: {
          argOverride = argOverrideBase;
          break;
        }
        case ArgTag.OBJECT: {
          argOverride = {
            ...argOverrideBase,
            children: arg
              .getChildren()
              .map((child) => getModelArgOverrideInner(child)),
          };
          break;
        }
        case ArgTag.UNION: {
          argOverride = {
            ...argOverrideBase,
            type: arg.getTypeAnnotation({}),
            children: arg
              .getChildren()
              .map((child) => getModelArgOverrideInner(child)),
          };
          break;
        }
        default: {
          throw new Error(`Unexpected argument type: "${arg.getType()}"`);
        }
      }
      return argOverride;
    };

    return fn.getArgDefs().map((arg) => getModelArgOverrideInner(arg));
  } // !!!!!!

  //   protected static compareModelArgOverrides(
  //     oldOverrides: ModelArgOverrides[],
  //     newOverrides: ModelArgOverrides[]
  //   ): ModelArgOverrides[] {
  //     const result: ModelArgOverrides[] = [];
  //     for (const i in newOverrides) {
  //       const thisOld = oldOverrides[i];
  //       const thisNew = newOverrides[i];
  //       const changed = JSON5.stringify(thisOld) !== JSON5.stringify(thisNew);
  //       const thisResult = {
  //         ...newOverrides[i],
  //       };
  //       if (changed) {
  //         thisResult.changed = true;
  //         console.debug(
  //           `change detected: (old) ${JSON5.stringify(thisOld, null, 2)}`
  //         ); // !!!!!!
  //         console.debug(
  //           `                 (new) ${JSON5.stringify(thisNew, null, 2)}`
  //         ); // !!!!!!
  //       }
  //       if ("children" in thisNew && "children" in thisResult) {
  //         if ("children" in thisOld) {
  //           thisResult.children = AbstractProgramModel.compareModelArgOverrides(
  //             thisOld.children,
  //             thisNew.children
  //           );
  //         } else {
  //           thisResult.children = AbstractProgramModel.compareModelArgOverrides(
  //             [],
  //             thisNew.children
  //           );
  //         }
  //       }
  //     }
  //     return result;
  //   } // !!!!!!

  /** !!!!!! */
  public async getFuzzerArgOverrides(): Promise<FuzzArgOverride[]> {
    console.debug(`Raw overrides: ${await this.predictArgOverrides()}`); // !!!!!!
    return AbstractProgramModel.toArgOverrides(
      await this.predictArgOverrides()
    );
  } // !!!!!!

  /** !!!!!! */
  protected static toArgOverrides(
    modelArgOverrides: ModelArgOverrides[]
  ): FuzzArgOverride[] {
    const result: FuzzArgOverride[] = [];
    modelArgOverrides.forEach((modelArg) => {
      const fuzzArg: FuzzArgOverride = {};
      if ("number" in modelArg) {
        fuzzArg.number = {
          min: modelArg.number.minValue,
          max: modelArg.number.maxValue,
          numInteger: modelArg.number.onlyIntegers,
        };
      }
      if ("boolean" in modelArg) {
        fuzzArg.boolean = {
          min: modelArg.boolean.minValue,
          max: modelArg.boolean.maxValue,
        };
      }
      if ("string" in modelArg) {
        fuzzArg.string = {
          minStrLen: modelArg.string.minLength,
          maxStrLen: modelArg.string.maxLength,
          strCharset: modelArg.string.charSet,
        };
      }
      if ("arrayDimensions" in modelArg && modelArg.arrayDimensions.length) {
        fuzzArg.array = {
          dimLength: modelArg.arrayDimensions.map((modelDim) => {
            return {
              min: modelDim.minLength,
              max: modelDim.maxLength,
            };
          }),
        };
      }
      result.push(fuzzArg);

      if ("children" in modelArg) {
        result.push(...AbstractProgramModel.toArgOverrides(modelArg.children));
      }
    });

    return result;
  } // !!!!!!

  public abstract getSpec(): Promise<string>;

  public abstract generateExampleInputs(): Promise<any[][]>;

  public abstract predictArgOverrides(): Promise<ModelArgOverrides[]>;

  protected _prompts: Record<string, string> = {
    /*L0*/ system: `You are writing correct, secure, understandable, efficient TypeScript code and are aware of the important differences among TypeScript’s === and == operators.`,

    /*L1*/ specFromCode: `Generate a natural language specification for the “<fn-name>” program in docstring format using TypeDoc annotations such as @param and @returns. Include remarks but do not include the @remarks annotation. Do not include the source code of the "<fn-name>" program. Do not include the function signature. Return the specification in this JSON schema format: {spec: string[]}

A JSON Schema descrbing the concrete inputs and outputs:
<fn-schema>

The "<fn-name>" program:
<fn-source>`,

    /*L2*/ exampleInputs: `For the following TypeScript program "<fn-name>" and its specification, provide the most important input values to test so as to determine whether the program satisfies its specification.

For each argument of each unit test, you must satisfy the constraints for each argument and subargument. This includes min and max ranges (numbers, booleans), min and max lengths of each string and array dimension, character set restrictions (strings), and whether floats are allowed or only integers (numbers), as defined here:
<fn-overrides>

Return the unit test inputs in this JSON schema format. Omit any undefined values (e.g., optional inputs). Provide only literal values that are compatible with the type annotations. Each element in the array is a unit test.
<fn-schema>[]

The "<fn-name>" program:
<fn-source>
    
The “<fn-name>” specification in TypeDoc docstring format:
<fn-spec>`,

    /*L3*/ predictRanges: `Use the "<fn-name>" TypeScript specification below to understand any minimum and maximum values, lengths, array lengths, and character sets for the tree of function arguments.
    
Compare the specification to the values for the tree of arguments in this JSON object. Only update "minValue" "maxValue" "minLength" "maxLength" "onlyIntegers" or "charSet" properties if necessary for each argument or subargument in the JSON to agree with the specification for that argument or subargument. If the specification does not specify, assume what is presently in the JSON object is correct and leave the property unchanged. Omit any undefined values (e.g., optional inputs). Provide only literal values. Do not add any new fields to this schema.
<fn-overrides>

The "<fn-name>" program:
<fn-source>

The “<fn-name>” specification in TypeDoc docstring format:
<fn-spec>`,
  };
} // !!!!!!
