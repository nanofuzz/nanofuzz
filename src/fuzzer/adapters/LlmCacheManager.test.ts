import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LlmCacheManager, createCacheKey } from "./LlmCacheManager";
import { LlmDelayCalculator } from "./LlmDelayCalculator";
import { LlmCacheEntry, LlmCacheFile } from "../generators/Types";
import * as JSONN from "../../Jsonn";

describe("src/fuzzer/adapters/LlmCacheManager:", () => {
  let tmpDir: string;
  let cacheFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-cache-test-"));
    cacheFile = path.join(tmpDir, "llm-cache.json");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // Ignore residual Windows file lock cleanup errors
      }
    }
  });

  it("passthrough mode: passes queries through unrecorded", async () => {
    const manager = new LlmCacheManager("passthrough", cacheFile);
    let liveCalls = 0;

    const queryFn = async () => {
      liveCalls++;
      return {
        text: "hello",
        stats: {
          tokensSent: 10,
          tokensSentCost: { amt: 0, unit: "USD" },
          tokensReceived: 5,
          tokensReceivedCost: { amt: 0, unit: "USD" },
        },
      };
    };

    const res = await manager.query(
      "provider1",
      "model1",
      ["prompt1"],
      undefined,
      queryFn
    );
    expect(res.text).toBe("hello");
    expect(liveCalls).toBe(1);
    expect(fs.existsSync(cacheFile)).toBeFalse();

    const stats = manager.stats;
    expect(stats.calls).toBe(1);
    expect(stats.passedThroughUnrecorded).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.live.calls).toBe(1);
    expect(stats.live.tokensSent).toBe(10);
    expect(stats.live.tokensReceived).toBe(5);
    expect(stats.replayed.calls).toBe(0);
  });

  it("record mode: records live queries and response delays", async () => {
    const manager = new LlmCacheManager("record", cacheFile);
    let liveCalls = 0;

    const queryFn = async () => {
      liveCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        text: "recorded-answer",
        stats: {
          tokensSent: 10,
          tokensSentCost: { amt: 0, unit: "USD" },
          tokensReceived: 5,
          tokensReceivedCost: { amt: 0, unit: "USD" },
        },
      };
    };

    const res = await manager.query(
      "provider1",
      "model1",
      ["prompt1"],
      '{"type":"object"}',
      queryFn
    );
    expect(res.text).toBe("recorded-answer");
    expect(liveCalls).toBe(1);
    expect(fs.existsSync(cacheFile)).toBeTrue();

    const stats = manager.stats;
    expect(stats.calls).toBe(1);
    expect(stats.recorded).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.live.calls).toBe(1);
    expect(stats.live.tokensSent).toBe(10);
    expect(stats.live.tokensReceived).toBe(5);

    // Verify cache file contents
    const content = JSONN.parse<LlmCacheFile>(
      fs.readFileSync(cacheFile, "utf-8")
    );
    expect(content.toolVersion).toBeDefined();
    expect(content.recordings.length).toBe(1);
    expect(content.recordings[0].response.text).toBe("recorded-answer");
    expect(content.recordings[0].delayMs).toBeGreaterThanOrEqual(15);
  });

  it("replay-record mode: serves hits from cache with delay and records misses", async () => {
    // 1. Seed cache file
    const key = createCacheKey("provider1", "model1", ["prompt1"], undefined);
    const seededData: LlmCacheFile = {
      toolVersion: "NaNofuzz v0.4.0",
      recordings: [
        {
          key,
          request: {
            provider: "provider1",
            modelName: "model1",
            prompt: ["prompt1"],
          },
          response: {
            text: "cached-answer",
            stats: {
              tokensSent: 5,
              tokensSentCost: { amt: 0, unit: "USD" },
              tokensReceived: 5,
              tokensReceivedCost: { amt: 0, unit: "USD" },
            },
          },
          delayMs: 30,
          recordedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(seededData), "utf-8");

    const manager = new LlmCacheManager("replay-record", cacheFile);
    let liveCalls = 0;

    // Test CACHE HIT
    const startHit = performance.now();
    const hitRes = await manager.query(
      "provider1",
      "model1",
      ["prompt1"],
      undefined,
      async () => {
        liveCalls++;
        return {
          text: "live-answer",
          stats: {
            tokensSent: 10,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 5,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
      }
    );
    const hitElapsed = performance.now() - startHit;

    expect(hitRes.text).toBe("cached-answer");
    expect(liveCalls).toBe(0);
    expect(hitElapsed).toBeGreaterThanOrEqual(20);

    // Test CACHE MISS
    const missRes = await manager.query(
      "provider1",
      "model1",
      ["prompt2-miss"],
      undefined,
      async () => {
        liveCalls++;
        return {
          text: "new-recorded-answer",
          stats: {
            tokensSent: 10,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 5,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
      }
    );

    expect(missRes.text).toBe("new-recorded-answer");
    expect(liveCalls).toBe(1);

    const stats = manager.stats;
    expect(stats.calls).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.recorded).toBe(1);
    expect(stats.replayed.calls).toBe(1);
    expect(stats.replayed.tokensSent).toBe(5);
    expect(stats.replayed.tokensReceived).toBe(5);
    expect(stats.live.calls).toBe(1);
    expect(stats.live.tokensSent).toBe(10);
    expect(stats.live.tokensReceived).toBe(5);

    // Check that cache file now contains 2 entries
    const updatedContent = JSONN.parse<LlmCacheFile>(
      fs.readFileSync(cacheFile, "utf-8")
    );
    expect(updatedContent.toolVersion).toBeDefined();
    expect(updatedContent.recordings.length).toBe(2);
  });

  it("replay-error mode: serves hits and throws on misses without calling live function", async () => {
    // Seed cache file
    const key = createCacheKey("p", "m", ["p1"], undefined);
    const seededData: LlmCacheFile = {
      toolVersion: "NaNofuzz v0.4.0",
      recordings: [
        {
          key,
          request: { provider: "p", modelName: "m", prompt: ["p1"] },
          response: {
            text: "cached-p1",
            stats: {
              tokensSent: 1,
              tokensSentCost: { amt: 0, unit: "USD" },
              tokensReceived: 1,
              tokensReceivedCost: { amt: 0, unit: "USD" },
            },
          },
          delayMs: 5,
          recordedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(seededData), "utf-8");

    const manager = new LlmCacheManager("replay-error", cacheFile);
    let liveCalls = 0;

    const dummyStats = {
      tokensSent: 0,
      tokensSentCost: { amt: 0, unit: "USD" },
      tokensReceived: 0,
      tokensReceivedCost: { amt: 0, unit: "USD" },
    };

    // Cache hit
    const res = await manager.query("p", "m", ["p1"], undefined, async () => {
      liveCalls++;
      return { text: "live", stats: dummyStats };
    });
    expect(res.text).toBe("cached-p1");
    expect(liveCalls).toBe(0);

    // Cache miss -> throws error
    await expectAsync(
      manager.query("p", "m", ["unrecorded-prompt"], undefined, async () => {
        liveCalls++;
        return { text: "live", stats: dummyStats };
      })
    ).toBeRejectedWithError(/Cache miss in 'replay-error' mode/);

    expect(liveCalls).toBe(0);

    const stats = manager.stats;
    expect(stats.calls).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.failures).toBe(1);
  });

  it("replay-passthrough mode: serves hits and passes misses live without recording", async () => {
    // Seed cache file
    const key = createCacheKey("p", "m", ["p1"], undefined);
    const seededData: LlmCacheFile = {
      toolVersion: "NaNofuzz v0.4.0",
      recordings: [
        {
          key,
          request: { provider: "p", modelName: "m", prompt: ["p1"] },
          response: {
            text: "cached-p1",
            stats: {
              tokensSent: 1,
              tokensSentCost: { amt: 0, unit: "USD" },
              tokensReceived: 1,
              tokensReceivedCost: { amt: 0, unit: "USD" },
            },
          },
          delayMs: 5,
          recordedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(seededData), "utf-8");

    const manager = new LlmCacheManager("replay-passthrough", cacheFile);
    let liveCalls = 0;

    const dummyStats = {
      tokensSent: 0,
      tokensSentCost: { amt: 0, unit: "USD" },
      tokensReceived: 0,
      tokensReceivedCost: { amt: 0, unit: "USD" },
    };

    // Cache hit
    const hitRes = await manager.query(
      "p",
      "m",
      ["p1"],
      undefined,
      async () => {
        liveCalls++;
        return { text: "live", stats: dummyStats };
      }
    );
    expect(hitRes.text).toBe("cached-p1");
    expect(liveCalls).toBe(0);

    // Cache miss -> live call executed, but NOT saved to cache file
    const missRes = await manager.query(
      "p",
      "m",
      ["unrecorded-prompt"],
      undefined,
      async () => {
        liveCalls++;
        return {
          text: "live-unrecorded",
          stats: {
            tokensSent: 2,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 2,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        };
      }
    );

    expect(missRes.text).toBe("live-unrecorded");
    expect(liveCalls).toBe(1);

    const stats = manager.stats;
    expect(stats.calls).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.passedThroughUnrecorded).toBe(1);
    expect(stats.recorded).toBe(0);
    expect(stats.replayed.calls).toBe(1);
    expect(stats.replayed.tokensSent).toBe(1);
    expect(stats.live.calls).toBe(1);
    expect(stats.live.tokensSent).toBe(2);

    // Cache file length should still be 1 (seeded format preserved)
    const content = JSONN.parse<LlmCacheFile | LlmCacheEntry[]>(
      fs.readFileSync(cacheFile, "utf-8")
    );
    const count = Array.isArray(content)
      ? content.length
      : content.recordings.length;
    expect(count).toBe(1);
  });

  it("handle rejected in-flights queries w/o throwing", async () => {
    const manager = new LlmCacheManager("passthrough", cacheFile);

    const failingQuery = manager
      .query("p", "m", ["prompt-timeout"], undefined, async () => {
        throw new Error("Request timeout after 30000ms");
      })
      .catch(() => {});

    await expectAsync(manager.flush(1000)).toBeResolved();
    await failingQuery;
  });

  it("replays with perturbed delay (0ms / instant replay)", async () => {
    const key = createCacheKey("p", "m", ["p1"], undefined);
    const seededData: LlmCacheFile = {
      toolVersion: "NaNofuzz v0.4.0",
      recordings: [
        {
          key,
          request: { provider: "p", modelName: "m", prompt: ["p1"] },
          response: {
            text: "cached-p1",
            stats: {
              tokensSent: 1,
              tokensSentCost: { amt: 0, unit: "USD" },
              tokensReceived: 1,
              tokensReceivedCost: { amt: 0, unit: "USD" },
            },
          },
          delayMs: 200,
          recordedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(seededData), "utf-8");

    // Replay with delayConfig = { fixedMs: 0 } (should bypass the 200ms recorded delay)
    const manager = new LlmCacheManager(
      "replay-error",
      cacheFile,
      LlmDelayCalculator.parse("0")
    );
    const start = performance.now();
    const res = await manager.query("p", "m", ["p1"], undefined, async () => ({
      text: "live",
      stats: {
        tokensSent: 0,
        tokensSentCost: { amt: 0, unit: "USD" },
        tokensReceived: 0,
        tokensReceivedCost: { amt: 0, unit: "USD" },
      },
    }));
    const elapsed = performance.now() - start;

    expect(res.text).toBe("cached-p1");
    expect(elapsed).toBeLessThan(100);
  });

  it("replays with perturbed delay (fixed delay and dynamic setter)", async () => {
    const key = createCacheKey("p", "m", ["p1"], undefined);
    const seededData: LlmCacheFile = {
      toolVersion: "NaNofuzz v0.4.0",
      recordings: [
        {
          key,
          request: { provider: "p", modelName: "m", prompt: ["p1"] },
          response: {
            text: "cached-p1",
            stats: {
              tokensSent: 1,
              tokensSentCost: { amt: 0, unit: "USD" },
              tokensReceived: 1,
              tokensReceivedCost: { amt: 0, unit: "USD" },
            },
          },
          delayMs: 100,
          recordedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(seededData), "utf-8");

    const manager = new LlmCacheManager(
      "replay-error",
      cacheFile,
      LlmDelayCalculator.parse("25ms")
    );
    expect(manager.delayConfig).toEqual({ fixedMs: 25 });

    const start = performance.now();
    const res = await manager.query("p", "m", ["p1"], undefined, async () => ({
      text: "live",
      stats: {
        tokensSent: 0,
        tokensSentCost: { amt: 0, unit: "USD" },
        tokensReceived: 0,
        tokensReceivedCost: { amt: 0, unit: "USD" },
      },
    }));
    const elapsed = performance.now() - start;

    expect(res.text).toBe("cached-p1");
    expect(elapsed).toBeGreaterThanOrEqual(20);

    // Update delayConfig dynamically to { fixedMs: 0 }
    manager.delayConfig = { fixedMs: 0 };
    expect(manager.delayConfig).toEqual({ fixedMs: 0 });
  });

  it("loads cache file structured with toolVersion and recordings", async () => {
    const key = createCacheKey("p", "m", ["p-header-test"], undefined);
    const headerPayload: LlmCacheFile = {
      toolVersion: "NaNofuzz v0.4.0",
      recordings: [
        {
          key,
          request: { provider: "p", modelName: "m", prompt: ["p-header-test"] },
          response: {
            text: "header-answer",
            stats: {
              tokensSent: 2,
              tokensSentCost: { amt: 0, unit: "USD" },
              tokensReceived: 2,
              tokensReceivedCost: { amt: 0, unit: "USD" },
            },
          },
          delayMs: 10,
          recordedAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(headerPayload), "utf-8");

    const manager = new LlmCacheManager("replay-error", cacheFile);
    const res = await manager.query(
      "p",
      "m",
      ["p-header-test"],
      undefined,
      async () => ({
        text: "fail",
        stats: {
          tokensSent: 0,
          tokensSentCost: { amt: 0, unit: "USD" },
          tokensReceived: 0,
          tokensReceivedCost: { amt: 0, unit: "USD" },
        },
      })
    );
    expect(res.text).toBe("header-answer");
  });

  it("saves and loads binary packed cache files (.msgpack / non-json extension)", async () => {
    const binCacheFile = path.join(tmpDir, "cache.msgpack");
    const recordManager = new LlmCacheManager("record", binCacheFile);

    const queryFn = async () => ({
      text: "bin-recorded-answer",
      stats: {
        tokensSent: 10,
        tokensSentCost: { amt: 0, unit: "USD" },
        tokensReceived: 5,
        tokensReceivedCost: { amt: 0, unit: "USD" },
      },
    });

    await recordManager.query("p", "m", ["bin-prompt"], undefined, queryFn);
    expect(fs.existsSync(binCacheFile)).toBeTrue();

    // Verify binary format: unpacks using JSONN.unpack
    const binBuffer = fs.readFileSync(binCacheFile);
    const unpacked = JSONN.unpack<LlmCacheFile>(binBuffer);
    expect(unpacked.toolVersion).toBeDefined();
    expect(unpacked.recordings.length).toBe(1);
    expect(unpacked.recordings[0].response.text).toBe("bin-recorded-answer");

    // Verify loading by replay manager
    const replayManager = new LlmCacheManager("replay-error", binCacheFile);
    const replayRes = await replayManager.query(
      "p",
      "m",
      ["bin-prompt"],
      undefined,
      async () => ({
        text: "should-not-be-called",
        stats: {
          tokensSent: 0,
          tokensSentCost: { amt: 0, unit: "USD" },
          tokensReceived: 0,
          tokensReceivedCost: { amt: 0, unit: "USD" },
        },
      })
    );
    expect(replayRes.text).toBe("bin-recorded-answer");
  });

  it("saves and loads human-readable JSONN text for .txt and .text extensions", async () => {
    const txtCacheFile = path.join(tmpDir, "cache.txt");
    const recordManager = new LlmCacheManager("record", txtCacheFile);

    await recordManager.query(
      "p",
      "m",
      ["txt-prompt"],
      undefined,
      async () => ({
        text: "txt-recorded-answer",
        stats: {
          tokensSent: 10,
          tokensSentCost: { amt: 0, unit: "USD" },
          tokensReceived: 5,
          tokensReceivedCost: { amt: 0, unit: "USD" },
        },
      })
    );
    expect(fs.existsSync(txtCacheFile)).toBeTrue();

    // Verify it is saved as text
    const rawContent = fs.readFileSync(txtCacheFile, "utf-8");
    const parsed = JSONN.parse<LlmCacheFile>(rawContent);
    expect(parsed.toolVersion).toBeDefined();
    expect(parsed.recordings.length).toBe(1);
    expect(parsed.recordings[0].response.text).toBe("txt-recorded-answer");

    // Verify replay manager loads it cleanly
    const replayManager = new LlmCacheManager("replay-error", txtCacheFile);
    const res = await replayManager.query(
      "p",
      "m",
      ["txt-prompt"],
      undefined,
      async () => ({
        text: "fail",
        stats: {
          tokensSent: 0,
          tokensSentCost: { amt: 0, unit: "USD" },
          tokensReceived: 0,
          tokensReceivedCost: { amt: 0, unit: "USD" },
        },
      })
    );
    expect(res.text).toBe("txt-recorded-answer");
  });
});
