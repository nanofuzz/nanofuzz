import { ArgTag, ArgType } from "../fuzzer/analysis/typescript/Types";
import * as JSON5 from "json5";
import { ModelArgOverrides, ModelArgOverridesBase } from "./Types";
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
  protected _specs: ArgDef<ArgType>[]; // !!!!!!
  protected _state: "ready" | "busy" | "failed" = "ready"; // !!!!!!
  protected _modelConfig: Parameters<typeof nodellm.createLLM>[0] = {}; // !!!!!!
  protected _backend: nodellm.NodeLLMCore; // !!!!!!
  protected _chat: nodellm.Chat; // !!!!!!
  protected _promptCache: Record<string, string> = {}; // !!!!!!
  protected _cfgHash: string; // !!!!!!

  /** !!!!!! */
  public constructor(fn: FunctionDef, specs: ArgDef<ArgType>[]) {
    this._fn = fn;
    this._specs = specs;

    const cfg = ProgramModel._getConfig();
    this._cfgHash = JSON5.stringify(cfg);

    if (!ProgramModel.isConfigured()) {
      throw new Error("AI Models are disabled");
    }

    // Configure model from NaNofuzz settings
    this._modelConfig = {
      provider: cfg.provider,
      retry: {
        attempts: ProgramModel._getConfigValue("retries", 5),
        delayMs: ProgramModel._getConfigValue("retryDelay", 1000),
      },
    };

    // If apikey is defined, add it to the config.
    // Otherwise, let @node-llm try to infer it from env
    if (cfg.apiKey !== "") {
      (this._modelConfig as any)[`${cfg.provider}ApiKey`] = cfg.apiKey;
    }

    // Create the model chat session
    this._backend = nodellm.createLLM(this._modelConfig);
    this._chat = this._backend.chat(cfg.modelName, {
      systemPrompt: this.prompt.system(),
    });
  } // !!!!!!

  // !!!!!!
  public isStale(): boolean {
    return JSON5.stringify(ProgramModel._getConfig()) !== this._cfgHash;
  } // !!!!!!

  // !!!!!!
  public get id(): string | undefined {
    return `v=${this._backend.provider?.id},n=${this._chat.modelId}`;
  } /// !!!!!!!!!

  // !!!!!!
  public static isConfigured(): boolean {
    const cfg = ProgramModel._getConfig();
    return vscode ? cfg.provider !== "disabled" && cfg.modelName !== "" : false;
  } // !!!!!!

  /** !!!!!! */
  protected static _getConfig(): {
    provider: string;
    modelName: string;
    apiKey: string;
  } {
    return {
      provider: ProgramModel._getConfigValue("provider", "disabled"),
      modelName: ProgramModel._getConfigValue("model", ""),
      apiKey: ProgramModel._getConfigValue("apiKey", ""),
    };
  } // !!!!!!

  // !!!!!!
  protected static _getConfigValue<T>(section: string, dft: T): T {
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
    const fnRef = this._fn.getRef();
    return {
      fnName: fnRef.name,
      fnSource: fnRef.src,
      fnSpec: this._fn.getCmt() ?? "", // !!!!!!!! should get spec here
      fnSchema: ProgramModel.getFuzzInputElements(this._fn),
      fnOverrides: JSON5.stringify(
        ProgramModel.getModelArgOverrides(this._specs),
        null,
        2
      ),
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
  protected static getModelArgOverrides(
    specs: ArgDef<ArgType>[]
  ): ModelArgOverrides[] {
    // !!!!!!
    const getModelArgOverrideInner = (
      arg: ArgDef<ArgType>
    ): ModelArgOverrides => {
      const argIntervals = arg.getIntervals();
      const argOptions = arg.getOptions();
      const argTypeRef = arg.getTypeRef();

      let argOverride: ModelArgOverrides;
      const argOverrideBase: ModelArgOverridesBase = {
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
          argOverride = {
            ...argOverrideBase,
            literalValue: arg.getConstantValue(),
          };
          break;
        }
        case ArgTag.OBJECT: {
          argOverride = {
            ...argOverrideBase,
            children: arg
              .getChildren()
              .filter((child) => !child.isNoInput())
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
              .filter((child) => !child.isNoInput())
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

    return specs.map((arg) => getModelArgOverrideInner(arg));
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

    // Discard the result if it is not an array or arrays
    if (
      !Array.isArray(inputs) ||
      (inputs.length && !Array.isArray(inputs[0]))
    ) {
      console.debug(
        `Discarded the LLM's response because it is not an array of arrays: ${JSON5.stringify(inputs, null, 2)}.`
      ); // !!!!!!!
      return [];
    }

    // Validate the inputs before returning them !!!!!!!!!! duplicate validation logic for debugging
    const validInputs: FuzzIoElement[][] = [];
    const invalidInputs: FuzzIoElement[][] = [];
    inputs.forEach((e) => {
      (validator.validate(
        e.map((i) => {
          return {
            tag: "ArgValueTypeWrapped",
            value: i.value,
          };
        })
      )
        ? validInputs
        : invalidInputs
      ).push(e);
    });
    if (invalidInputs.length) {
      console.debug(
        `Discarded these invalid inputs generated by the LLM: ${JSON5.stringify(invalidInputs, null, 2)}`
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

Each program input must be in the following JSON format, which is an array of program input values. Only change the "value" field. In each program input, omit any undefined values (e.g., optional inputs). Provide only literal values that are compatible with the type annotations. Even if the input has only a single argument, you still need to output it as an array. 
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
