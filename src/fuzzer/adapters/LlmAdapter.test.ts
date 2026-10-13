import * as Config from "../../Config";
import {
  LlmAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT,
} from "./LlmAdapter";
import * as nodellm from "@node-llm/core";

describe("src/fuzzer/adapters/LlmAdapter:", () => {
  beforeEach(() => {
    Config.clearOverrides();
  });

  afterEach(() => {
    Config.clearOverrides();
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
});
