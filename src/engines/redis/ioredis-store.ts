import type Redis from 'ioredis';
import { TOKEN_BUCKET_SCRIPT, SLIDING_WINDOW_SCRIPT, RELEASE_SCRIPT } from './scripts.js';
import type { RateLimitStore, AcquireConfig, AcquireResult } from '../base.js';
import type { LimiterState } from '../../core/schemas.js';

/**
 * Connection options for {@link IORedisStore}.
 *
 * Either pass an existing `ioredis` client (`client`) or supply a `url` —
 * the store will then construct its own client lazily on `initialize()`.
 * Reusing an existing client is preferred when the host application already
 * keeps a Redis connection open (avoids doubling connections).
 */
export interface IORedisStoreOptions {
  /**
   * Pre-configured `ioredis` client. The store will not own its lifecycle —
   * `close()` becomes a no-op when this is provided.
   */
  client?: Redis;
  /**
   * Redis connection URL. Used only when `client` is not provided.
   */
  url?: string;
  /** Key prefix for all rate-limit keys. Default: `rate_limit` */
  keyPrefix?: string;
}

type CommandRunner = {
  rsTokenBucket(...args: (string | number)[]): Promise<unknown>;
  rsSlidingWindow(...args: (string | number)[]): Promise<unknown>;
  rsRelease(...args: (string | number)[]): Promise<unknown>;
};

/**
 * Rate-limit store backed by `ioredis`.
 *
 * Mirrors the node-redis `RedisStore` but uses `ioredis` so applications
 * that already depend on it (e.g. Next.js apps storing webhook payloads)
 * do not need a second Redis client just for rate limiting. The same
 * atomic Lua scripts are used, so behaviour is byte-identical to the
 * node-redis variant.
 *
 * Pass an existing `ioredis` instance via `options.client` to share the
 * connection pool; otherwise supply `url` and the store will create and
 * own a new client.
 */
export class IORedisStore implements RateLimitStore {
  private client: Redis | null;
  private readonly url: string | null;
  private readonly keyPrefix: string;
  private readonly ownsClient: boolean;
  private commandsRegistered = false;

  constructor(options: IORedisStoreOptions = {}) {
    if (!options.client && !options.url) {
      throw new Error('IORedisStore requires either `client` or `url`.');
    }
    this.client = options.client ?? null;
    this.url = options.url ?? null;
    this.keyPrefix = options.keyPrefix ?? 'rate_limit';
    this.ownsClient = !options.client;
  }

  async initialize(): Promise<void> {
    if (!this.client) {
      if (!this.url) throw new Error('IORedisStore: missing url.');
      // Lazy import keeps `ioredis` an optional peer dependency.
      const { default: IORedis } = await import('ioredis');
      this.client = new IORedis(this.url, { maxRetriesPerRequest: 3, lazyConnect: true });
      await this.client.connect();
    }
    this.registerCommands();
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client) {
      await this.client.quit();
      this.client = null;
      this.commandsRegistered = false;
      return;
    }
    // Externally-owned client: leave it untouched so the host application
    // can keep using it. The store stays usable as well — the registered
    // commands live on the client, not on this instance.
  }

  async acquire(key: string, config: AcquireConfig): Promise<AcquireResult> {
    const client = this.requireClient();
    const now = Date.now() / 1000;
    if (config.algorithm === 'token-bucket') {
      const ratePerSecond = config.ratePerSecond ?? 1;
      const interval = 1 / ratePerSecond;
      const maxConcurrent = config.maxConcurrent ?? 0;
      const ttl = Math.max(2, Math.ceil(interval) + 1);
      const raw = await client.rsTokenBucket(
        this.rateKey(key),
        this.concurrentKey(key),
        now.toString(),
        interval.toString(),
        maxConcurrent.toString(),
        ttl.toString(),
      );
      return this.parseResult(raw as unknown[]);
    }
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;
    const maxConcurrent = config.maxConcurrent ?? 0;
    const ttl = Math.ceil(windowSeconds) + 1;
    const raw = await client.rsSlidingWindow(
      this.windowKey(key),
      this.concurrentKey(key),
      now.toString(),
      limit.toString(),
      windowSeconds.toString(),
      maxConcurrent.toString(),
      ttl.toString(),
    );
    return this.parseResult(raw as unknown[]);
  }

  async release(key: string): Promise<void> {
    const client = this.requireClient();
    await client.rsRelease(this.concurrentKey(key));
  }

  async getState(key: string, config: AcquireConfig): Promise<LimiterState> {
    const client = this.requireClient();
    const now = Date.now() / 1000;
    if (config.algorithm === 'token-bucket') {
      const ratePerSecond = config.ratePerSecond ?? 1;
      const interval = 1 / ratePerSecond;
      const lastTimeStr = await client.get(this.rateKey(key));
      if (lastTimeStr === null) {
        return { allowed: true, remaining: 1, resetAt: Math.floor(now + interval), currentUsage: 0 };
      }
      const lastTime = parseFloat(lastTimeStr);
      const elapsed = now - lastTime;
      const allowed = elapsed >= interval;
      return {
        allowed,
        remaining: allowed ? 1 : 0,
        resetAt: Math.floor(lastTime + interval),
        currentUsage: allowed ? 0 : 1,
      };
    }
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;
    const windowKey = this.windowKey(key);
    const cutoff = now - windowSeconds;
    await client.zremrangebyscore(windowKey, '-inf', cutoff);
    const currentUsage = await client.zcard(windowKey);
    const oldest = await client.zrange(windowKey, 0, 0);
    const oldestScore =
      oldest.length > 0 ? await client.zscore(windowKey, oldest[0]!) : null;
    const oldestSeconds = oldestScore !== null ? parseFloat(oldestScore) : null;
    const resetAt =
      oldestSeconds !== null
        ? Math.floor(oldestSeconds + windowSeconds)
        : Math.floor(now + windowSeconds);
    return {
      allowed: currentUsage < limit,
      remaining: Math.max(0, limit - currentUsage),
      resetAt,
      currentUsage,
    };
  }

  async reset(key: string): Promise<void> {
    const client = this.requireClient();
    const pattern = `${this.keyPrefix}:${key}:*`;
    let cursor = '0';
    const keysToDelete: string[] = [];
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      keysToDelete.push(...batch);
    } while (cursor !== '0');
    if (keysToDelete.length > 0) {
      await client.del(...keysToDelete);
    }
  }

  private requireClient(): Redis & CommandRunner {
    if (!this.client) {
      throw new Error('IORedisStore not initialized. Call initialize() first.');
    }
    return this.client as Redis & CommandRunner;
  }

  private registerCommands(): void {
    if (this.commandsRegistered || !this.client) return;
    this.client.defineCommand('rsTokenBucket', { numberOfKeys: 2, lua: TOKEN_BUCKET_SCRIPT });
    this.client.defineCommand('rsSlidingWindow', { numberOfKeys: 2, lua: SLIDING_WINDOW_SCRIPT });
    this.client.defineCommand('rsRelease', { numberOfKeys: 1, lua: RELEASE_SCRIPT });
    this.commandsRegistered = true;
  }

  private rateKey(key: string): string {
    return `${this.keyPrefix}:${key}:rate`;
  }

  private windowKey(key: string): string {
    return `${this.keyPrefix}:${key}:window`;
  }

  private concurrentKey(key: string): string {
    return `${this.keyPrefix}:${key}:concurrent`;
  }

  private parseResult(result: unknown[]): AcquireResult {
    const success = Number(result[0]) === 1;
    const waitMs = Number(result[1]);
    const concurrentCount = result[2] !== undefined ? Number(result[2]) : undefined;
    const currentCount = result[3] !== undefined ? Number(result[3]) : undefined;
    return {
      success,
      waitMs: waitMs < 0 ? 0 : waitMs,
      concurrentCount:
        concurrentCount !== undefined && concurrentCount >= 0 ? concurrentCount : undefined,
      currentCount,
    };
  }
}
