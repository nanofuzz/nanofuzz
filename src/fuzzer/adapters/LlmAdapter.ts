import { ArgValueType } from "../analysis/typescript/Types";
import * as JSON5 from "json5";
import { FunctionDef } from "../analysis/typescript/FunctionDef";
import * as nodellm from "@node-llm/core";

// Try to load the vscode module
let vscode: any = undefined;
try {
  vscode = require("vscode");
} catch (e: unknown) {
  // vscode module unavailable: running outside vscode
}

process.env["NODELLM_DEBUG"] = "true"; // !!!!!!!!!!

/**
 * An adapter for chatting with an LLM about the program under test
 */
export class LlmAdapter {
  protected _modelConfig: Parameters<typeof nodellm.createLLM>[0] = {}; // !!!!!!
  protected _backend: nodellm.NodeLLMCore; // !!!!!!
  protected _chat: nodellm.Chat; // !!!!!!
  protected _promptCache: Record<string, string> = {}; // Cache of LLM chats
  protected _cfgString: string; // LLM config; for detecting config changes

  public constructor() {
    const cfg = LlmAdapter._getConfig();
    this._cfgString = JSON5.stringify(cfg);

    if (!LlmAdapter.isConfigured()) {
      throw new Error("AI Models are disabled");
    }

    // Configure model from NaNofuzz settings
    this._modelConfig = {
      provider: cfg.provider,
      retry: {
        attempts: LlmAdapter._getConfigValue("retries", 5),
        delayMs: LlmAdapter._getConfigValue("retryDelay", 1000),
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
      systemPrompt: prompt.system(),
    });
  } // constructor

  // !!!!!!
  public isStale(): boolean {
    return JSON5.stringify(LlmAdapter._getConfig()) !== this._cfgString;
  } // fn: isStale

  // !!!!!!
  public get id(): string | undefined {
    return `v=${this._backend.provider?.id},n=${this._chat.modelId}`;
  } /// getter: id

  // !!!!!!
  public async genInputs(
    fn: FunctionDef,
    schema?: Parameters<typeof this._chat.withSchema>[0]
  ): Promise<{
    programInputs: { [k: string]: ArgValueType }[];
    error?: "discarded";
  }> {
    const inputs: { programInputs: { [k: string]: ArgValueType }[] } =
      JSON5.parse(
        await this._query(
          [prompt.genInputs(this._getPromptVars(fn))],
          schema,
          true
        )
      );

    // Sanity check llm output
    if (
      !(
        typeof inputs === "object" &&
        "programInputs" in inputs &&
        Array.isArray(inputs.programInputs) &&
        inputs.programInputs.every(
          (e) => typeof e === "object" && !Array.isArray(e)
        )
      )
    ) {
      return { programInputs: [], error: "discarded" };
    }

    // Deeper validation is the client's role
    return inputs;
  } // fn: genInputs

  // !!!!!!!!! should move this
  protected _getPromptVars(fn: FunctionDef): {
    fnName: string;
    fnSource: string;
    fnSpec: string;
  } {
    const fnRef = fn.getRef();
    return {
      fnName: fnRef.name,
      fnSource: fnRef.src,
      fnSpec: fn.getCmt() ?? "", // !!!!!!!! should get spec here
    };
  } // fn: _getPromptVars

  // !!!!!!
  private async _query(
    prompt: string[],
    schema?: Parameters<typeof this._chat.withSchema>[0],
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
        await (schema ? this._chat.withSchema(schema) : this._chat)
          .withRequestOptions({
            responseFormat: { type: "json_object" },
          })
          .ask(promptParts)
      ).toString();
      console.debug(`(${performance.now() - timer} ms) chat reply: ${result}`); // !!!!!!
      this._promptCache[promptSerialized] = result;
      return result;
    } // !!!!!!
  } // fn: query

  // !!!!!!
  public static isConfigured(): boolean {
    const cfg = LlmAdapter._getConfig();
    return vscode ? cfg.provider !== "disabled" && cfg.modelName !== "" : false;
  } // fn: isConfigured

  /** !!!!!! */
  protected static _getConfig(): {
    provider: string;
    modelName: string;
    apiKey: string;
  } {
    return {
      provider: LlmAdapter._getConfigValue("provider", "disabled"),
      modelName: LlmAdapter._getConfigValue("model", ""),
      apiKey: LlmAdapter._getConfigValue("apiKey", ""),
    };
  } // fn: _getConfig

  // !!!!!!
  protected static _getConfigValue<T>(section: string, dft: T): T {
    return vscode !== undefined
      ? vscode.workspace.getConfiguration("nanofuzz.ai").get(section, dft)
      : dft;
  } // fn: _getConfigValue
} // class: LlmAdapter

// !!!!!!
const prompt = {
  system: (): string => {
    return `You are writing correct, secure, understandable, efficient TypeScript code and are aware of the important differences between TypeScript’s === and == operators.`;
  },
  genInputs: (vars: ReturnType<LlmAdapter["_getPromptVars"]>): string => {
    return `To evaluate whether the following TypeScript program "${vars.fnName}" satisfies its specification, generate 10-20 program inputs that are important to determine whether the program satisfies its specification. Each program input includes all the arguments needed to call the program.

The "${vars.fnName}" program:
\`\`\`
${vars.fnSpec ? `${vars.fnSpec}\r\n` : ""}${vars.fnSource}
\`\`\`  
`;
  },
};
