import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// Fuzzing runs can be long; do not let the proxy time out before the agent does
const BRIDGE_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Tool arguments that hold paths the calling agent may express relative to its cwd
const EXISTING_PATH_ARGS = ["filePath", "targetPath"];
const NEW_PATH_ARGS = ["exportFilePath"];

// -------------------------------------------------------------------------- //
// Bridge Discovery
// -------------------------------------------------------------------------- //

/**
 * Returns the directory where NaNofuzz VS Code windows advertise their
 * agent bridge endpoints.
 */
export function getBridgeDir(): string {
  return (
    process.env.NANOFUZZ_BRIDGE_DIR ??
    path.join(os.homedir(), ".nanofuzz", "bridge")
  );
} // fn: getBridgeDir

/**
 * Advertises an agent bridge endpoint. The file holds the bridge's secret
 * token, so it is only readable by the current user.
 *
 * @param info Bridge endpoint details
 * @param dir Discovery directory (defaults to getBridgeDir())
 * @returns Path of the discovery file
 */
export function writeBridgeInfo(
  info: BridgeInfo,
  dir: string = getBridgeDir()
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = getBridgeInfoPath(info.pid, dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
} // fn: writeBridgeInfo

/**
 * Withdraws an agent bridge advertisement.
 *
 * @param pid Process id of the bridge
 * @param dir Discovery directory (defaults to getBridgeDir())
 */
export function removeBridgeInfo(
  pid: number,
  dir: string = getBridgeDir()
): void {
  fs.rmSync(getBridgeInfoPath(pid, dir), { force: true });
} // fn: removeBridgeInfo

/**
 * Finds the agent bridge of the VS Code window that has `cwd` open. When
 * several windows qualify, the one with the most specific workspace folder wins.
 * Advertisements left behind by dead processes are deleted.
 *
 * @param cwd Directory the calling agent is working in
 * @param dir Discovery directory (defaults to getBridgeDir())
 * @returns Bridge endpoint details, or undefined if no window has `cwd` open
 */
export function findBridge(
  cwd: string,
  dir: string = getBridgeDir()
): BridgeInfo | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined; // no bridge has ever been advertised
  }

  const target = normalizeDir(cwd);
  let best: BridgeInfo | undefined;
  let bestLength = -1;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    let info: BridgeInfo;
    try {
      info = parseBridgeInfo(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue; // unreadable or mid-write: not ours to delete
    }

    if (!isProcessAlive(info.pid)) {
      fs.rmSync(fullPath, { force: true });
      continue;
    }

    for (const folder of info.workspaceFolders) {
      const normalized = normalizeDir(folder);
      if (isWithin(target, normalized) && normalized.length > bestLength) {
        best = info;
        bestLength = normalized.length;
      }
    }
  }

  return best;
} // fn: findBridge

// -------------------------------------------------------------------------- //
// Bridge Proxy
// -------------------------------------------------------------------------- //

/**
 * Connects to the agent bridge of the VS Code window that has `cwd` open and
 * returns an MCP server that forwards its tools to that window.
 *
 * @param cwd Directory the calling agent is working in
 * @param dir Discovery directory (defaults to getBridgeDir())
 * @returns The proxy server, or undefined if no bridge is reachable
 */
export async function attachToBridge(
  cwd: string,
  dir: string = getBridgeDir()
): Promise<AttachedBridge | undefined> {
  const info = findBridge(cwd, dir);
  if (!info) {
    return undefined;
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${info.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${info.token}` } } }
  );
  const client = new Client(
    { name: "nanofuzz-cli", version: info.version },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch {
    await client.close().catch(() => undefined);
    return undefined; // bridge advertised but unreachable: run standalone
  }

  const server = new Server(
    client.getServerVersion() ?? { name: "nanofuzz", version: info.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    client.listTools(request.params)
  );

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await client.callTool(
        {
          ...request.params,
          arguments: absolutizePathArgs(request.params.arguments, cwd),
        },
        CallToolResultSchema,
        { signal: extra.signal, timeout: BRIDGE_REQUEST_TIMEOUT_MS }
      );
    } catch (e: unknown) {
      if (e instanceof McpError || extra.signal.aborted) {
        throw e; // the bridge answered, or the agent cancelled
      }
      const reason = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Lost the connection to NaNofuzz in VS Code (${reason}). Reconnect the nanofuzz MCP server to continue: it re-attaches to VS Code if the window is open, or runs standalone otherwise.`,
          },
        ],
      };
    }
  });

  return {
    info,
    server,
    close: async () => {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
} // fn: attachToBridge

// -------------------------------------------------------------------------- //
// Helper Functions
// -------------------------------------------------------------------------- //

/**
 * Returns the discovery file path for a bridge process.
 */
function getBridgeInfoPath(pid: number, dir: string): string {
  return path.join(dir, `${pid}.json`);
} // fn: getBridgeInfoPath

/**
 * Parses and validates a discovery file.
 */
function parseBridgeInfo(text: string): BridgeInfo {
  const obj: unknown = JSON.parse(text);
  if (
    typeof obj === "object" &&
    obj !== null &&
    "pid" in obj &&
    typeof obj.pid === "number" &&
    "port" in obj &&
    typeof obj.port === "number" &&
    "token" in obj &&
    typeof obj.token === "string" &&
    "workspaceFolders" in obj &&
    Array.isArray(obj.workspaceFolders) &&
    obj.workspaceFolders.every((f) => typeof f === "string")
  ) {
    return {
      pid: obj.pid,
      port: obj.port,
      token: obj.token,
      workspaceFolders: obj.workspaceFolders,
      version:
        "version" in obj && typeof obj.version === "string" ? obj.version : "",
    };
  }
  throw new Error("Invalid bridge discovery file");
} // fn: parseBridgeInfo

/**
 * Returns true if a process with the given id exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM: the process exists but belongs to another user
    return (
      typeof e === "object" && e !== null && "code" in e && e.code === "EPERM"
    );
  }
} // fn: isProcessAlive

/**
 * Resolves symlinks and platform case differences so directories compare reliably.
 */
function normalizeDir(dir: string): string {
  let resolved = path.resolve(dir);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // keep the unresolved path
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
} // fn: normalizeDir

/**
 * Returns true if `child` is `parent` or a directory beneath it.
 */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
} // fn: isWithin

/**
 * Makes relative path arguments absolute against the calling agent's cwd,
 * because the VS Code window resolves relative paths against its own
 * workspace folders instead.
 */
function absolutizePathArgs(
  args: Record<string, unknown> | undefined,
  cwd: string
): Record<string, unknown> | undefined {
  if (!args) {
    return args;
  }
  const result = { ...args };
  for (const key of [...EXISTING_PATH_ARGS, ...NEW_PATH_ARGS]) {
    const value = result[key];
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      path.isAbsolute(value) ||
      value.startsWith("file://")
    ) {
      continue;
    }
    const candidate = path.resolve(cwd, value);
    if (NEW_PATH_ARGS.includes(key) || fs.existsSync(candidate)) {
      result[key] = candidate;
    }
  }
  return result;
} // fn: absolutizePathArgs

// -------------------------------------------------------------------------- //
// Type Definitions
// -------------------------------------------------------------------------- //

/**
 * Agent bridge endpoint advertised by a NaNofuzz VS Code window
 */
export type BridgeInfo = {
  pid: number; // extension host process id
  port: number; // loopback port of the bridge's MCP endpoint
  token: string; // bearer token required by the endpoint
  workspaceFolders: string[]; // folders open in the window
  version: string; // NaNofuzz version
};

/**
 * An MCP server that forwards tools to a NaNofuzz VS Code window
 */
export type AttachedBridge = {
  info: BridgeInfo;
  server: Server;
  close: () => Promise<void>;
};
