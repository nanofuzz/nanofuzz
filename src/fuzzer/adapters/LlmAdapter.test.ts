import * as Config from "../../Config";
import {
  LlmAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT,
} from "./LlmAdapter";
import * as nodellm from "@node-llm/core";
import * as zod from "zod/v4";
import vscode from "vscode";
import {
  Agent,
  Dispatcher,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

describe("src/fuzzer/adapters/LlmAdapter:", () => {
  let savedDispatcher: Dispatcher;
  const proxyEnvVars = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    Config.clearOverrides();
    savedDispatcher = getGlobalDispatcher();
    for (const key of proxyEnvVars) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    Config.clearOverrides();
    setGlobalDispatcher(savedDispatcher);
    for (const key of proxyEnvVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("isConfigured: correctly checks configuration state", () => {
    Config.override("nanofuzz.ai.provider", "disabled");
    Config.override("nanofuzz.ai.model", "some-model");
    expect(LlmAdapter.isConfigured()).toBeFalse();

    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "");
    expect(LlmAdapter.isConfigured()).toBeFalse();

    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    expect(LlmAdapter.isConfigured()).toBeTrue();

    Config.override("nanofuzz.ai.provider", "copilot");
    expect(LlmAdapter.isConfigured()).toBeTrue();
  });

  it("getMaxOutputTokens: falls back to default for unlisted models", () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    expect(LlmAdapter.getMaxOutputTokens()).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("getConfig: includes endpoint with default or configured value", () => {
    expect(LlmAdapter.getConfig().endpoint).toBe("");

    Config.override("nanofuzz.ai.endpoint", "http://custom-endpoint:11434/v1");
    expect(LlmAdapter.getConfig().endpoint).toBe(
      "http://custom-endpoint:11434/v1"
    );
  });

  it("getConfig: includes requestTimeout with default or configured value", () => {
    expect(LlmAdapter.getConfig().requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUT);

    Config.override("nanofuzz.ai.requestTimeout", 60_000);
    expect(LlmAdapter.getConfig().requestTimeout).toBe(60_000);
  });

  it("getConfig: includes retries and retryDelay with default or configured values", () => {
    expect(LlmAdapter.getConfig().retries).toBe(5);
    expect(LlmAdapter.getConfig().retryDelay).toBe(1000);

    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 500);
    expect(LlmAdapter.getConfig().retries).toBe(3);
    expect(LlmAdapter.getConfig().retryDelay).toBe(500);
  });

  it("endpoint: uses default endpoint when none is specified", () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");

    class TestLlmAdapter extends LlmAdapter {
      public getBackend(): nodellm.NodeLLMCore | undefined {
        return this._backend;
      } // fn: getBackend
    }

    const adapter = new TestLlmAdapter();
    const provider = adapter.getBackend()?.provider;
    expect(Reflect.get(provider ?? {}, "baseUrl")).toBe(
      "http://localhost:11434/v1"
    );
  });

  it("endpoint: overrides base URL when endpoint is specified", () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override(
      "nanofuzz.ai.endpoint",
      "http://custom-ollama.internal:11434/v1"
    );

    class TestLlmAdapter extends LlmAdapter {
      public getBackend(): nodellm.NodeLLMCore | undefined {
        return this._backend;
      } // fn: getBackend
    }

    const adapter = new TestLlmAdapter();
    const provider = adapter.getBackend()?.provider;
    expect(Reflect.get(provider ?? {}, "baseUrl")).toBe(
      "http://custom-ollama.internal:11434/v1"
    );
  });

  it("endpoint: overrides base URL for other providers like OpenAI", () => {
    Config.override("nanofuzz.ai.provider", "openai");
    Config.override("nanofuzz.ai.model", "gpt-4o");
    Config.override("nanofuzz.ai.apiKey", "mock-key");
    Config.override(
      "nanofuzz.ai.endpoint",
      "https://custom-openai-proxy.internal/v1"
    );

    class TestLlmAdapter extends LlmAdapter {
      public getBackend(): nodellm.NodeLLMCore | undefined {
        return this._backend;
      } // fn: getBackend
    }

    const adapter = new TestLlmAdapter();
    const provider = adapter.getBackend()?.provider;
    expect(Reflect.get(provider ?? {}, "baseUrl")).toBe(
      "https://custom-openai-proxy.internal/v1"
    );
  });

  it("configureProxy: returns false when no proxy environment variables are set", () => {
    for (const key of proxyEnvVars) {
      delete process.env[key];
    }
    setGlobalDispatcher(new Agent());
    expect(LlmAdapter.configureProxy()).toBeFalse();
    expect(getGlobalDispatcher() instanceof EnvHttpProxyAgent).toBeFalse();
  });

  it("configureProxy: configures EnvHttpProxyAgent when proxy env var is set", () => {
    for (const key of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
    ] as const) {
      for (const k of proxyEnvVars) {
        delete process.env[k];
      }
      setGlobalDispatcher(new Agent());
      process.env[key] = "http://proxy.internal:8080";
      expect(LlmAdapter.configureProxy()).toBeTrue();
      expect(getGlobalDispatcher() instanceof EnvHttpProxyAgent).toBeTrue();
    }
  });

  it("constructor: configures proxy when proxy environment variable is present", () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    setGlobalDispatcher(new Agent());
    process.env.HTTPS_PROXY = "http://proxy.internal:8080";

    expect(new LlmAdapter()).toBeDefined();
    expect(getGlobalDispatcher() instanceof EnvHttpProxyAgent).toBeTrue();
  });

  it("_createChat: sets assumeModelExists to true for unlisted/local models", () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");

    class TestLlmAdapter extends LlmAdapter {
      public getChat(): nodellm.Chat {
        return this._createChat();
      } // fn: getChat
    }

    const adapter = new TestLlmAdapter();
    const chat = adapter.getChat();

    // The chat options should have assumeModelExists enabled
    const chatOptions = Reflect.get(chat, "options");
    expect(Reflect.get(chatOptions, "assumeModelExists")).toBeTrue();
  });

  it("_createChat: omits assumeModelExists when model is in the registry", () => {
    Config.override("nanofuzz.ai.provider", "gemini");
    Config.override("nanofuzz.ai.model", "gemini-3.1-flash-lite");
    Config.override("nanofuzz.ai.apiKey", "mock-key");

    class TestLlmAdapter extends LlmAdapter {
      public getChat(): nodellm.Chat {
        return this._createChat();
      } // fn: getChat
    }

    const adapter = new TestLlmAdapter();
    const chat = adapter.getChat();

    // The chat options should not have assumeModelExists enabled
    const chatOptions = Reflect.get(chat, "options");
    expect(Reflect.get(chatOptions, "assumeModelExists")).toBeFalsy();
  });

  it("_createChat: sets requestTimeout from configuration or default 60_000", () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");

    class TestLlmAdapter extends LlmAdapter {
      public getChat(): nodellm.Chat {
        return this._createChat();
      } // fn: getChat
    }

    const adapter = new TestLlmAdapter();
    const chatDefault = adapter.getChat();
    const defaultOptions = Reflect.get(chatDefault, "options");
    expect(Reflect.get(defaultOptions, "requestTimeout")).toBe(60_000);

    Config.override("nanofuzz.ai.requestTimeout", 45_000);
    const chatConfigured = adapter.getChat();
    const configuredOptions = Reflect.get(chatConfigured, "options");
    expect(Reflect.get(configuredOptions, "requestTimeout")).toBe(45_000);
  });

  it("query: retries on timeout up to configured attempts and succeeds when retry resolves", async () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 1);

    let askCount = 0;
    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      askCount++;
      if (askCount < 3) {
        throw new Error("Request timeout after 60000ms");
      }
      return new nodellm.ChatResponseString(
        '{"output": "ok"}',
        {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
        },
        "qwen2.5-coder:7b",
        "ollama"
      );
    });

    const adapter = new LlmAdapter();
    const res = await adapter.query("generate inputs");
    expect(res.text).toBe('{"output": "ok"}');
    expect(askCount).toBe(3);
  });

  it("query: extracts token costs when provided by model response", async () => {
    Config.override("nanofuzz.ai.provider", "openai");
    Config.override("nanofuzz.ai.model", "gpt-4o");
    Config.override("nanofuzz.ai.apiKey", "mock-key");

    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      return new nodellm.ChatResponseString(
        '{"output": "ok"}',
        {
          input_tokens: 150,
          output_tokens: 50,
          total_tokens: 200,
          input_cost: 0.000375,
          output_cost: 0.0005,
          cost: 0.000875,
        },
        "gpt-4o",
        "openai"
      );
    });

    const adapter = new LlmAdapter();
    const res = await adapter.query("generate inputs");
    expect(res.stats.tokensSent).toBe(150);
    expect(res.stats.tokensSentCost).toEqual({ amt: 0.000375, unit: "USD" });
    expect(res.stats.tokensReceived).toBe(50);
    expect(res.stats.tokensReceivedCost).toEqual({ amt: 0.0005, unit: "USD" });
  });

  it("query: does not retry on non-timeout error", async () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 1);

    let askCount = 0;
    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      askCount++;
      throw new Error("Authentication failed");
    });

    const adapter = new LlmAdapter();
    await expectAsync(adapter.query("generate inputs")).toBeRejectedWithError(
      /Authentication failed/
    );
    expect(askCount).toBe(1);
  });

  it("query: throws timeout error when all retry attempts are exhausted", async () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 1);

    let askCount = 0;
    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      askCount++;
      throw new Error("Request timeout after 60000ms");
    });

    const adapter = new LlmAdapter();
    await expectAsync(adapter.query("generate inputs")).toBeRejectedWithError(
      /Request timeout after 60000ms/
    );
    expect(askCount).toBe(3);
  });

  it("query: does not retry on timeout when retryOnTimeout option is false", async () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 1);

    let askCount = 0;
    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      askCount++;
      throw new Error("Request timeout after 60000ms");
    });

    const adapter = new LlmAdapter();
    await expectAsync(
      adapter.query("generate inputs", undefined, { retryOnTimeout: false })
    ).toBeRejectedWithError(/Request timeout after 60000ms/);
    expect(askCount).toBe(1);
  });

  it("query: does not retry on timeout when noRetries option is true", async () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 1);

    let askCount = 0;
    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      askCount++;
      throw new Error("Request timeout after 60000ms");
    });

    const adapter = new LlmAdapter();
    await expectAsync(
      adapter.query("generate inputs", undefined, { noRetries: true })
    ).toBeRejectedWithError(/Request timeout after 60000ms/);
    expect(askCount).toBe(1);
  });

  it("query: does not retry on timeout when retries option is 0", async () => {
    Config.override("nanofuzz.ai.provider", "ollama");
    Config.override("nanofuzz.ai.model", "qwen2.5-coder:7b");
    Config.override("nanofuzz.ai.retries", 3);
    Config.override("nanofuzz.ai.retryDelay", 1);

    let askCount = 0;
    spyOn(nodellm.Chat.prototype, "ask").and.callFake(async () => {
      askCount++;
      throw new Error("Request timeout after 60000ms");
    });

    const adapter = new LlmAdapter();
    await expectAsync(
      adapter.query("generate inputs", undefined, { retries: 0 })
    ).toBeRejectedWithError(/Request timeout after 60000ms/);
    expect(askCount).toBe(1);
  });

  it("query: enables structured output mode via tools and toolMode with vscode lm", async () => {
    Config.override("nanofuzz.ai.provider", "copilot");
    Config.override("nanofuzz.ai.model", "gemini-3.7-flash");
    Config.override("nanofuzz.ai.vendor", "google");

    const schema = zod.strictObject({
      programInputs: zod.array(
        zod.strictObject({
          expr: zod.string(),
        })
      ),
    });

    let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
    const models = await vscode.lm.selectChatModels({
      family: "gemini-3.7-flash",
    });
    expect(models.length).toBeGreaterThan(0);
    const model = models[0];

    spyOn(model, "sendRequest").and.callFake(async (_messages, options) => {
      capturedOptions = options;
      return {
        text: (async function* () {})(),
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart(
            "call-1",
            "programInputs",
            { programInputs: [{ expr: "1 + 1" }] }
          );
        })(),
      };
    });

    const adapter = new LlmAdapter();
    const result = await adapter.query("generate inputs", schema);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.tools?.length).toBe(1);
    expect(capturedOptions?.tools?.[0].name).toBe("programInputs");
    expect(capturedOptions?.tools?.[0].inputSchema).toBeDefined();
    expect(capturedOptions?.toolMode).toBe(
      vscode.LanguageModelChatToolMode.Required
    );
    expect(capturedOptions?.modelOptions?._enableThinking).toBe(false);
    expect(result.text).toBe(
      JSON.stringify({ programInputs: [{ expr: "1 + 1" }] })
    );
  });
});
