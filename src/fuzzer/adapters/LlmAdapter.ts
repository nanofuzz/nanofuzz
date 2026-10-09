import vscode from "vscode";
import seedrandom from "seedrandom";
import * as Config from "../../Config";
import { ArgValueType } from "../analysis/Types";
import * as JSONN from "../../Jsonn";
import { FunctionDef } from "../analysis/FunctionDef";
import * as nodellm from "@node-llm/core";
import { isError } from "../Util";
import * as telemetry from "../../telemetry/Telemetry";
import * as zod from "zod/v4";
import { zodOutputFormat } from "./AnthropicUtils";
import { LlmCacheManager } from "./LlmCacheManager";
import { LlmDelayCalculator } from "./LlmDelayCalculator";
import {
  LlmCacheMode,
  LlmCacheStats,
  LlmQueryResult,
} from "../generators/Types";

// Helper function to check if a value is a Record object
function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

// Cleans internal JSON schema fields ($schema, $defs, additionalProperties) that Gemini API rejects
function cleanJsonSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "$schema" ||
      key === "$id" ||
      key === "$defs" ||
      key === "definitions" ||
      key === "additionalProperties"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        isRecord(item) ? cleanJsonSchema(item) : item
      );
    } else if (isRecord(value)) {
      result[key] = cleanJsonSchema(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * An adapter for chatting with an LLM about the program under test
 */
export class LlmAdapter {
  protected _modelConfig: Parameters<typeof nodellm.createLLM>[0] = {}; // LLM configuration
  protected _backend?: nodellm.NodeLLMCore; // LLM instance
  protected _cacheManager: LlmCacheManager; // Cache manager
  protected _cfgString: string; // LLM config; for detecting config changes

  public constructor(prng?: seedrandom.prng) {
    LlmAdapter._handleDebug();

    const cfg = LlmAdapter.getConfig();
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
      switch (cfg.provider) {
        case "openai":
          this._modelConfig.openaiApiKey = cfg.apiKey;
          break;
        case "anthropic":
          this._modelConfig.anthropicApiKey = cfg.apiKey;
          break;
        case "gemini":
          this._modelConfig.geminiApiKey = cfg.apiKey;
          break;
        case "deepseek":
          this._modelConfig.deepseekApiKey = cfg.apiKey;
          break;
        case "openrouter":
          this._modelConfig.openrouterApiKey = cfg.apiKey;
          break;
        case "xai":
          this._modelConfig.xaiApiKey = cfg.apiKey;
          break;
        case "mistral":
          this._modelConfig.mistralApiKey = cfg.apiKey;
          break;
        case "bedrock":
          this._modelConfig.bedrockApiKey = cfg.apiKey;
          break;
        default:
          break;
      }
    }

    // If endpoint is defined, add it to the config.
    // Otherwise, let @node-llm use its default endpoint
    const endpoint = cfg.endpoint.trim();
    if (endpoint !== "") {
      switch (cfg.provider) {
        case "openai":
          this._modelConfig.openaiApiBase = endpoint;
          break;
        case "anthropic":
          this._modelConfig.anthropicApiBase = endpoint;
          break;
        case "gemini":
          this._modelConfig.geminiApiBase = endpoint;
          break;
        case "deepseek":
          this._modelConfig.deepseekApiBase = endpoint;
          break;
        case "ollama":
          this._modelConfig.ollamaApiBase = endpoint;
          break;
        case "openrouter":
          this._modelConfig.openrouterApiBase = endpoint;
          break;
        case "xai":
          this._modelConfig.xaiApiBase = endpoint;
          break;
        case "mistral":
          this._modelConfig.mistralApiBase = endpoint;
          break;
        default:
          break;
      }
    }

    // Create the model backend
    if (cfg.provider !== "copilot") {
      this._backend = nodellm.createLLM(this._modelConfig);
    }
    const delayConfig = cfg.cacheDelay
      ? LlmDelayCalculator.parse(cfg.cacheDelay)
      : undefined;
    this._cacheManager = new LlmCacheManager(
      cfg.cacheMode,
      cfg.cacheFile,
      delayConfig,
      prng
    );
  }

  /**
   * Creates a fresh, stateless LLM chat session for a single query.
   *
   * @returns a new nodellm.Chat instance
   */
  protected _createChat(): nodellm.Chat {
    if (!this._backend) {
      throw new Error("NodeLLMCore backend is not initialized");
    }
    const cfg = LlmAdapter.getConfig();
    return this._backend.chat(cfg.modelName, {
      systemPrompt: prompt.system(),
      assumeModelExists: true,
    });
  } // fn: createChat

  /**
   * Determine if the LLM config used to connect to the LLM is now out of date
   *
   * @returns `true` if the LLM config has changed since instantiation
   */
  public isStale(): boolean {
    return JSONN.stringify(LlmAdapter.getConfig()) !== this._cfgString;
  } // fn: isStale

  /**
   * Get a string id indicating the back-end LLM
   *
   * @returns a string indicating the configured provider and model id
   */
  public get id(): string | undefined {
    const cfg = LlmAdapter.getConfig();
    if (cfg.provider === "copilot") {
      const v = cfg.vendor || "copilot";
      const m = cfg.modelName || "default";
      return `v=${v},n=${m}`;
    }
    return `v=${this._backend?.provider?.id},n=${cfg.modelName}`;
  } // getter: id

  public get cacheStats(): LlmCacheStats {
    return this._cacheManager.stats;
  }

  public static async flushCache(timeoutMs = 5000): Promise<void> {
    await LlmCacheManager.flushAllActive(timeoutMs);
  }

  /**
   * Prompt an LLM to generate inputs for a function
   *
   * @param `fn` function for which inputs should be generated
   * @param `schema` optional Zod or JSON schema of the function's inputs
   * @param `directives` formatting directives for input schema
   * @param `allInputs` map of previously generated inputs
   * @param `moduleSrc` full module source code
   * @param `numRequested` number of inputs requested
   * @param `reqSeqNum` optional 1-indexed sequence number of this request in the session
   * @returns a set of inputs, stats, and error information
   */
  public async genInputs(
    fn: FunctionDef,
    schema: zod.ZodType,
    directives: string[],
    allInputs: Map<string, unknown>,
    moduleSrc: string,
    numRequested: number,
    reqSeqNum?: number
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
            fn,
            directives,
            allInputs,
            moduleSrc,
            numRequested,
            reqSeqNum
          ),
        ],
        schema
      );
      const inputs: { programInputs: { [k: string]: ArgValueType }[] } =
        JSONN.parse(response.text);

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
    } catch (e: unknown) {
      return {
        programInputs: [],
        error: {
          type: "failure",
          message: isError(e) ? e.message : "unknown llm failure",
        },
      };
    }
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
    schema?: zod.ZodType
  ): Promise<LlmQueryResult> {
    LlmAdapter._handleDebug();

    const cfg = LlmAdapter.getConfig();
    const provider = cfg.provider;
    const modelName = cfg.modelName;
    const schemaJson = schema
      ? JSON.stringify(zod.toJSONSchema(schema))
      : undefined;

    return await this._cacheManager.query(
      provider,
      modelName,
      prompt,
      schemaJson,
      async () => {
        const promptParts: nodellm.ContentPart[] = [];
        prompt.forEach((e) => {
          promptParts.push({
            type: "text",
            text: e,
          });
        });

        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "LlmAdapter.query.send",
            "Sending query to LLM (v=%s;m=%s). Query: %s.",
            [provider, modelName, prompt.join("\n")]
          )
        );

        let text = "";
        let inputTokens = 0;
        let outputTokens = 0;

        if (provider === "copilot") {
          if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
            throw new Error(
              "Copilot Language Model API is not available in the current environment."
            );
          }

          const selector: vscode.LanguageModelChatSelector = {};
          if (cfg.vendor) {
            selector.vendor = cfg.vendor;
          }
          if (modelName) {
            selector.family = modelName;
          }

          let models = await vscode.lm.selectChatModels(
            Object.keys(selector).length > 0 ? selector : undefined
          );
          if (!models || models.length === 0) {
            models = await vscode.lm.selectChatModels();
          }
          if (!models || models.length === 0) {
            throw new Error(
              "No Language Models available in VS Code. Ensure a model provider is installed and active in VS Code."
            );
          }

          const model = models[0];
          if (LlmAdapter.isDebugConfigured()) {
            console.log(
              `[NaNofuzz Copilot AI] Sending query (${model.vendor}/${model.name || model.id || "copilot"}):\n${prompt.join("\n")}`
            );
          }

          const messages = [
            vscode.LanguageModelChatMessage.User(prompt.join("\n")),
          ];

          const response = await model.sendRequest(
            messages,
            {},
            new vscode.CancellationTokenSource().token
          );
          for await (const chunk of response.text) {
            text += chunk;
          }

          if (LlmAdapter.isDebugConfigured()) {
            console.log(`[NaNofuzz Copilot AI] Received response:\n${text}`);
          }
        } else {
          const promptParts: nodellm.ContentPart[] = [];
          prompt.forEach((e) => {
            promptParts.push({
              type: "text",
              text: e,
            });
          });

          const baseChat = this._createChat();
          const jsonSchemaObj = schema ? zod.toJSONSchema(schema) : undefined;
          const schemaObj = jsonSchemaObj
            ? nodellm.Schema.fromJson("output", cleanJsonSchema(jsonSchemaObj))
            : undefined;
          let chat = (schemaObj ? baseChat.withSchema(schemaObj) : baseChat)
            .withRequestOptions({
              responseFormat: { type: "json_object" },
            })
            .withParams({
              max_tokens: undefined, // Overrides default 4096 with undefined
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
          text = response.toString();
          inputTokens = response.inputTokens ?? 0;
          outputTokens = response.outputTokens ?? 0;
        }

        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "LlmAdapter.query.response",
            "Received response from LLM (v=%s;m=%s). Response: %s.",
            [provider, modelName, text]
          )
        );

        return {
          text,
          stats: {
            tokensSent: inputTokens,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: outputTokens,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
      }
    );
  } // fn: _query

  /**
   * Determines if the LLM is configured and should be active.
   *
   * @returns `true` if the LLM is configured to be active, `false` otherwise
   */
  public static isConfigured(): boolean {
    const cfg = LlmAdapter.getConfig();
    if (cfg.provider === "disabled") {
      return false;
    }
    if (cfg.provider === "copilot") {
      return true;
    }
    return cfg.modelName !== "";
  } // fn: isConfigured

  /**
   * Returns the maximum output token count supported by the configured model,
   * or a default fallback if unlisted or unconfigured.
   */
  public static getMaxOutputTokens(): number {
    const cfg = LlmAdapter.getConfig();
    if (cfg.provider === "copilot") {
      return 4096;
    }
    const maxTokens = nodellm.ModelRegistry.getMaxOutputTokens(
      cfg.modelName,
      cfg.provider
    );
    return maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  } // fn: getMaxOutputTokens

  /**
   * Gets the key elements of the LLM configuration
   *
   * @returns provider, modelName, and apiKey
   */
  public static getConfig(): {
    provider: string;
    modelName: string;
    vendor: string;
    apiKey: string;
    endpoint: string;
    cacheMode: LlmCacheMode;
    cacheFile: string;
    cacheDelay: string;
  } {
    return {
      provider: LlmAdapter._getConfigValue("provider", "disabled"),
      modelName: LlmAdapter._getConfigValue("model", ""),
      vendor: LlmAdapter._getConfigValue("vendor", ""),
      apiKey: LlmAdapter._getConfigValue("apiKey", ""),
      endpoint: LlmAdapter._getConfigValue("endpoint", ""),
      cacheMode: LlmAdapter._getConfigValue<LlmCacheMode>(
        "cacheMode",
        "passthrough"
      ),
      cacheFile: LlmAdapter._getConfigValue<string>(
        "cacheFile",
        ".nanofuzz-llm-cache.json"
      ),
      cacheDelay: LlmAdapter._getConfigValue<string>("cacheDelay", "1x"),
    };
  } // fn: getConfig

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
export const prompt = {
  system: (): string => {
    return `You are an experienced software engineer who writes efficient tests that thoroughly evaluate the correctness of programs. You are aware of the important differences between a programming language's various equality operators.`;
  },
  genInputs: (
    fn: FunctionDef,
    directives: string[],
    allInputs: Map<string, unknown>,
    moduleSrc: string,
    numRequested: number,
    reqSeqNum: number = 1
  ): string => {
    const fnRef = fn.getRef();
    const spec = (fn.getCmt() ?? "").replaceAll("```", "\\`\\`\\`");
    const fnSrc = fnRef.src.replaceAll("```", "\\`\\`\\`");
    const escapedModuleSrc = moduleSrc.replaceAll("```", "\\`\\`\\`");

    const backfeed = Config.get<boolean>(
      "nanofuzz.ai.backfeedPriorInputs",
      true
    );
    let inputs = backfeed ? Array.from(allInputs.keys()) : [];
    // draw a line at 10k inputs
    if (inputs.length > 10000) {
      inputs = inputs.slice(-10000);
    }

    const moduleContext = escapedModuleSrc
      ? `The full module source code containing "${fnRef.name}":
\`\`\`${fnRef.lang}
${escapedModuleSrc}
\`\`\`

`
      : "";

    return `To evaluate whether the following ${fnRef.lang} program "${fnRef.name}" behaves correctly relative to its specification, generate ${numRequested} program inputs that are important to determine whether the program satisfies its specification. Each program input includes all the arguments needed to call the program.

Format your response as a single minified JSON object without unnecessary whitespace, newlines, or formatting indentation.

The specification for the "${fnRef.name}" program:
\`\`\`
${spec ? spec : `(no specification was found. try to infer the spec from the program below)`}
\`\`\`

The "${fnRef.name}" program:
\`\`\`${fnRef.lang}
${fnSrc}
\`\`\`

${moduleContext}${directives.length ? `Important details about the program's inputs:\n${directives.map((d) => ` - ${d}\n`).join("")}` : ""} 

${
  backfeed
    ? inputs.length
      ? `The following inputs were previously generated and tested, so don't generate these again:\n${inputs.map((u) => ` - ${u}\n`).join("")}`
      : ""
    : `This is request number ${reqSeqNum ?? 1} for this testing session. Don't repeat inputs previously generated in this session.\n`
}`;
  },
};

/**
 * Fallback maximum output token limit used when a model's max output token capacity
 * is not specified in the model registry or when no model is configured.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
