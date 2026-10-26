import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Config from "../Config";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import { createMcpServer } from "./McpServer";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

describe("McpServer", () => {
  const tsFixture = path.resolve(
    __dirname,
    "../fuzzer/test_fixtures/Fuzzer.testfixtures.ts"
  );

  beforeAll(async () => {
    await ParserAdapter.init();
  });

  beforeEach(() => {
    Config.clearOverrides();
  });

  afterEach(() => {
    Config.clearOverrides();
  });

  it("lists registered tools", async () => {
    const server = await createMcpServer();
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const toolsResponse = await client.listTools();
    const toolNames = toolsResponse.tools.map((t) => t.name);

    expect(toolNames).toContain("nanofuzz_listTargets");
    expect(toolNames).toContain("nanofuzz_fuzzFunction");

    await client.close();
    await server.close();
  });

  it("invokes nanofuzz_listTargets", async () => {
    const server = await createMcpServer();
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const result = await client.callTool({
      name: "nanofuzz_listTargets",
      arguments: { filePath: tsFixture },
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBeTrue();
    if (Array.isArray(result.content)) {
      expect(result.content.length).toBeGreaterThan(0);
      const firstContent = result.content[0];
      expect(isTextContent(firstContent)).toBeTrue();
      if (isTextContent(firstContent)) {
        expect(firstContent.text).toContain("testStandardVoidReturnUndefined");
      }
    }

    await client.close();
    await server.close();
  });

  it("invokes nanofuzz_fuzzFunction", async () => {
    const server = await createMcpServer();
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const result = await client.callTool({
      name: "nanofuzz_fuzzFunction",
      arguments: {
        filePath: tsFixture,
        functionName: "testStandardVoidReturnUndefined",
        maxTests: 5,
        timeoutMs: 2000,
      },
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBeTrue();
    if (Array.isArray(result.content)) {
      expect(result.content.length).toBeGreaterThan(0);
      const firstContent = result.content[0];
      expect(isTextContent(firstContent)).toBeTrue();
      if (isTextContent(firstContent)) {
        expect(firstContent.text).toContain("testStandardVoidReturnUndefined");
      }
    }

    await client.close();
    await server.close();
  });

  it("applies server configuration options", async () => {
    const server = await createMcpServer({
      modelProvider: "openai",
      modelName: "gpt-4o",
      modelKey: "test-key-123",
      modelEndpoint: "https://example.com/v1",
      modelTimeout: 45000,
      workers: 2,
    });

    expect(Config.get("nanofuzz.ai.provider", "")).toBe("openai");
    expect(Config.get("nanofuzz.ai.model", "")).toBe("gpt-4o");
    expect(Config.get("nanofuzz.ai.apiKey", "")).toBe("test-key-123");
    expect(Config.get("nanofuzz.ai.endpoint", "")).toBe(
      "https://example.com/v1"
    );
    expect(Config.get("nanofuzz.ai.requestTimeout", 0)).toBe(45000);
    expect(Config.get<number | "auto">("nanofuzz.fuzzer.workers", "auto")).toBe(
      2
    );

    await server.close();
  });
});

/**
 * Type guard validating that a response content element has text content.
 *
 * @param item Unknown item to inspect
 * @returns True if the item is a valid text content element
 */
function isTextContent(item: unknown): item is { type: "text"; text: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
  );
} // fn: isTextContent
