import {
  ArgTag,
  ArgType,
  FunctionRef,
} from "../fuzzer/analysis/typescript/Types";
import * as vscode from "vscode";
import * as JSON5 from "json5";
import { ModelArgOverrides } from "./Types";
import { ArgDef } from "fuzzer/analysis/typescript/ArgDef";
import { FunctionDef } from "fuzzer/analysis/typescript/FunctionDef";
import { FuzzArgOverride, FuzzIoElement } from "fuzzer/Types";

export abstract class AbstractProgramModel {
  protected readonly _cfgCategory: string;
  protected _fn: FunctionDef;
  protected _fnRef: FunctionRef;
  protected _state: "notready" | "ready" = "notready"; // !!!!!!
  protected _inputSchema;
  protected _overrides;

  /** !!!!!! */
  protected constructor(fn: FunctionDef, cfgCategory: string) {
    this._fn = fn;
    this._cfgCategory = cfgCategory;
    this._fnRef = fn.getRef();
    this._inputSchema = AbstractProgramModel.getFuzzInputElements(this._fn);
    this._overrides = AbstractProgramModel.getModelArgOverrides(this._fn);
  } // !!!!!!

  /** !!!!!! */
  protected _getConfig<T>(section: string, dft: T): T {
    return vscode.workspace
      .getConfiguration("nanofuzz.ai." + this._cfgCategory)
      .get(section, dft);
  } // !!!!!!

  /** !!!!!! */
  protected _concretizePrompt(
    prompt: string,
    translations?: Record<string, string>
  ): string {
    const allTranslations: Record<string, string> = {
      "fn-name": this._fnRef.name,
      "fn-source": this._fnRef.src,
      "fn-spec": this._fn.getSpec() ?? "",
      "fn-schema": this._inputSchema,
      "fn-overrides": JSON5.stringify(this._overrides),
      ...(translations ?? {}),
    };

    //console.debug(`prompt was: ${prompt}`); // !!!!!!
    for (const name in allTranslations) {
      prompt = prompt.replaceAll(`<${name}>`, allTranslations[name]);
    }
    //console.debug(`prompt now: ${prompt}`); // !!!!!!
    return prompt;
  } // !!!!!!

  /** !!!!!! */
  protected static getFuzzInputElements(fn: FunctionDef): string {
    let i = 0;
    // Build the FuzzIoElement for each argument
    const getFuzzIoElement = (arg: ArgDef<ArgType>): string => {
      const name = arg.isNamed()
        ? `name:${JSON5.stringify(arg.getName())},`
        : "";
      const offset = `offset:${i++},`;
      const value = `value${
        arg.isOptional() ? "?" : ""
      }:${arg.getTypeAnnotation({})},`;
      const typeRef = arg.getTypeRef() ? `typeName:${arg.getTypeRef()},` : "";

      return `{${name}${offset}${value}${typeRef}}`;
    };

    const inputs = `[${fn
      .getArgDefs()
      .map((arg) => getFuzzIoElement(arg))
      .join(",")}]`;
    //const returnArg = fn.getReturnArg();
    //const outputs = returnArg
    //  ? `output?: ${getFuzzIoElement(returnArg)}}`
    //  : fn.isVoid()
    //  ? ``
    //  : `output?: any`;
    return inputs;
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

  /** !!!!!! */
  public async getFuzzerArgOverrides(): Promise<FuzzArgOverride[]> {
    console.debug(
      `Raw overrides: ${JSON5.stringify(
        await this.predictArgOverrides(),
        null,
        2
      )}`
    ); // !!!!!!
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

  public abstract getSpec(): Promise<string | undefined>;

  public abstract generateExampleInputs(): Promise<FuzzIoElement[][]>;

  public abstract predictArgOverrides(): Promise<ModelArgOverrides[]>;

  protected _prompts: Record<string, string> = {
    /*L0*/ system: `You are writing correct, secure, understandable, efficient TypeScript code and are aware of the important differences among TypeScript’s === and == operators.`,

    /*L1*/ specFromCode: `Generate a natural language specification for the “<fn-name>” program in docstring format using TypeDoc annotations such as @param and @returns. Include remarks but do not include the @remarks annotation. Do not include the source code of the "<fn-name>" program. Do not include the function signature. Return the specification in this JSON schema format: {spec: string[]}

A JSON Schema descrbing the concrete inputs and outputs:
<fn-schema>

The "<fn-name>" program:
<fn-source>`,

    /*L2*/ exampleInputs: `To evaluate whether the following TypeScript program "<fn-name>" satisfies its specification, generate several test cases for testing the program. Each test case includes all the inputs needed to call the program. Choose 5-15 test cases that are important to determine whether the program satisfies its specification.

For each argument of each unit test, you must satisfy the constraints for each argument and subargument. This includes min and max ranges (numbers, booleans), min and max lengths of each string and array dimension, character set restrictions (strings), and whether floats are allowed or only integers (numbers), as defined here:
<fn-overrides>

Each unit test must be in the following JSON schema format ("testCase"). You will only change the "value" fields. In each unit test, omit any undefined values (e.g., optional inputs). Provide only literal values that are compatible with the type annotations. 
testCase = <fn-schema>

Return an array of unit tests in the following JSON format such that you return an array of arrays.
testCase[]

The "<fn-name>" program:
<fn-source>
    
The “<fn-name>” specification in docstring format:
<fn-spec>`,

    /*L3*/ predictRanges: `Use the "<fn-name>" TypeScript specification below to understand any minimum and maximum values, lengths, array lengths, and character sets for the tree of function arguments.
    
Compare the specification to the values for the tree of arguments in this JSON object. Only update "minValue" "maxValue" "minLength" "maxLength" "onlyIntegers" or "charSet" properties if necessary for each argument or subargument in the JSON to agree with the specification for that argument or subargument. If the specification does not specify, assume what is presently in the JSON object is correct and leave the property unchanged. Omit any undefined values (e.g., optional inputs). Provide only literal values. Do not add any new fields to this schema.
<fn-overrides>

The "<fn-name>" program:
<fn-source>

The “<fn-name>” specification in docstring format:
<fn-spec>`,
  };
} // !!!!!!
