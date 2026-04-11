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
