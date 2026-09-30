import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import seedrandom from "seedrandom";
import { LlmCacheManager, createCacheKey } from "./LlmCacheManager";
import { LlmDelayCalculator } from "./LlmDelayCalculator";
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
        delayMs: 200,
        recordedAt: new Date().toISOString(),
      },
    ];
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
        delayMs: 100,
        recordedAt: new Date().toISOString(),
      },
    ];
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

  it("uses provided prng for deterministic stochastic delay perturbations", () => {
    const manager1 = new LlmCacheManager(
      "replay-error",
      cacheFile,
      LlmDelayCalculator.parse("~20%"),
      seedrandom("test-seed-123")
    );
    const manager2 = new LlmCacheManager(
      "replay-error",
      cacheFile,
      LlmDelayCalculator.parse("~20%"),
      seedrandom("test-seed-123")
    );

    const val1 = manager1.prng();
    const val2 = manager2.prng();

    expect(val1).toBe(val2);
  });

  it("does not convert undefined seed to literal 'undefined' string", () => {
    // When no prng is passed, seedrandom() should autoseed with entropy rather than using seedrandom("undefined")
    const literalUndefinedPrng = seedrandom("undefined");
    const expectedLiteralUndefinedVal = literalUndefinedPrng();

    // The autoseeded prng should not be locked to the literal "undefined" sequence
    const sampleVals: number[] = [];
    for (let i = 0; i < 5; i++) {
      const m = new LlmCacheManager("replay-error", cacheFile);
      sampleVals.push(m.prng());
    }

    // At least some samples should differ from seedrandom("undefined")
    const matchesLiteral = sampleVals.filter(
      (v) => v === expectedLiteralUndefinedVal
    ).length;
    expect(matchesLiteral).toBeLessThan(sampleVals.length);
  });

  it("replays correctly under various delay perturbation rules", async () => {
    const delayTestCases = [
      { id: "instant (0)", spec: "0", baseDelay: 80, min: 0, max: 25 },
      {
        id: "fixed constant (25ms)",
        spec: "25ms",
        baseDelay: 80,
        min: 20,
        max: 55,
      },
      {
        id: "scale speedup (0.5x)",
        spec: "0.5x",
        baseDelay: 50,
        min: 20,
        max: 55,
      },
      {
        id: "scale slowdown (2x)",
        spec: "2x",
        baseDelay: 15,
        min: 25,
        max: 60,
      },
      {
        id: "positive offset (+15ms)",
        spec: "+15ms",
        baseDelay: 10,
        min: 20,
        max: 55,
      },
      {
        id: "negative offset floor (-100ms)",
        spec: "-100ms",
        baseDelay: 30,
        min: 0,
        max: 25,
      },
      {
        id: "clamp upper bound ([20..40ms])",
        spec: "[20..40ms]",
        baseDelay: 90,
        min: 35,
        max: 70,
      },
      {
        id: "clamp lower bound ([20..40ms])",
        spec: "[20..40ms]",
        baseDelay: 5,
        min: 18,
        max: 50,
      },
      {
        id: "window range (20..35ms)",
        spec: "20..35ms",
        baseDelay: 100,
        min: 18,
        max: 65,
      },
      {
        id: "percentage jitter (~20%)",
        spec: "~20%",
        baseDelay: 30,
        min: 20,
        max: 65,
      },
      {
        id: "absolute jitter (~10ms)",
        spec: "~10ms",
        baseDelay: 30,
        min: 18,
        max: 70,
      },
      {
        id: "composition: scale + offset + clamp",
        spec: "0.5x +10ms [20..45ms]",
        baseDelay: 50,
        min: 30,
        max: 65,
      },
      {
        id: "composition: scale + jitter + clamp",
        spec: "0.5x ~20% [15..40ms]",
        baseDelay: 40,
        min: 14,
        max: 65,
      },
      {
        id: "composition: fixed + offset + jitter",
        spec: "25ms +10ms ~5ms",
        baseDelay: 100,
        min: 25,
        max: 65,
      },
    ];

    for (const { spec, baseDelay, min, max } of delayTestCases) {
      const key = createCacheKey("provider1", "model1", ["prompt1"], undefined);
      const seededEntries: LlmCacheEntry[] = [
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
          delayMs: baseDelay,
          recordedAt: new Date().toISOString(),
        },
      ];
      fs.writeFileSync(cacheFile, JSON.stringify(seededEntries), "utf-8");

      const manager = new LlmCacheManager(
        "replay-error",
        cacheFile,
        LlmDelayCalculator.parse(spec),
        seedrandom("delay-ci-seed")
      );

      const start = performance.now();
      const res = await manager.query(
        "provider1",
        "model1",
        ["prompt1"],
        undefined,
        async () => ({
          text: "live-should-not-run",
          stats: {
            tokensSent: 0,
            tokensSentCost: { amt: 0, unit: "USD" },
            tokensReceived: 0,
            tokensReceivedCost: { amt: 0, unit: "USD" },
          },
        })
      );
      const elapsed = performance.now() - start;

      expect(res.text).toBe("cached-answer");
      expect(elapsed).toBeGreaterThanOrEqual(min);
      expect(elapsed).toBeLessThanOrEqual(max);
    }
  });

  it("replays multi-turn queries sequentially with independent delays", async () => {
    const requests = [
      {
        prompt: "turn-1",
        delay: 60,
        sent: 10,
        recv: 20,
        cost: 0.001,
        ans: "a1",
      },
      {
        prompt: "turn-2",
        delay: 20,
        sent: 15,
        recv: 25,
        cost: 0.002,
        ans: "a2",
      },
      {
        prompt: "turn-3",
        delay: 80,
        sent: 20,
        recv: 30,
        cost: 0.003,
        ans: "a3",
      },
    ];

    const seededEntries: LlmCacheEntry[] = requests.map((req) => ({
      key: createCacheKey("provider1", "model1", [req.prompt], undefined),
      request: {
        provider: "provider1",
        modelName: "model1",
        prompt: [req.prompt],
      },
      response: {
        text: req.ans,
        stats: {
          tokensSent: req.sent,
          tokensSentCost: { amt: req.cost / 2, unit: "USD" },
          tokensReceived: req.recv,
          tokensReceivedCost: { amt: req.cost / 2, unit: "USD" },
        },
      },
      delayMs: req.delay,
      recordedAt: new Date().toISOString(),
    }));

    fs.writeFileSync(cacheFile, JSON.stringify(seededEntries), "utf-8");

    // Scale delay by 0.5x: expected delays are 30ms, 10ms, 40ms
    const manager = new LlmCacheManager(
      "replay-error",
      cacheFile,
      LlmDelayCalculator.parse("0.5x"),
      seedrandom("multi-turn-seed")
    );

    const dummyLiveFn = async () => ({
      text: "live-should-not-run",
      stats: {
        tokensSent: 0,
        tokensSentCost: { amt: 0, unit: "USD" },
        tokensReceived: 0,
        tokensReceivedCost: { amt: 0, unit: "USD" },
      },
    });

    // Query 1 (expected ~30ms)
    const start1 = performance.now();
    const res1 = await manager.query(
      "provider1",
      "model1",
      ["turn-1"],
      undefined,
      dummyLiveFn
    );
    const elapsed1 = performance.now() - start1;
    expect(res1.text).toBe("a1");
    expect(elapsed1).toBeGreaterThanOrEqual(25);
    expect(elapsed1).toBeLessThanOrEqual(60);

    // Query 2 (expected ~10ms)
    const start2 = performance.now();
    const res2 = await manager.query(
      "provider1",
      "model1",
      ["turn-2"],
      undefined,
      dummyLiveFn
    );
    const elapsed2 = performance.now() - start2;
    expect(res2.text).toBe("a2");
    expect(elapsed2).toBeGreaterThanOrEqual(8);
    expect(elapsed2).toBeLessThanOrEqual(40);

    // Query 3 (expected ~40ms)
    const start3 = performance.now();
    const res3 = await manager.query(
      "provider1",
      "model1",
      ["turn-3"],
      undefined,
      dummyLiveFn
    );
    const elapsed3 = performance.now() - start3;
    expect(res3.text).toBe("a3");
    expect(elapsed3).toBeGreaterThanOrEqual(35);
    expect(elapsed3).toBeLessThanOrEqual(70);

    // Check cumulative replay statistics
    const stats = manager.stats;
    expect(stats.calls).toBe(3);
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(0);
    expect(stats.failures).toBe(0);
    expect(stats.replayed.calls).toBe(3);
    expect(stats.replayed.tokensSent).toBe(10 + 15 + 20);
    expect(stats.replayed.tokensReceived).toBe(20 + 25 + 30);
    expect(stats.replayed.costUsd).toBeCloseTo(0.001 + 0.002 + 0.003, 5);
  });
});
