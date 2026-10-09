import * as Config from "../../Config";
import { LlmAdapter, DEFAULT_MAX_OUTPUT_TOKENS } from "./LlmAdapter";
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
});
