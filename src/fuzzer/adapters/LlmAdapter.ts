import { ArgValueType } from "../analysis/typescript/Types";
import * as JSON5 from "json5";
import { FunctionDef } from "../analysis/typescript/FunctionDef";
import * as nodellm from "@node-llm/core";
import { isError } from "../Util";

// Try to load the vscode module
let vscode: any = undefined;
try {
  vscode = require("vscode");
} catch (e: unknown) {
  // vscode module unavailable: running outside vscode
}

/**
 * An adapter for chatting with an LLM about the program under test
 */
export class LlmAdapter {
  protected _modelConfig: Parameters<typeof nodellm.createLLM>[0] = {}; // LLM configuration
  protected _backend: nodellm.NodeLLMCore; // LLM instance
  protected _chat: nodellm.Chat; // LLM chat
  protected _cfgString: string; // LLM config; for detecting config changes

  public constructor() {
    LlmAdapter._handleDebug();

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

  /**
   * Determine if the LLM config used to connect to the LLM is now out of date
   *
   * @returns `true` if the LLM config has changed since instantiation
   */
  public isStale(): boolean {
    return JSON5.stringify(LlmAdapter._getConfig()) !== this._cfgString;
  } // fn: isStale

  /**
   * Get a string id indicating the back-end LLM
   *
   * @returns a string indicating the configured provider and model id
   */
  public get id(): string | undefined {
    return `v=${this._backend.provider?.id},n=${this._chat.modelId}`;
  } /// getter: id

  /**
   * Prompt an LLM to generate inputs for a function
   *
   * @param `fn` function for which inputs should be generated
   * @param `schema` optional Zod or JSON schema of the function's inputs
   * @returns a set of inputs, stats, and error information
   */
  public async genInputs(
    fn: FunctionDef,
    schema?: [Parameters<typeof this._chat.withSchema>[0], string[]]
  ): Promise<{
    programInputs: { [k: string]: ArgValueType }[];
    stats?: Awaited<ReturnType<LlmAdapter["_query"]>>["stats"];
    error?: { type: "discard" } | { type: "failure"; message: string };
  }> {
    let response: Awaited<ReturnType<LlmAdapter["_query"]>>;
    try {
      response = await this._query(
        [
          prompt.genInputs(
            this._getPromptVars(
              fn,
              schema === undefined || schema[1].length === 0 ? [] : schema[1]
            )
          ),
        ],
        schema ? schema[0] : undefined
      );
    } catch (e: unknown) {
      return {
        programInputs: [],
        error: {
          type: "failure",
          message: isError(e) ? e.message : "unknown llm failure",
        },
      };
    }
    const inputs: { programInputs: { [k: string]: ArgValueType }[] } =
      JSON5.parse(response.response);

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
      return {
        programInputs: [],
        error: { type: "discard" },
        stats: { ...response.stats },
      };
    }

    // Deeper validation is the client's role
    return { ...inputs, stats: { ...response.stats } };
  } // fn: genInputs

  /**
   * Returns a commmunication structure of data for building prompts
   * for a program.
   *
   * @param `fn` the function under test
   * @returns a set of prompt variables
   */
  protected _getPromptVars(
    fn: FunctionDef,
    directives: string[]
  ): {
    fnName: string;
    fnSource: string;
    fnSpec: string;
    directives: string[];
  } {
    const fnRef = fn.getRef();
    return {
      fnName: fnRef.name,
      fnSource: fnRef.src,
      fnSpec: fn.getCmt() ?? "",
      directives,
    };
  } // fn: _getPromptVars

  /**
   * Prompts the LLM and returns a response
   *
   * @param `prompt` LLM prompt
   * @param `schema` optional Zod or JSON schema for the response
   * @returns response string and statistics
   */
  private async _query(
    prompt: string[],
    schema?: Parameters<typeof this._chat.withSchema>[0]
  ): Promise<{
    response: string;
    stats: {
      tokensSent: number;
      tokensSentCost: { amt: number; unit: string };
      tokensReceived: number;
      tokensReceivedCost: { amt: number; unit: string };
    };
  }> {
    LlmAdapter._handleDebug();

    const promptParts: nodellm.ContentPart[] = [];
    prompt.forEach((e) => {
      promptParts.push({
        type: "text",
        text: e,
      });
    });

    const response = await (schema ? this._chat.withSchema(schema) : this._chat)
      .withRequestOptions({
        responseFormat: { type: "json_object" },
      })
      .ask(promptParts);
    return {
      response: response.toString(),
      stats: {
        tokensSent: response.inputTokens,
        tokensSentCost: { amt: response.input_cost ?? 0, unit: "USD" }, // USD per docs
        tokensReceived: response.outputTokens,
        tokensReceivedCost: { amt: response.output_cost ?? 0, unit: "USD" }, // USD per docs
      },
    };
  } // fn: _query

  /**
   * Determines if the LLM is configured and should be active.
   *
   * @returns `true` if the LLM is configured to be active, `false` otherwise
   */
  public static isConfigured(): boolean {
    const cfg = LlmAdapter._getConfig();
    return cfg.provider !== "disabled" && cfg.modelName !== "";
  } // fn: isConfigured

  /**
   * Gets the key elements of the LLM configuration
   *
   * @returns provider, modelName, and apiKey
   */
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

  /**
   * Returns a vscode extension configuration element
   *
   * @param `section` vscode extension configuration item
   * @param `dft` default value
   * @returns extension configuration element or default
   */
  protected static _getConfigValue<T>(section: string, dft: T): T {
    return vscode !== undefined
      ? vscode.workspace.getConfiguration("nanofuzz.ai").get(section, dft)
      : dft;
  } // fn: _getConfigValue

  /**
   * Returns `true` if LLM debug mode is active.
   *
   * @returns `true` if debug mode is active; `false` otherwise
   */
  public static isDebugConfigured(): boolean {
    return LlmAdapter._getConfigValue<boolean>("debug", false);
  } // fn: isDebugActive

  /**
   * Turns debug logging on or off depending on the `nanofuzz.ai.debug` option
   */
  protected static _handleDebug(): void {
    process.env["NODELLM_DEBUG"] = String(LlmAdapter.isDebugConfigured());
  } // fn: _handleDebug
} // class: LlmAdapter

/**
 * Parameterized prompts for the LLM
 */
const prompt = {
  system: (): string => {
    return `You are an experienced Typescript developer who writes efficient tests that thoroughly evaluate the correctness of TypeScript programs. You are aware of the important differences between TypeScript’s === and == operators.`;
  },
  genInputs: (vars: ReturnType<LlmAdapter["_getPromptVars"]>): string => {
    return `To evaluate whether the following TypeScript program "${vars.fnName}" behaves correctly relative to its specification, generate 10 to 20 program inputs that are important to determine whether the program satisfies its specification. Each program input includes all the arguments needed to call the program.

The specification for the "${vars.fnName}" program:
\`\`\`
${vars.fnSpec ? vars.fnSpec : `(no specification was found. try to infer the spec from the program below)`}
\`\`\`

The "${vars.fnName}" program:
\`\`\`
${vars.fnSource}
\`\`\`

${vars.directives.length ? `Important details about the program's inputs:\n${vars.directives.map((d) => ` - ${d}\n`).join("")}` : ""} 
`;
  },
};
