import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  attachToBridge,
  BridgeInfo,
  findBridge,
  removeBridgeInfo,
  writeBridgeInfo,
} from "./McpBridgeClient";

describe("McpBridgeClient", () => {
  let tmpDir: string;
  let bridgeDir: string;
  let workspace: string;

  // A pid that is certainly not running
  const deadPid = 2 ** 22 + 12345;

  function makeInfo(overrides: Partial<BridgeInfo>): BridgeInfo {
    return {
      pid: process.pid,
      port: 1,
      token: "secret",
      workspaceFolders: [workspace],
      version: "0.0.0",
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-bridge-"))
    );
    bridgeDir = path.join(tmpDir, "bridge");
    workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.join(workspace, "pkg", "src"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds nothing when no bridge has been advertised", () => {
    expect(findBridge(workspace, bridgeDir)).toBeUndefined();
  });

  it("finds the bridge whose workspace contains the cwd", () => {
    writeBridgeInfo(makeInfo({}), bridgeDir);

    expect(findBridge(workspace, bridgeDir)?.token).toBe("secret");
    expect(
      findBridge(path.join(workspace, "pkg", "src"), bridgeDir)?.token
    ).toBe("secret");
    expect(findBridge(tmpDir, bridgeDir)).toBeUndefined();
    expect(findBridge(`${workspace}-other`, bridgeDir)).toBeUndefined();
  });

  it("prefers the most specific workspace folder", () => {
    writeBridgeInfo(makeInfo({ token: "outer" }), bridgeDir);
    writeBridgeInfo(
      makeInfo({
        pid: process.ppid,
        token: "inner",
        workspaceFolders: [path.join(workspace, "pkg")],
      }),
      bridgeDir
    );

    expect(
      findBridge(path.join(workspace, "pkg", "src"), bridgeDir)?.token
    ).toBe("inner");
    expect(findBridge(workspace, bridgeDir)?.token).toBe("outer");
  });

  it("ignores and deletes advertisements from dead processes", () => {
    const file = writeBridgeInfo(makeInfo({ pid: deadPid }), bridgeDir);

    expect(findBridge(workspace, bridgeDir)).toBeUndefined();
    expect(fs.existsSync(file)).toBeFalse();
  });

  it("ignores malformed advertisements", () => {
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "1.json"), "{ not json");
    fs.writeFileSync(path.join(bridgeDir, "2.json"), '{"pid": "nope"}');

    expect(findBridge(workspace, bridgeDir)).toBeUndefined();
  });

  it("writes advertisements readable only by the current user", () => {
    const file = writeBridgeInfo(makeInfo({}), bridgeDir);

    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    removeBridgeInfo(process.pid, bridgeDir);
    expect(fs.existsSync(file)).toBeFalse();
  });

  it("does not attach when the advertised bridge is unreachable", async () => {
    // Port 1 on loopback refuses connections
    writeBridgeInfo(makeInfo({ port: 1 }), bridgeDir);

    expect(await attachToBridge(workspace, bridgeDir)).toBeUndefined();
  });
});
