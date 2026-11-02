import type { LimiterState } from '../core/schemas.js';

/**
 * Configuration passed to store.acquire() to specify the algorithm and limits.
 *
 * The relevant fields depend on the chosen algorithm:
 * - **token-bucket**: ratePerSecond, maxConcurrent
 * - **sliding-window**: limit, windowSeconds
 */
export interface AcquireConfig {
  algorithm: 'token-bucket' | 'sliding-window';
  ratePerSecond?: number;
  maxConcurrent?: number;
  limit?: number;
  windowSeconds?: number;
}

/**
 * Seconds between two allowed requests of a token bucket, or `0` when there is no rate gate.
 *
 * A token bucket without `ratePerSecond` (a concurrency-only limiter, `maxConcurrent` alone)
 * has no rate gate, as in the Python package; a zero or negative rate means the same. Only an
 * explicit positive rate limits throughput.
 */
export function intervalSeconds(ratePerSecond: number | undefined): number {
  return ratePerSecond !== undefined && ratePerSecond > 0 ? 1 / ratePerSecond : 0;
}

/**
 * Raw result returned by a store's acquire() call.
 *
 * The RateLimiter layer converts this into a RateLimitResult before
 * returning to callers.
 */
export interface AcquireResult {
  success: boolean;
  waitMs: number;
  concurrentCount?: number;
  currentCount?: number;
}

/**
 * Backend storage interface for rate limiting state.
 *
 * Each engine (Memory, Redis, PostgreSQL) implements this interface.
 * The RateLimiter class composes a store with algorithm orchestration,
 * keeping algorithm logic separate from storage concerns.
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
export interface RateLimitStore {
  initialize(): Promise<void>;
  acquire(key: string, config: AcquireConfig): Promise<AcquireResult>;
  release(key: string): Promise<void>;
  getState(key: string, config: AcquireConfig): Promise<LimiterState>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}
