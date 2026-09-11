import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LlmCacheManager, createCacheKey } from "./LlmCacheManager";
import { LlmCacheEntry } from "../generators/Types";
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const content = JSONN.parse<LlmCacheEntry[]>(
      fs.readFileSync(cacheFile, "utf-8")
    );
    expect(content.length).toBe(1);
    expect(content[0].response.text).toBe("recorded-answer");
    expect(content[0].delayMs).toBeGreaterThanOrEqual(15);
  });

  it("replay-record mode: serves hits from cache with delay and records misses", async () => {
    // 1. Seed cache file
    const key = createCacheKey("provider1", "model1", ["prompt1"], undefined);
    const seededData = [
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
    ];
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
    const updatedContent = JSONN.parse<LlmCacheEntry[]>(
      fs.readFileSync(cacheFile, "utf-8")
    );
    expect(updatedContent.length).toBe(2);
  });

  it("replay-error mode: serves hits and throws on misses without calling live function", async () => {
    // Seed cache file
    const key = createCacheKey("p", "m", ["p1"], undefined);
    const seededData = [
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
    ];
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
    const seededData = [
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
    ];
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

    // Cache file length should still be 1
    const content = JSONN.parse<LlmCacheEntry[]>(
      fs.readFileSync(cacheFile, "utf-8")
    );
    expect(content.length).toBe(1);
  });
});
