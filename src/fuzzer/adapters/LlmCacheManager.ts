import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as JSONN from "../../Jsonn";
import {
  LlmCacheEntry,
  LlmCacheMode,
  LlmCacheStats,
  LlmQueryResult,
} from "../generators/Types";

export class LlmCacheManager {
  protected static _activeManagers = new Set<LlmCacheManager>();

  protected _mode: LlmCacheMode;
  protected _filePath?: string;
  protected _cache: Map<string, LlmCacheEntry> = new Map();
  protected _stats: LlmCacheStats;
  protected _pendingQueries: Set<Promise<unknown>> = new Set();

  constructor(mode: LlmCacheMode = "passthrough", filePath?: string) {
    this._mode = mode;
    this._filePath = filePath ? path.resolve(filePath) : undefined;
    this._stats = {
      mode,
      calls: 0,
      hits: 0,
      misses: 0,
      recorded: 0,
      passedThroughUnrecorded: 0,
      failures: 0,
      live: {
        calls: 0,
        tokensSent: 0,
        tokensReceived: 0,
        costUsd: 0,
      },
      replayed: {
        calls: 0,
        tokensSent: 0,
        tokensReceived: 0,
        costUsd: 0,
      },
    };
    this._loadCache();
    LlmCacheManager._activeManagers.add(this);
  }

  protected _loadCache(): void {
    if (this._mode === "passthrough" || !this._filePath) return;
    if (fs.existsSync(this._filePath)) {
      try {
        const raw = fs.readFileSync(this._filePath, "utf-8");
        const entries: LlmCacheEntry[] = JSONN.parse(raw);
        entries.forEach((e) => this._cache.set(e.key, e));
      } catch (err) {
        console.warn(
          `[LlmCacheManager] Failed to load cache from ${this._filePath}:`,
          err
        );
      }
    }
  }

  public saveCache(): void {
    if (!this._filePath || this._mode === "passthrough") return;
    try {
      const dir = path.dirname(this._filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = Array.from(this._cache.values());
      fs.writeFileSync(this._filePath, JSONN.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(
        `[LlmCacheManager] Failed to write cache to ${this._filePath}:`,
        err
      );
    }
  }

  public async query(
    provider: string,
    modelName: string,
    prompt: string[],
    schemaJson: string | undefined,
    liveQueryFn: () => Promise<LlmQueryResult>
  ): Promise<LlmQueryResult> {
    const queryPromise = this._executeQuery(
      provider,
      modelName,
      prompt,
      schemaJson,
      liveQueryFn
    );
    this._pendingQueries.add(queryPromise);
    try {
      return await queryPromise;
    } finally {
      this._pendingQueries.delete(queryPromise);
    }
  }

  protected async _executeQuery(
    provider: string,
    modelName: string,
    prompt: string[],
    schemaJson: string | undefined,
    liveQueryFn: () => Promise<LlmQueryResult>
  ): Promise<LlmQueryResult> {
    this._stats.calls++;

    // Passthrough
    if (this._mode === "passthrough") {
      this._stats.passedThroughUnrecorded++;
      const liveResult = await liveQueryFn();
      this._recordLiveStats(liveResult);
      return liveResult;
    }

    const key = createCacheKey(provider, modelName, prompt, schemaJson);
    const cachedEntry = this._cache.get(key);

    // Cache hit
    if (cachedEntry) {
      this._stats.hits++;
      const sentCost = cachedEntry.response.stats?.tokensSentCost?.amt ?? 0;
      const receivedCost =
        cachedEntry.response.stats?.tokensReceivedCost?.amt ?? 0;
      this._stats.replayed.calls++;
      this._stats.replayed.tokensSent +=
        cachedEntry.response.stats?.tokensSent ?? 0;
      this._stats.replayed.tokensReceived +=
        cachedEntry.response.stats?.tokensReceived ?? 0;
      this._stats.replayed.costUsd += sentCost + receivedCost;

      if (cachedEntry.delayMs > 0) {
        await new Promise((r) => setTimeout(r, cachedEntry.delayMs));
      }
      return {
        text: cachedEntry.response.text,
        stats: cachedEntry.response.stats,
      };
    }

    // Cache miss
    this._stats.misses++;

    if (this._mode === "replay-error") {
      this._stats.failures++;
      throw new Error(
        `LLM Cache miss in 'replay-error' mode for query key: ${key}`
      );
    }

    if (this._mode === "replay-passthrough") {
      this._stats.passedThroughUnrecorded++;
      const liveResult = await liveQueryFn();
      this._recordLiveStats(liveResult);
      return liveResult;
    }

    // Mode is "record" or "replay-record"
    const start = performance.now();
    const liveResult = await liveQueryFn();
    const delayMs = Math.round(performance.now() - start);

    this._recordLiveStats(liveResult);
    this._stats.recorded++;
    this._cache.set(key, {
      key,
      request: { provider, modelName, prompt, schemaJson },
      response: { text: liveResult.text, stats: liveResult.stats },
      delayMs,
      recordedAt: new Date().toISOString(),
    });
    this.saveCache();

    return liveResult;
  }

  private _recordLiveStats(liveResult: LlmQueryResult): void {
    const sentCost = liveResult.stats?.tokensSentCost?.amt ?? 0;
    const receivedCost = liveResult.stats?.tokensReceivedCost?.amt ?? 0;
    this._stats.live.calls++;
    this._stats.live.tokensSent += liveResult.stats?.tokensSent ?? 0;
    this._stats.live.tokensReceived += liveResult.stats?.tokensReceived ?? 0;
    this._stats.live.costUsd += sentCost + receivedCost;
  }

  public async flush(timeoutMs = 5000): Promise<void> {
    this.saveCache();
    if (this._pendingQueries.size === 0) return;

    const timeoutPromise = new Promise((r) => setTimeout(r, timeoutMs));
    await Promise.race([
      Promise.all(Array.from(this._pendingQueries)),
      timeoutPromise,
    ]);
    this.saveCache();
  }

  public static readonly inFlight = {
    get length(): number {
      let len = 0;
      for (const manager of LlmCacheManager._activeManagers) {
        len += manager._pendingQueries.size;
      }
      return len;
    },
  };

  public static async flushAllActive(timeoutMs = 5000): Promise<void> {
    for (const manager of LlmCacheManager._activeManagers) {
      await manager.flush(timeoutMs);
    }
  }

  public get stats(): LlmCacheStats {
    return { ...this._stats };
  }

  public get mode(): LlmCacheMode {
    return this._mode;
  }
}

export function createCacheKey(
  provider: string,
  modelName: string,
  prompt: string[],
  schemaJson?: string
): string {
  const payload = JSON.stringify({ provider, modelName, prompt, schemaJson });
  return crypto.createHash("sha256").update(payload).digest("hex");
}
