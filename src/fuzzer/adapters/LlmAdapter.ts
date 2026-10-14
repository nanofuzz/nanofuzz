import vscode from "vscode";
import seedrandom from "seedrandom";
import * as Config from "../../Config";
import * as JSONN from "../../Jsonn";
import * as nodellm from "@node-llm/core";
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

// Default system prompt if none is provided
const DEFAULT_SYSTEM_PROMPT =
  "You are an experienced software engineer who writes efficient tests that thoroughly evaluate the correctness of programs. You are aware of the important differences between a programming language's various equality operators.";

// Helper function to check if a value is a Record object
function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

// Cleans internal JSON schema fields ($schema, $defs, additionalProperties: boolean) that Gemini API rejects
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
      (key === "additionalProperties" && typeof value === "boolean")
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
  protected _systemPrompt: string; // System prompt
  protected static _abandoned = false; // Flag indicating if in-flight and pending LLM queries should be abandoned

  public constructor(prng?: seedrandom.prng, systemPrompt?: string) {
    LlmAdapter._handleDebug();

    this._systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    const cfg = LlmAdapter.getConfig();
    this._cfgString = JSONN.stringify(cfg);

    if (!LlmAdapter.isConfigured()) {
      throw new Error("AI Models are disabled");
    }

    // Configure model from NaNofuzz settings
    this._modelConfig = {
      provider: cfg.provider,
      retry: {
        attempts: cfg.retries,
        delayMs: cfg.retryDelay,
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
  } // constructor

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
    const inRegistry = Boolean(
      cfg.modelName && nodellm.ModelRegistry.find(cfg.modelName, cfg.provider)
    );
    const chatOptions: Parameters<typeof this._backend.chat>[1] = {
      systemPrompt: this._systemPrompt,
      requestTimeout: cfg.requestTimeout,
      ...(inRegistry ? {} : { assumeModelExists: true }),
    };
    return this._backend.chat(cfg.modelName, chatOptions);
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

  /**
   * Get cache statistics from the active cache manager
   *
   * @returns statistics on cache hits, misses, recordings, and token usage
   */
  public get cacheStats(): LlmCacheStats {
    return this._cacheManager.stats;
  } // getter: cacheStats

  /**
   * Marks active and pending LLM calls as abandoned (e.g. on SIGINT)
   * to avoid waiting for in-flight requests or executing retries
   */
  public static abandon(): void {
    LlmAdapter._abandoned = true;
  } // fn: abandon

  /**
   * Resets the abandoned state
   */
  public static resetAbandoned(): void {
    LlmAdapter._abandoned = false;
  } // fn: resetAbandoned

  /**
   * Indicates whether LLM requests have been abandoned
   *
   * @returns `true` if LLM requests have been abandoned; `false` otherwise
   */
  public static get isAbandoned(): boolean {
    return LlmAdapter._abandoned;
  } // getter: isAbandoned

  /**
   * Indicates whether any LLM queries are currently in flight across all active cache managers
   *
   * @returns `true` if any LLM queries are currently in flight; `false` otherwise
   */
  public static get isInFlight(): boolean {
    return LlmCacheManager.inFlight.length > 0;
  } // getter: isInFlight

  /**
   * Flushes cached requests across all active cache managers to disk
   *
   * @param `timeoutMs` max time in ms to wait for pending queries to finish flushing
   */
  public static async flushCache(timeoutMs = 5000): Promise<void> {
    if (LlmAdapter._abandoned) {
      return;
    }
    await LlmCacheManager.flushAllActive(timeoutMs);
  } // fn: flushCache

  /**
   * Prompts the LLM and returns a response.
   *
   * @param `prompt` LLM prompt string or array of prompt parts
   * @param `schema` optional Zod or JSON schema for the response
   * @param `options` optional query options to configure retry behavior
   * @returns response string and statistics
   */
  public async query(
    prompt: string | string[],
    schema?: zod.ZodType,
    options?: LlmQueryOptions
  ): Promise<LlmQueryResult> {
    LlmAdapter._handleDebug();

    const cfg = LlmAdapter.getConfig();
    const provider = cfg.provider;
    const modelName = cfg.modelName;
    const schemaJson = schema
      ? JSON.stringify(zod.toJSONSchema(schema))
      : undefined;

    const promptArr = Array.isArray(prompt) ? prompt : [prompt];

    return await this._cacheManager.query(
      provider,
      modelName,
      promptArr,
      schemaJson,
      async () => {
        const contentParts: nodellm.ContentPart[] = [];
        promptArr.forEach((e) => {
          contentParts.push({
            type: "text",
            text: e,
          });
        });

        vscode.commands.executeCommand(
          telemetry.commands.logTelemetry.name,
          new telemetry.LoggerEntry(
            "LlmAdapter.query.send",
            "Sending query to LLM (v=%s;m=%s). Query: %s.",
            [provider, modelName, promptArr.join("\n")]
          )
        );

        let text = "";
        let inputTokens = 0;
        let outputTokens = 0;
        let inputCost = 0;
        let outputCost = 0;

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
              `[NaNofuzz Copilot AI] Sending query (${model.vendor}/${model.name || model.id || "copilot"}):\n${promptArr.join("\n")}`
            );
          }

          const messages = [
            vscode.LanguageModelChatMessage.User(promptArr.join("\n")),
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
          const retryOnTimeout =
            options?.noRetries === true
              ? false
              : (options?.retryOnTimeout ?? options?.retries !== 0);
          const maxAttempts =
            options?.noRetries === true
              ? 1
              : options?.retries !== undefined
                ? Math.max(1, options.retries)
                : retryOnTimeout
                  ? Math.max(1, cfg.retries)
                  : 1;

          let lastError: unknown;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const baseChat = this._createChat();
              const jsonSchemaObj = schema
                ? zod.toJSONSchema(schema)
                : undefined;
              const schemaObj = jsonSchemaObj
                ? nodellm.Schema.fromJson(
                    "output",
                    cleanJsonSchema(jsonSchemaObj)
                  )
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

              const response = await chat.ask(contentParts);
              text = response.toString();
              inputTokens = response.inputTokens ?? 0;
              outputTokens = response.outputTokens ?? 0;
              inputCost = response.input_cost ?? 0;
              outputCost = response.output_cost ?? 0;
              lastError = undefined;
              break;
            } catch (err: unknown) {
              lastError = err;
              if (
                !retryOnTimeout ||
                !isTimeoutError(err) ||
                attempt >= maxAttempts ||
                LlmAdapter._abandoned
              ) {
                throw err;
              }
              if (LlmAdapter.isDebugConfigured()) {
                console.log(
                  `[NaNofuzz AI] Request timed out on attempt ${attempt}/${maxAttempts}. Retrying in ${cfg.retryDelay}ms...`
                );
              }
              if (cfg.retryDelay > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, cfg.retryDelay)
                );
              }
            }
          }
          if (lastError) {
            throw lastError;
          }
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
            tokensSentCost: { amt: inputCost, unit: "USD" },
            tokensReceived: outputTokens,
            tokensReceivedCost: { amt: outputCost, unit: "USD" },
          },
        };
      }
    );
  } // fn: query

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
   * Returns the context window size supported by the configured model,
   * or a default fallback if unlisted or unconfigured.
   */
  public static getContextWindow(): number {
    const cfg = LlmAdapter.getConfig();
    if (cfg.provider === "copilot") {
      return 128000;
    }
    const contextWindow = nodellm.ModelRegistry.getContextWindow(
      cfg.modelName,
      cfg.provider
    );
    return contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  } // fn: getContextWindow

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
    requestTimeout: number;
    retries: number;
    retryDelay: number;
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
      requestTimeout: LlmAdapter._getConfigValue<number>(
        "requestTimeout",
        DEFAULT_REQUEST_TIMEOUT
      ),
      retries: LlmAdapter._getConfigValue<number>("retries", 5),
      retryDelay: LlmAdapter._getConfigValue<number>("retryDelay", 1000),
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
   * Helper function to determine if an error is a timeout or abort error.
   *
   * @param err Unknown error to test
   * @returns True if error is a timeout error; false otherwise
   */
  public static isTimeoutError(err: unknown): boolean {
    return isTimeoutError(err);
  } // fn: isTimeoutError

  /**
   * Turns debug logging on or off depending on the `nanofuzz.ai.debug` option
   */
  protected static _handleDebug(): void {
    process.env["NODELLM_DEBUG"] = String(LlmAdapter.isDebugConfigured());
  } // fn: _handleDebug
} // class: LlmAdapter

/**
 * Fallback maximum output token limit used when a model's max output token capacity
 * is not specified in the model registry or when no model is configured.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Fallback context window size used when a model's context window capacity
 * is not specified in the model registry or when no model is configured.
 */
export const DEFAULT_CONTEXT_WINDOW = 32768;

/**
 * Fallback request timeout (in ms) for AI model requests.
 */
export const DEFAULT_REQUEST_TIMEOUT = 60_000;

/**
 * Helper function to determine if an error is a timeout or abort error
 */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("etimedout") ||
      err.name === "TimeoutError" ||
      err.name === "AbortError"
    ) {
      return true;
    }
  }
  if (isRecord(err)) {
    const code = err["code"];
    if (typeof code === "string" && code.toLowerCase().includes("timeout")) {
      return true;
    }
    const cause = err["cause"];
    if (cause instanceof Error && isTimeoutError(cause)) {
      return true;
    }
  }
  return false;
} // fn: isTimeoutError

/**
 * Options to control query execution and retry policies in LlmAdapter.
 */
export interface LlmQueryOptions {
  /** Maximum retry attempts for this query. 0 or 1 disables retries. Defaults to configured nanofuzz.ai.retries. */
  retries?: number;
  /** Whether to retry on timeout errors in LlmAdapter. Defaults to true. If false, timeouts fail immediately without retrying. */
  retryOnTimeout?: boolean;
  /** If true, disables all retries for this query. */
  noRetries?: boolean;
}
