import { intervalSeconds } from '../base.js';
import type { AcquireConfig, AcquireResult, RateLimitStore } from '../base.js';
import type { LimiterState } from '../../core/schemas.js';

// ---------------------------------------------------------------------------
// Internal state shapes
// ---------------------------------------------------------------------------

interface TokenBucketState {
  lastTimestamp: number; // seconds (Date.now() / 1000)
}

interface SlidingWindowState {
  timestamps: number[]; // seconds (Date.now() / 1000)
}

type KeyState = TokenBucketState | SlidingWindowState;

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/**
 * In-memory rate limiting store for single-process applications.
 *
 * Supports token bucket and sliding window algorithms with on-demand
 * cleanup of expired entries. State is held entirely in process memory,
 * so it is not suitable for distributed deployments — use RedisStore
 * instead when running multiple processes or containers.
 *
 * @example
 * ```typescript
 * const store = new MemoryStore();
 * await store.initialize();
 * const result = await store.acquire('user:123', {
 *   algorithm: 'token-bucket',
 *   ratePerSecond: 10,
 * });
 * ```
 */
export class MemoryStore implements RateLimitStore {
  private tokenBuckets = new Map<string, TokenBucketState>();
  private slidingWindows = new Map<string, SlidingWindowState>();
  /** In-flight slots per key, for `maxConcurrent` (released with `release()`). */
  private concurrent = new Map<string, number>();

  // ---- Lifecycle -----------------------------------------------------------

  async initialize(): Promise<void> {
    // Nothing to set up for in-memory store
  }

  async close(): Promise<void> {
    this.tokenBuckets.clear();
    this.slidingWindows.clear();
    this.concurrent.clear();
  }

  // ---- Core operations -----------------------------------------------------

  async acquire(key: string, config: AcquireConfig): Promise<AcquireResult> {
    const maxConcurrent = config.maxConcurrent ?? 0;
    const concurrent = this.concurrent.get(key) ?? 0;

    if (maxConcurrent > 0 && concurrent >= maxConcurrent) {
      // Every slot is taken. Nothing is recorded. As in the Redis script, a rate wait wins over a
      // concurrency refusal; a pure concurrency refusal has waitMs 0 (the caller has to wait for
      // a release, there is no time to wait for).
      return { success: false, waitMs: this._rateWaitMs(key, config), concurrentCount: concurrent };
    }

    const result =
      config.algorithm === 'token-bucket'
        ? this._acquireTokenBucket(key, config)
        : this._acquireSlidingWindow(key, config);

    if (result.success && maxConcurrent > 0) {
      const count = (this.concurrent.get(key) ?? 0) + 1;
      this.concurrent.set(key, count);
      return { ...result, concurrentCount: count };
    }
    return result;
  }

  /** Free one concurrency slot of `key` (a no-op when none is held). */
  async release(key: string): Promise<void> {
    const count = this.concurrent.get(key) ?? 0;
    if (count <= 1) {
      this.concurrent.delete(key);
    } else {
      this.concurrent.set(key, count - 1);
    }
  }

  async getState(key: string, config: AcquireConfig): Promise<LimiterState> {
    const now = Date.now() / 1000;

    if (config.algorithm === 'token-bucket') {
      return this._getTokenBucketState(key, config, now);
    }
    return this._getSlidingWindowState(key, config, now);
  }

  async reset(key: string): Promise<void> {
    this.tokenBuckets.delete(key);
    this.slidingWindows.delete(key);
  }

  /** Milliseconds until the rate (or window) gate would admit `key`; 0 if it would now. Read-only. */
  private _rateWaitMs(key: string, config: AcquireConfig): number {
    const now = Date.now() / 1000;
    if (config.algorithm === 'token-bucket') {
      const interval = intervalSeconds(config.ratePerSecond);
      const state = this.tokenBuckets.get(key);
      if (interval === 0 || state === undefined) return 0;
      const elapsed = now - state.lastTimestamp;
      return elapsed < interval ? Math.ceil((interval - elapsed) * 1000) : 0;
    }
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;
    if (limit <= 0 || windowSeconds <= 0) return 0;
    const active = (this.slidingWindows.get(key)?.timestamps ?? []).filter((ts) => ts > now - windowSeconds);
    if (active.length < limit) return 0;
    return Math.max(1, Math.ceil((active[0]! + windowSeconds - now) * 1000));
  }

  // ---- Token Bucket --------------------------------------------------------

  private _acquireTokenBucket(key: string, config: AcquireConfig): AcquireResult {
    const interval = intervalSeconds(config.ratePerSecond); // seconds between allowed requests

    // No ratePerSecond (a concurrency-only limiter) or a zero or negative rate: no rate gate
    if (interval === 0) {
      return { success: true, waitMs: 0 };
    }

    const now = Date.now() / 1000;

    const state = this.tokenBuckets.get(key);

    if (state !== undefined) {
      const elapsed = now - state.lastTimestamp;
      if (elapsed < interval) {
        const waitSeconds = interval - elapsed;
        const waitMs = Math.ceil(waitSeconds * 1000);
        return { success: false, waitMs };
      }
    }

    // Allow the request — update last timestamp
    this.tokenBuckets.set(key, { lastTimestamp: now });
    return { success: true, waitMs: 0 };
  }

  private _getTokenBucketState(key: string, config: AcquireConfig, now: number): LimiterState {
    const interval = intervalSeconds(config.ratePerSecond);
    const maxConcurrent = config.maxConcurrent ?? 0;
    const state = this.tokenBuckets.get(key);

    let allowed = true;
    let resetAt = Math.floor(now + (interval > 0 ? interval : 1));
    if (interval > 0 && state !== undefined) {
      allowed = now - state.lastTimestamp >= interval;
      resetAt = Math.floor(state.lastTimestamp + interval);
    }

    let remaining = allowed ? 1 : 0;
    let currentUsage = allowed ? 0 : 1;
    if (maxConcurrent > 0) {
      const concurrent = this.concurrent.get(key) ?? 0;
      if (concurrent >= maxConcurrent) allowed = false;
      remaining = Math.max(0, interval > 0 ? Math.min(remaining, maxConcurrent - concurrent) : maxConcurrent - concurrent);
      currentUsage = Math.max(currentUsage, concurrent);
    }

    return { allowed, remaining, resetAt, currentUsage };
  }

  // ---- Sliding Window ------------------------------------------------------

  private _acquireSlidingWindow(key: string, config: AcquireConfig): AcquireResult {
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;

    // Guard: invalid config (zero or negative values) — allow all
    if (limit <= 0 || windowSeconds <= 0) {
      return { success: true, waitMs: 0 };
    }

    const now = Date.now() / 1000;
    const cutoff = now - windowSeconds;

    let state = this.slidingWindows.get(key);
    if (state === undefined) {
      state = { timestamps: [] };
      this.slidingWindows.set(key, state);
    }

    // Prune expired entries (on-demand cleanup — no setInterval)
    // Only allocate new array if there are entries to prune
    if (state.timestamps.length > 0 && state.timestamps[0] <= cutoff) {
      state.timestamps = state.timestamps.filter((ts) => ts > cutoff);
    }

    const count = state.timestamps.length;

    if (count >= limit) {
      // Oldest timestamp determines when a slot opens up
      const oldest = state.timestamps[0]!;
      const waitSeconds = oldest + windowSeconds - now;
      const waitMs = Math.max(1, Math.ceil(waitSeconds * 1000));
      return { success: false, waitMs, currentCount: count };
    }

    // Allow — record this timestamp
    state.timestamps.push(now);
    return { success: true, waitMs: 0, currentCount: count + 1 };
  }

  private _getSlidingWindowState(
    key: string,
    config: AcquireConfig,
    now: number,
  ): LimiterState {
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;
    const cutoff = now - windowSeconds;

    const state = this.slidingWindows.get(key);
    const activeTimestamps = state
      ? state.timestamps.filter((ts) => ts > cutoff)
      : [];

    const currentUsage = activeTimestamps.length;
    const remaining = Math.max(0, limit - currentUsage);
    const allowed = currentUsage < limit;

    // resetAt: when the oldest entry expires (or now + window if no entries)
    const resetAt =
      activeTimestamps.length > 0
        ? Math.floor(activeTimestamps[0]! + windowSeconds)
        : Math.floor(now + windowSeconds);

    return {
      allowed,
      remaining,
      resetAt,
      currentUsage,
    };
  }
}
