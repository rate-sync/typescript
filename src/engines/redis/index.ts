import { createClient, type RedisClientType } from 'redis';
import { TOKEN_BUCKET_SCRIPT, SLIDING_WINDOW_SCRIPT, RELEASE_SCRIPT } from './scripts.js';
import type { RateLimitStore, AcquireConfig, AcquireResult } from '../base.js';
import type { LimiterState } from '../../core/schemas.js';

/**
 * Connection options for RedisStore.
 *
 * Passed to the constructor to configure the underlying node-redis client.
 */
export interface RedisStoreOptions {
  url: string;
  db?: number;
  password?: string;
  /** Key prefix for all rate-limit keys. Default: `rate_limit` */
  keyPrefix?: string;
  /** Socket timeout in ms. Default: 5000 */
  socketTimeout?: number;
}

/**
 * Redis-backed rate limiting store for distributed deployments.
 *
 * Uses atomic Lua scripts for token bucket and sliding window algorithms,
 * ensuring correctness under concurrent access from multiple processes
 * or containers. Requires node-redis v4+ as a peer dependency and
 * Redis 5.0+ for Lua script support.
 *
 * Call initialize() before first use and close() on shutdown to release
 * the Redis connection.
 *
 * @example
 * ```typescript
 * const store = new RedisStore({ url: 'redis://localhost:6379' });
 * await store.initialize();
 * const result = await store.acquire('user:123', {
 *   algorithm: 'sliding-window',
 *   limit: 100,
 *   windowSeconds: 60,
 * });
 * ```
 */
export class RedisStore implements RateLimitStore {
  private client: RedisClientType | null = null;
  private readonly url: string;
  private readonly keyPrefix: string;
  private readonly socketTimeout: number;
  private readonly db?: number;
  private readonly password?: string;

  constructor(options: RedisStoreOptions) {
    this.url = options.url;
    this.keyPrefix = options.keyPrefix ?? 'rate_limit';
    this.socketTimeout = options.socketTimeout ?? 5000;
    this.db = options.db;
    this.password = options.password;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.client) return;

    this.client = createClient({
      url: this.url,
      password: this.password,
      database: this.db,
      socket: {
        connectTimeout: this.socketTimeout,
        reconnectStrategy: false, // fail fast — no reconnect
      },
    }) as RedisClientType;

    await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  async acquire(key: string, config: AcquireConfig): Promise<AcquireResult> {
    const client = this._getClient();
    const now = Date.now() / 1000; // seconds (float)

    if (config.algorithm === 'token-bucket') {
      return this._acquireTokenBucket(client, key, config, now);
    }
    return this._acquireSlidingWindow(client, key, config, now);
  }

  async release(key: string): Promise<void> {
    const client = this._getClient();
    const concurrentKey = this._concurrentKey(key);

    await client.sendCommand([
      'EVAL',
      RELEASE_SCRIPT,
      '1',
      concurrentKey,
    ]);
  }

  async getState(key: string, config: AcquireConfig): Promise<LimiterState> {
    const client = this._getClient();
    const now = Date.now() / 1000;

    if (config.algorithm === 'token-bucket') {
      return this._getTokenBucketState(client, key, config, now);
    }
    return this._getSlidingWindowState(client, key, config, now);
  }

  async reset(key: string): Promise<void> {
    const client = this._getClient();
    const pattern = `${this.keyPrefix}:${key}:*`;

    // Use SCAN to avoid blocking the server with KEYS in production
    let cursor = 0;
    const keysToDelete: string[] = [];

    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      keysToDelete.push(...result.keys);
    } while (cursor !== 0);

    if (keysToDelete.length > 0) {
      await client.del(keysToDelete);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Token Bucket
  // ---------------------------------------------------------------------------

  private async _acquireTokenBucket(
    client: RedisClientType,
    key: string,
    config: AcquireConfig,
    now: number,
  ): Promise<AcquireResult> {
    const ratePerSecond = config.ratePerSecond ?? 1;
    const interval = 1 / ratePerSecond; // seconds between allowed requests
    const maxConcurrent = config.maxConcurrent ?? 0;
    // TTL: at least the interval, minimum 2s
    const ttl = Math.max(2, Math.ceil(interval) + 1);

    const rateKey = this._rateKey(key);
    const concurrentKey = this._concurrentKey(key);

    const result = await client.sendCommand([
      'EVAL',
      TOKEN_BUCKET_SCRIPT,
      '2',
      rateKey,
      concurrentKey,
      now.toString(),
      interval.toString(),
      maxConcurrent.toString(),
      ttl.toString(),
    ]);

    if (!Array.isArray(result)) {
      throw new Error(`Unexpected Redis script result: ${typeof result}`);
    }
    return this._parseResult(result as unknown[]);
  }

  private async _getTokenBucketState(
    client: RedisClientType,
    key: string,
    config: AcquireConfig,
    now: number,
  ): Promise<LimiterState> {
    const ratePerSecond = config.ratePerSecond ?? 1;
    const interval = 1 / ratePerSecond;

    const rateKey = this._rateKey(key);
    const lastTimeStr = await client.get(rateKey);

    if (lastTimeStr === null) {
      // No record — next request will succeed
      return {
        allowed: true,
        remaining: 1,
        resetAt: Math.floor(now + interval),
        currentUsage: 0,
      };
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

  // ---------------------------------------------------------------------------
  // Private: Sliding Window
  // ---------------------------------------------------------------------------

  private async _acquireSlidingWindow(
    client: RedisClientType,
    key: string,
    config: AcquireConfig,
    now: number,
  ): Promise<AcquireResult> {
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;
    const maxConcurrent = config.maxConcurrent ?? 0;
    const ttl = Math.ceil(windowSeconds) + 1;

    const windowKey = this._windowKey(key);
    const concurrentKey = this._concurrentKey(key);

    const result = await client.sendCommand([
      'EVAL',
      SLIDING_WINDOW_SCRIPT,
      '2',
      windowKey,
      concurrentKey,
      now.toString(),
      limit.toString(),
      windowSeconds.toString(),
      maxConcurrent.toString(),
      ttl.toString(),
    ]);

    if (!Array.isArray(result)) {
      throw new Error(`Unexpected Redis script result: ${typeof result}`);
    }
    return this._parseResult(result as unknown[]);
  }

  private async _getSlidingWindowState(
    client: RedisClientType,
    key: string,
    config: AcquireConfig,
    now: number,
  ): Promise<LimiterState> {
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;

    const windowKey = this._windowKey(key);
    const cutoff = now - windowSeconds;

    // Remove expired entries then count active ones (read-only perspective)
    await client.zRemRangeByScore(windowKey, '-inf', cutoff);
    const currentUsage = await client.zCard(windowKey);

    const remaining = Math.max(0, limit - currentUsage);
    const allowed = currentUsage < limit;

    // Find oldest active entry to determine resetAt (ascending = oldest first)
    const oldest = await client.zRange(windowKey, 0, 0);
    const oldestScore =
      oldest.length > 0
        ? await client.zScore(windowKey, oldest[0]!)
        : null;

    const resetAt =
      oldestScore !== null
        ? Math.floor(oldestScore + windowSeconds)
        : Math.floor(now + windowSeconds);

    return {
      allowed,
      remaining,
      resetAt,
      currentUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Helpers
  // ---------------------------------------------------------------------------

  private _getClient(): RedisClientType {
    if (!this.client) {
      throw new Error('RedisStore not initialized. Call initialize() first.');
    }
    return this.client;
  }

  private _rateKey(key: string): string {
    return `${this.keyPrefix}:${key}:rate`;
  }

  private _windowKey(key: string): string {
    return `${this.keyPrefix}:${key}:window`;
  }

  private _concurrentKey(key: string): string {
    return `${this.keyPrefix}:${key}:concurrent`;
  }

  /**
   * Parse the Lua script result array.
   * Token bucket: [success, waitMs, concurrentCount]
   * Sliding window: [success, waitMs, concurrentCount, currentCount]
   */
  private _parseResult(result: unknown[]): AcquireResult {
    const success = Number(result[0]) === 1;
    const waitMs = Number(result[1]);
    const concurrentCount = result[2] !== undefined ? Number(result[2]) : undefined;
    const currentCount = result[3] !== undefined ? Number(result[3]) : undefined;

    return {
      success,
      waitMs: waitMs < 0 ? 0 : waitMs,
      concurrentCount: concurrentCount !== undefined && concurrentCount >= 0 ? concurrentCount : undefined,
      currentCount,
    };
  }
}
