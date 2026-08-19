import vscode from "vscode";
import * as Config from "../../Config";
import { ArgValueType } from "../analysis/Types";
import * as JSONN from "../../Jsonn";
import { FunctionDef } from "../analysis/FunctionDef";
import * as nodellm from "@node-llm/core";
import { isError } from "../Util";
import * as telemetry from "../../telemetry/Telemetry";
import * as zod from "zod";
import { zodOutputFormat } from "./AnthropicUtils";

/**
 * An adapter for chatting with an LLM about the program under test
 */
export class LlmAdapter {
  protected _modelConfig: Parameters<typeof nodellm.createLLM>[0] = {}; // LLM configuration
  protected _backend: nodellm.NodeLLMCore; // LLM instance
  protected _cfgString: string; // LLM config; for detecting config changes

  public constructor() {
    LlmAdapter._handleDebug();

    const cfg = LlmAdapter._getConfig();
    this._cfgString = JSONN.stringify(cfg);

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

    // Create the model backend
    this._backend = nodellm.createLLM(this._modelConfig);
  } // constructor

  /**
   * Creates a fresh, stateless LLM chat session for a single query.
   *
   * @returns a new nodellm.Chat instance
   */
  protected _createChat(): nodellm.Chat {
    const cfg = LlmAdapter._getConfig();
    return this._backend.chat(cfg.modelName, {
      systemPrompt: prompt.system(),
    });
  } // fn: createChat

  /**
   * Determine if the LLM config used to connect to the LLM is now out of date
   *
   * @returns `true` if the LLM config has changed since instantiation
   */
  public isStale(): boolean {
    return JSONN.stringify(LlmAdapter._getConfig()) !== this._cfgString;
  } // fn: isStale

  /**
   * Get a string id indicating the back-end LLM
   *
   * @returns a string indicating the configured provider and model id
   */
  public get id(): string | undefined {
    return `v=${this._backend.provider?.id},n=${LlmAdapter._getConfig().modelName}`;
  } // getter: id

  /**
   * Prompt an LLM to generate inputs for a function
   *
   * @param `fn` function for which inputs should be generated
   * @param `schema` optional Zod or JSON schema of the function's inputs
   * @returns a set of inputs, stats, and error information
   */
  public async genInputs(
    fn: FunctionDef,
    schema: zod.ZodObject,
    directives: string[],
    allInputs: Map<string, unknown>
  ): Promise<{
    programInputs: { [k: string]: ArgValueType }[];
    stats?: Awaited<ReturnType<LlmAdapter["_query"]>>["stats"];
    error?: { type: "discard" } | { type: "failure"; message: string };
  }> {
    let response: Awaited<ReturnType<LlmAdapter["_query"]>>;
    try {
      response = await this._query(
        [prompt.genInputs(fn, directives, allInputs)],
        schema
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
      JSONN.parse(response.response);

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
   * Prompts the LLM and returns a response
   *
   * @param `prompt` LLM prompt
   * @param `schema` optional Zod or JSON schema for the response
   * @returns response string and statistics
   */
  private async _query(
    prompt: string[],
    schema?: zod.ZodObject
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

    const provider = LlmAdapter._getConfig().provider;
    vscode.commands.executeCommand(
      telemetry.commands.logTelemetry.name,
      new telemetry.LoggerEntry(
        "LlmAdapter.query.send",
        "Sending query to LLM (v=%s;m=%s). Query: %s.",
        [provider, LlmAdapter._getConfig().modelName, prompt.join("\n")]
      )
    );

    const baseChat = this._createChat();
    let chat = (
      schema ? baseChat.withSchema(schema.toJSONSchema()) : baseChat
    ).withRequestOptions({
      responseFormat: { type: "json_object" },
    });

    // Provider specific settings
    if (provider === "anthropic") {
      if (schema) {
        // Anthropic doesn't always respect responseFormat
        chat = chat.withParams({
          output_config: {
            format: zodOutputFormat(schema),
          },
        });
      }
    }

    const response = await chat.ask(promptParts);

    vscode.commands.executeCommand(
      telemetry.commands.logTelemetry.name,
      new telemetry.LoggerEntry(
        "LlmAdapter.query.response",
        "Received response from LLM (v=%s;m=%s). Response: %s.",
        [
          LlmAdapter._getConfig().provider,
          LlmAdapter._getConfig().modelName,
          response.toString(),
        ]
      )
    );

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
    return Config.get<T>(`nanofuzz.ai.${section}`, dft);
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
    return `You are an experienced software engineer who writes efficient tests that thoroughly evaluate the correctness of programs. You are aware of the important differences between a programming language's various equality operators.`;
  },
  genInputs: (
    fn: FunctionDef,
    directives: string[],
    allInputs: Map<string, unknown>
  ): string => {
    const fnRef = fn.getRef();
    const spec = fn.getCmt() ?? "";
    let inputs = Config.get<boolean>("nanofuzz.ai.backfeedPriorInputs", true)
      ? Array.from(allInputs.keys())
      : [];
    // draw a line at 10k inputs
    if (inputs.length > 10000) {
      inputs = inputs.slice(-10000);
    }
    return `To evaluate whether the following ${fnRef.lang} program "${fnRef.name}" behaves correctly relative to its specification, generate 25 program inputs that are important to determine whether the program satisfies its specification. Each program input includes all the arguments needed to call the program.

The specification for the "${fnRef.name}" program:
\`\`\`
${spec ? spec : `(no specification was found. try to infer the spec from the program below)`}
\`\`\`

The "${fnRef.name}" program:
\`\`\`${fnRef.lang}
${fnRef.src}
\`\`\`

${directives.length ? `Important details about the program's inputs:\n${directives.map((d) => ` - ${d}\n`).join("")}` : ""} 

${inputs.length ? `The following inputs were previously generated and tested, so don't generate these again:\n${inputs.map((u) => ` - ${u}\n`).join("")}` : ""}
`;
  },
};
