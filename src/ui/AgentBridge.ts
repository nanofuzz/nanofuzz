import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import vscode from "vscode";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as Config from "../Config";
import { getToolName, showResults } from "./Agent";
import { createMcpServer, McpHostHooks } from "./McpServer";
import {
  BridgeInfo,
  removeBridgeInfo,
  writeBridgeInfo,
} from "./McpBridgeClient";
import { resolveMatchingModel } from "../fuzzer/adapters/VscodeLmAdapter";
import pkg from "../../package.json";

const MCP_CONFIG_FILE = ".mcp.json";
const MCP_SERVER_NAME = "nanofuzz";
const MCP_SERVER_CONFIG = {
  command: "npx",
  args: ["-y", "@nanofuzz/cli", "mcp"],
};

// -------------------------------------------------------------------------- //
// Agent Bridge
// -------------------------------------------------------------------------- //

/**
 * Starts the agent bridge: a loopback MCP endpoint that lets coding agents
 * running outside VS Code's own agent host call the NaNofuzz tools (including
 * nanofuzz_showResults) inside this process. Any MCP client that launches
 * `nanofuzz mcp` over stdio finds the endpoint through a discovery file and
 * proxies to it.
 *
 * @param options Host hooks, workspace folders, and discovery directory
 * @returns Handle for the running bridge
 */
export async function startAgentBridge(
  options: AgentBridgeOptions
): Promise<AgentBridge> {
  const token = crypto.randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((e: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end(e instanceof Error ? e.message : String(e));
    });
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Fuzzing executes workspace code, so only our own CLI may connect:
    // no browsers (Origin), no DNS rebinding (Host), and a secret token.
    if (req.headers.origin !== undefined || !isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (
      auth.length !== expectedAuth.length ||
      !crypto.timingSafeEqual(auth, expectedAuth)
    ) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing =
      typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (sessionId !== undefined || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }

    // New session: each gets its own MCP server instance
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };
    const server = await createMcpServer(undefined, options.host);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } // fn: handleRequest

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    httpServer.close();
    throw new Error("Agent bridge failed to bind to a loopback port");
  }

  const info: BridgeInfo = {
    pid: process.pid,
    port: address.port,
    token,
    workspaceFolders: options.workspaceFolders,
    version: process.env.NANOFUZZ_VERSION ?? pkg.version,
  };
  writeBridgeInfo(info, options.bridgeDir);

  return {
    info,
    setWorkspaceFolders: (folders: string[]) => {
      info.workspaceFolders = folders;
      writeBridgeInfo(info, options.bridgeDir);
    },
    dispose: async () => {
      removeBridgeInfo(info.pid, options.bridgeDir);
      for (const transport of [...transports.values()]) {
        await transport.close().catch(() => undefined);
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
} // fn: startAgentBridge

/**
 * Starts the agent bridge for this VS Code window, if enabled, and keeps its
 * advertised workspace folders current.
 *
 * @returns Disposables that stop the bridge
 */
export async function registerAgentBridge(): Promise<vscode.Disposable[]> {
  if (!Config.get<boolean>("nanofuzz.agent.bridge.enabled", true)) {
    return [];
  }

  const bridge = await startAgentBridge({
    host: { showResults, resolveModel: resolveMatchingModel },
    workspaceFolders: getWorkspaceFolderPaths(),
  });

  const disposables: vscode.Disposable[] = [
    { dispose: () => void bridge.dispose() },
  ];
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        bridge.setWorkspaceFolders(getWorkspaceFolderPaths());
      })
    );
  }
  return disposables;
} // fn: registerAgentBridge

// -------------------------------------------------------------------------- //
// Coding Agent Setup
// -------------------------------------------------------------------------- //

/**
 * Adds the NaNofuzz MCP server to a project-scoped MCP configuration
 * (`.mcp.json`, using the common `mcpServers` format), preserving any servers
 * already configured.
 *
 * @param existing Current file contents, or undefined if the file does not exist
 * @returns The new file contents, or undefined if NaNofuzz is already configured
 * @throws If the existing contents are not a JSON object
 */
export function addNanofuzzToMcpConfig(
  existing: string | undefined
): string | undefined {
  const config: unknown =
    existing === undefined || existing.trim() === ""
      ? {}
      : JSON.parse(existing);
  if (!isRecord(config)) {
    throw new Error("Expected a JSON object");
  }

  const servers = config.mcpServers ?? {};
  if (!isRecord(servers)) {
    throw new Error("Expected `mcpServers` to be a JSON object");
  }
  if (MCP_SERVER_NAME in servers) {
    return undefined;
  }

  return (
    JSON.stringify(
      {
        ...config,
        mcpServers: { ...servers, [MCP_SERVER_NAME]: MCP_SERVER_CONFIG },
      },
      null,
      2
    ) + "\n"
  );
} // fn: addNanofuzzToMcpConfig

/**
 * Returns the NaNofuzz MCP server entry in the common `mcpServers` format, for
 * coding agents that read their MCP configuration from somewhere other than
 * `.mcp.json`.
 */
export function getMcpConfigSnippet(): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: MCP_SERVER_CONFIG } },
    null,
    2
  );
} // fn: getMcpConfigSnippet

/**
 * Command handler: configures coding agents to use NaNofuzz in a workspace
 * folder by adding it to the folder's `.mcp.json`.
 */
async function handleSetupMcpServerCommand(): Promise<void> {
  const toolName = getToolName();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder =
    folders.length > 1
      ? await vscode.window.showWorkspaceFolderPick({
          placeHolder: `Folder to set up the ${toolName} MCP server for`,
        })
      : folders[0];
  if (!folder) {
    if (folders.length === 0) {
      vscode.window.showErrorMessage(
        `Open a folder before setting up the ${toolName} MCP server.`
      );
    }
    return;
  }

  const file = path.join(folder.uri.fsPath, MCP_CONFIG_FILE);
  let message: string;
  try {
    const updated = addNanofuzzToMcpConfig(
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined
    );
    if (updated === undefined) {
      message = `${toolName} is already configured in ${MCP_CONFIG_FILE}.`;
    } else {
      fs.writeFileSync(file, updated, "utf8");
      message = `Added ${toolName} to ${MCP_CONFIG_FILE}. Restart your coding agent in this folder and approve the "${MCP_SERVER_NAME}" MCP server if asked.`;
    }
  } catch (e: unknown) {
    vscode.window.showErrorMessage(
      `Unable to update ${file}: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  const copyAction = "Copy Configuration";
  const choice = await vscode.window.showInformationMessage(
    `${message} If your agent reads MCP servers from a different file, copy the configuration into it.`,
    copyAction
  );
  if (choice === copyAction) {
    await vscode.env.clipboard.writeText(getMcpConfigSnippet());
  }
} // fn: handleSetupMcpServerCommand

/**
 * Commands contributed by this module
 */
export const commands = {
  setupMcpServer: {
    name: "nanofuzz.SetupMcpServer",
    fn: handleSetupMcpServerCommand,
  },
};

// -------------------------------------------------------------------------- //
// Helper Functions
// -------------------------------------------------------------------------- //

/**
 * Returns true if an HTTP Host header names the loopback interface.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
} // fn: isLoopbackHost

/**
 * Returns the filesystem paths of the folders open in this window.
 */
function getWorkspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath)
    .filter((folderPath) => Boolean(folderPath));
} // fn: getWorkspaceFolderPaths

/**
 * Type guard for plain JSON objects.
 */
function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
} // fn: isRecord

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Options for starting the agent bridge
 */
export type AgentBridgeOptions = {
  host: McpHostHooks; // capabilities of the hosting process
  workspaceFolders: string[]; // folders this bridge serves
  bridgeDir?: string; // discovery directory (defaults to getBridgeDir())
};

/**
 * A running agent bridge
 */
export type AgentBridge = {
  info: BridgeInfo;
  setWorkspaceFolders: (folders: string[]) => void;
  dispose: () => Promise<void>;
};
