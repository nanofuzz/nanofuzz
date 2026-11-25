import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Config from "../Config";
import * as ParserAdapter from "../fuzzer/adapters/ParserAdapter";
import {
  addNanofuzzToMcpConfig,
  AgentBridge,
  startAgentBridge,
} from "./AgentBridge";
import { attachToBridge, findBridge } from "./McpBridgeClient";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

describe("AgentBridge", () => {
  const fixtureDir = path.resolve(__dirname, "../fuzzer/test_fixtures");
  const tsFixture = path.join(fixtureDir, "Fuzzer.testfixtures.ts");

  let bridgeDir: string;
  let bridge: AgentBridge;
  let shown: string[];

  beforeAll(async () => {
    await ParserAdapter.init();
  });

  beforeEach(async () => {
    Config.clearOverrides();
    bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-bridge-"));
    shown = [];
    bridge = await startAgentBridge({
      host: {
        showResults: async (options) => {
          shown.push(options.filePath);
          return { success: true, message: "Displayed in host" };
        },
      },
      workspaceFolders: [fixtureDir],
      bridgeDir,
    });
  });

  afterEach(async () => {
    await bridge.dispose();
    fs.rmSync(bridgeDir, { recursive: true, force: true });
    Config.clearOverrides();
  });

  function post(headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${bridge.info.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  it("advertises itself and withdraws the advertisement on dispose", async () => {
    const found = findBridge(fixtureDir, bridgeDir);
    expect(found?.port).toBe(bridge.info.port);
    expect(found?.token).toBe(bridge.info.token);
    expect(found?.pid).toBe(process.pid);

    bridge.setWorkspaceFolders([]);
    expect(findBridge(fixtureDir, bridgeDir)).toBeUndefined();
    bridge.setWorkspaceFolders([fixtureDir]);

    await bridge.dispose();
    expect(fs.readdirSync(bridgeDir)).toEqual([]);
    expect(findBridge(fixtureDir, bridgeDir)).toBeUndefined();
  });

  it("rejects requests without the bearer token", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("rejects requests from browsers", async () => {
    const res = await post({
      Authorization: `Bearer ${bridge.info.token}`,
      Origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("serves host tools to an attached CLI proxy", async () => {
    // Attach from a subdirectory-relative cwd, as `nanofuzz mcp` would
    const attached = await attachToBridge(fixtureDir, bridgeDir);
    expect(attached).toBeDefined();
    if (!attached) {
      return;
    }

    // The calling agent talks to the proxy server
    const agent = new Client(
      { name: "test-agent", version: "1.0.0" },
      { capabilities: {} }
    );
    const [agentTransport, proxyTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      agent.connect(agentTransport),
      attached.server.connect(proxyTransport),
    ]);

    const tools = (await agent.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("nanofuzz_listTargets");
    expect(tools).toContain("nanofuzz_fuzzFunction");
    expect(tools).toContain("nanofuzz_findBugs");
    expect(tools).toContain("nanofuzz_shrinkInputs");
    expect(tools).toContain("nanofuzz_showResults");

    const listed = await agent.callTool({
      name: "nanofuzz_listTargets",
      arguments: { filePath: "Fuzzer.testfixtures.ts" },
    });
    expect(JSON.stringify(listed.content)).toContain(
      "testStandardVoidReturnUndefined"
    );

    // Relative paths resolve against the agent's cwd, not the host's
    const result = await agent.callTool({
      name: "nanofuzz_showResults",
      arguments: {
        filePath: "Fuzzer.testfixtures.ts",
        functionName: "testStandardVoidReturnUndefined",
      },
    });
    expect(shown).toEqual([tsFixture]);
    expect(JSON.stringify(result.content)).toContain("Displayed in host");

    await agent.close();
    await attached.close();
  });

  it("tells the agent to reconnect when the bridge goes away", async () => {
    const attached = await attachToBridge(fixtureDir, bridgeDir);
    expect(attached).toBeDefined();
    if (!attached) {
      return;
    }
    const agent = new Client(
      { name: "test-agent", version: "1.0.0" },
      { capabilities: {} }
    );
    const [agentTransport, proxyTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      agent.connect(agentTransport),
      attached.server.connect(proxyTransport),
    ]);

    await bridge.dispose();

    const result = await agent.callTool({
      name: "nanofuzz_listTargets",
      arguments: { filePath: tsFixture },
    });
    expect(result.isError).toBeTrue();
    expect(JSON.stringify(result.content)).toContain("Reconnect");

    await agent.close();
    await attached.close();
  });
});

describe("AgentBridge.addNanofuzzToMcpConfig", () => {
  const nanofuzz = { command: "npx", args: ["-y", "@nanofuzz/cli", "mcp"] };

  it("creates a configuration when none exists", () => {
    const updated = addNanofuzzToMcpConfig(undefined);
    expect(JSON.parse(updated ?? "")).toEqual({ mcpServers: { nanofuzz } });
    expect(updated?.endsWith("\n")).toBeTrue();
  });

  it("preserves other servers and settings", () => {
    const updated = addNanofuzzToMcpConfig(
      JSON.stringify({ other: 1, mcpServers: { github: { command: "gh" } } })
    );
    expect(JSON.parse(updated ?? "")).toEqual({
      other: 1,
      mcpServers: { github: { command: "gh" }, nanofuzz },
    });
  });

  it("leaves an existing nanofuzz entry alone", () => {
    expect(
      addNanofuzzToMcpConfig(
        JSON.stringify({ mcpServers: { nanofuzz: { command: "custom" } } })
      )
    ).toBeUndefined();
  });

  it("refuses to overwrite a file it cannot parse", () => {
    expect(() => addNanofuzzToMcpConfig("{ not json")).toThrow();
    expect(() => addNanofuzzToMcpConfig("[]")).toThrow();
    expect(() => addNanofuzzToMcpConfig('{"mcpServers": []}')).toThrow();
  });
});
