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

export class MemoryStore implements RateLimitStore {
  private tokenBuckets = new Map<string, TokenBucketState>();
  private slidingWindows = new Map<string, SlidingWindowState>();

  // ---- Lifecycle -----------------------------------------------------------

  async initialize(): Promise<void> {
    // Nothing to set up for in-memory store
  }

  async close(): Promise<void> {
    this.tokenBuckets.clear();
    this.slidingWindows.clear();
  }

  // ---- Core operations -----------------------------------------------------

  async acquire(key: string, config: AcquireConfig): Promise<AcquireResult> {
    if (config.algorithm === 'token-bucket') {
      return this._acquireTokenBucket(key, config);
    }
    return this._acquireSlidingWindow(key, config);
  }

  /**
   * No-op for P0. Concurrency limiting (maxConcurrent) is a P1 feature.
   */
  async release(_key: string): Promise<void> {
    // no-op
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

  // ---- Token Bucket --------------------------------------------------------

  private _acquireTokenBucket(key: string, config: AcquireConfig): AcquireResult {
    const ratePerSecond = config.ratePerSecond ?? 1;
    const interval = 1 / ratePerSecond; // seconds between allowed requests
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
    const ratePerSecond = config.ratePerSecond ?? 1;
    const interval = 1 / ratePerSecond;

    const state = this.tokenBuckets.get(key);
    if (state === undefined) {
      // Key has never been used — next request will succeed
      return {
        allowed: true,
        remaining: 1,
        resetAt: Math.floor(now + interval),
        currentUsage: 0,
      };
    }

    const elapsed = now - state.lastTimestamp;
    const allowed = elapsed >= interval;
    return {
      allowed,
      remaining: allowed ? 1 : 0,
      resetAt: Math.floor(state.lastTimestamp + interval),
      currentUsage: allowed ? 0 : 1,
    };
  }

  // ---- Sliding Window ------------------------------------------------------

  private _acquireSlidingWindow(key: string, config: AcquireConfig): AcquireResult {
    const limit = config.limit ?? 1;
    const windowSeconds = config.windowSeconds ?? 60;
    const now = Date.now() / 1000;
    const cutoff = now - windowSeconds;

    let state = this.slidingWindows.get(key);
    if (state === undefined) {
      state = { timestamps: [] };
      this.slidingWindows.set(key, state);
    }

    // Prune expired entries (on-demand cleanup — no setInterval)
    state.timestamps = state.timestamps.filter((ts) => ts > cutoff);

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
