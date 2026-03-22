import {
  ArgTag,
  ArgType,
  FunctionRef,
} from "../fuzzer/analysis/typescript/Types";
import * as JSON5 from "json5";
import { ModelArgOverrides } from "./Types";
import { ArgDef } from "../fuzzer/analysis/typescript/ArgDef";
import { FunctionDef } from "../fuzzer/analysis/typescript/FunctionDef";
import { FuzzArgOverride, FuzzIoElement } from "../fuzzer/Types";
import * as nodellm from "@node-llm/core";
import { ArgDefValidator } from "../fuzzer/analysis/typescript/ArgDefValidator";

// !!!!!!!
let vscode: any = undefined;
try {
  vscode = require("vscode");
} catch (e: unknown) {
  console.error(`vscode module unavailable: running outside vscode?`);
}

// !!!!!!
export class ProgramModel {
  protected _fn: FunctionDef; // !!!!!!
  protected _fnRef: FunctionRef; // !!!!!!
  protected _state: "ready" | "busy" | "failed" = "ready"; // !!!!!!
  protected _inputSchema; // !!!!!!
  protected _overrides; // !!!!!!
  protected _modelConfig: Parameters<typeof nodellm.createLLM>[0] = {}; // !!!!!!
  protected _model: nodellm.NodeLLMCore; // !!!!!!
  protected _chat: nodellm.Chat; // !!!!!!
  protected _promptCache: Record<string, string> = {}; // !!!!!!

  /** !!!!!! */
  public constructor(fn: FunctionDef) {
    this._fn = fn;
    this._fnRef = fn.getRef();
    this._inputSchema = ProgramModel.getFuzzInputElements(this._fn);
    this._overrides = ProgramModel.getModelArgOverrides(this._fn);

    const provider: string = ProgramModel._getConfig("provider", "disabled");
    const apiKey = ProgramModel._getConfig("apiKey", "");
    const modelName = ProgramModel._getConfig("model", "");

    if (provider === "disabled") {
      throw new Error("AI Models are disabled");
    }

    // Configure model from NaNofuzz settings
    this._modelConfig = {
      provider: provider,
      retry: {
        attempts: ProgramModel._getConfig("retries", 5),
        delayMs: ProgramModel._getConfig("retryDelay", 1000),
      },
    };

    // If apikey is defined, add it to the config.
    // Otherwise, let @node-llm try to infer it from env
    if (apiKey !== "") {
      (this._modelConfig as any)[`${provider}ApiKey`] = apiKey;
    }

    // Create the model chat session
    this._model = nodellm.createLLM(this._modelConfig);
    this._chat = this._model.chat(modelName, {
      systemPrompt: this.prompt.system(),
    });
  } // !!!!!!

  // !!!!!!
  public static isConfigured(): boolean {
    return vscode
      ? ProgramModel._getConfig("provider", "disabled") !== "disabled" &&
          ProgramModel._getConfig("model", "") !== ""
      : false;
  } // !!!!!!

  // !!!!!!
  public get id(): string | undefined {
    return `v=${this._model.provider?.id},n=${this._chat.modelId}`;
  } /// !!!!!!!!!

  /** !!!!!! */
  protected static _getConfig<T>(section: string, dft: T): T {
    return vscode !== undefined
      ? vscode.workspace.getConfiguration("nanofuzz.ai").get(section, dft)
      : dft;
  } // !!!!!!

  // !!!!!!
  protected _getPromptVars(): {
    fnName: string;
    fnSource: string;
    fnSpec: string;
    fnSchema: string;
    fnOverrides: string;
  } {
    return {
      fnName: this._fnRef.name,
      fnSource: this._fnRef.src,
      fnSpec: this._fn.getCmt() ?? "", // !!!!!!!! should get spec here
      fnSchema: this._inputSchema,
      fnOverrides: JSON5.stringify(this._overrides, null, 2),
    };
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

  // !!!!!!
  public isAvailable(): boolean {
    return this._state === "ready";
  }

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
        result.push(...ProgramModel.toArgOverrides(modelArg.children));
      }
    });

    return result;
  } // !!!!!!

  // !!!!!!
  public async genInputs(): Promise<FuzzIoElement[][]> {
    const validator = new ArgDefValidator(this._fn.getArgDefs());
    const inputs: FuzzIoElement[][] = JSON5.parse(
      await this._query([this.prompt.genInputs()], true)
    );
    /* !!!!!!!!
    inputs.forEach((test) => {
      test.forEach(
        (input) =>
          (input.origin = {
            type: "model",
            category: this._cfgCategory,
            name: this._modelName,
          })
      );
    });
    */
    console.debug(
      `got these inputs from the llm: ${JSON5.stringify(inputs, null, 2)}`
    ); // !!!!!!!!!
    const validInputs = inputs.filter((e) =>
      validator.validate(
        e.map((i) => {
          return {
            tag: "ArgValueTypeWrapped",
            value: i.value,
          };
        })
      )
    );
    if (inputs.length !== validInputs.length) {
      console.debug(
        `but only these inputs were valid: ${JSON5.stringify(validInputs, null, 2)}`
      ); // !!!!!!!!!
    }
    return validInputs;
  } // !!!!!!

  // !!!!!!
  private async _query(
    prompt: string[],
    bypassCache: boolean | undefined = false
  ): Promise<string> {
    const promptSerialized = JSON5.stringify(prompt);

    if (promptSerialized in this._promptCache && !bypassCache) {
      const cachedResponse = this._promptCache[promptSerialized];
      console.debug(`chat(from CACHE) query: ${prompt.join(", ")}`); // !!!!!!
      console.debug(`chat(from CACHE) reply: ${cachedResponse}`); // !!!!!!
      return cachedResponse;
    } else {
      console.debug(`chat query: ${prompt.join(", ")}`); // !!!!!!

      const promptParts: nodellm.ContentPart[] = [];
      prompt.forEach((e) => {
        promptParts.push({
          type: "text",
          text: e,
        });
      });

      const timer = performance.now();
      const result = (
        await this._chat
          .withRequestOptions({
            responseFormat: { type: "json_object" },
          })
          .ask(promptParts)
      ).toString();
      console.debug(`(${performance.now() - timer} ms) chat reply: ${result}`); // !!!!!!
      this._promptCache[promptSerialized] = result;
      return result;
    } // !!!!!!
  } // !!!!!!

  // !!!!!!
  protected prompt = {
    system: (): string => {
      return `You are writing correct, secure, understandable, efficient TypeScript code and are aware of the important differences between TypeScript’s === and == operators.`;
    },
    genInputs: (): string => {
      const vars = this._getPromptVars();
      return `To evaluate whether the following TypeScript program "${vars.fnName}" satisfies its specification, generate 10-20 program inputs that are important to determine whether the program satisfies its specification. Each program input includes all the arguments needed to call the program.

Each argument (including sub-arguments) of each program input must satisfy constraints, such as min and max ranges (numbers, booleans), min and max lengths of each string and array dimension, character set restrictions (strings), and whether floats are allowed or only integers (numbers), as defined here:
\`\`\`
${vars.fnOverrides}
\`\`\`

Each program input must be in the following JSON format, which is an array of input values. Only change the "value" field. In each program input, omit any undefined values (e.g., optional inputs). Provide only literal values that are compatible with the type annotations. Even if the input has only a single argument, you still need to output it as an array. 
\`\`\`
${vars.fnSchema}
\`\`\`

Return an array of 10-20 program inputs in the above JSON format such that you return an array of arrays.

The "${vars.fnName}" program:
\`\`\`
${vars.fnSource}
\`\`\`
    
The “${vars.fnName}” specification in docstring format:
\`\`\`
${vars.fnSpec}
\`\`\``;
    },
  }; // !!!!!!
} // !!!!!!
