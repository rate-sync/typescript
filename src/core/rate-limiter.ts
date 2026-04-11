import type { AcquireConfig, RateLimitStore } from '../engines/base.js';
import {
  createMetrics,
  createRateLimitResult,
  type LimiterReadOnlyConfig,
  type LimiterState,
  type RateLimitResult,
  type RateLimiterMetrics,
} from './schemas.js';
import { RateLimiterNotInitializedError } from './errors.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  id: string;
  store: RateLimitStore;
  storeId: string;
  algorithm?: 'token-bucket' | 'sliding-window';
  ratePerSecond?: number;
  maxConcurrent?: number;
  limit?: number;
  windowSeconds?: number;
  timeout?: number;
  failClosed?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly _id: string;
  private readonly _store: RateLimitStore;
  private readonly _storeId: string;
  private readonly _algorithm: 'token-bucket' | 'sliding-window';
  private readonly _ratePerSecond: number | null;
  private readonly _maxConcurrent: number | null;
  private readonly _limit: number | null;
  private readonly _windowSeconds: number | null;
  private readonly _timeout: number | null;
  private readonly _failClosed: boolean;

  private _initialized = false;
  private _metrics: RateLimiterMetrics;
  private readonly _acquireConfig: AcquireConfig;

  constructor(options: RateLimiterOptions) {
    this._id = options.id;
    this._store = options.store;
    this._storeId = options.storeId;
    this._algorithm = options.algorithm ?? 'token-bucket';
    this._ratePerSecond = options.ratePerSecond ?? null;
    this._maxConcurrent = options.maxConcurrent ?? null;
    this._limit = options.limit ?? null;
    this._windowSeconds = options.windowSeconds ?? null;
    this._timeout = options.timeout ?? null;
    this._failClosed = options.failClosed ?? false;
    this._metrics = createMetrics();
    this._acquireConfig = this._buildAcquireConfig();
  }

  // ---- Lifecycle ------------------------------------------------------------

  async initialize(): Promise<void> {
    if (!this._initialized) {
      await this._store.initialize();
      this._initialized = true;
    }
  }

  // ---- Internal helpers -----------------------------------------------------

  private _buildAcquireConfig(): AcquireConfig {
    const config: AcquireConfig = {
      algorithm: this._algorithm,
    };
    if (this._ratePerSecond !== null) config.ratePerSecond = this._ratePerSecond;
    if (this._maxConcurrent !== null) config.maxConcurrent = this._maxConcurrent;
    if (this._limit !== null) config.limit = this._limit;
    if (this._windowSeconds !== null) config.windowSeconds = this._windowSeconds;
    return config;
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new RateLimiterNotInitializedError(this._id);
    }
  }

  private _updateMetricsOnAcquire(waitMs: number): void {
    this._metrics.totalAcquisitions += 1;
    this._metrics.totalWaitTimeMs += waitMs;
    this._metrics.avgWaitTimeMs =
      this._metrics.totalAcquisitions > 0
        ? this._metrics.totalWaitTimeMs / this._metrics.totalAcquisitions
        : 0;
    if (waitMs > this._metrics.maxWaitTimeMs) {
      this._metrics.maxWaitTimeMs = waitMs;
    }
    this._metrics.lastAcquisitionAt = Date.now();
    this._metrics.currentConcurrent += 1;
    if (this._metrics.currentConcurrent > this._metrics.maxConcurrentReached) {
      this._metrics.maxConcurrentReached = this._metrics.currentConcurrent;
    }
  }

  // ---- Acquisition ----------------------------------------------------------

  /**
   * Blocks indefinitely (polling with sleep) until a slot is available.
   */
  async acquire(): Promise<void> {
    this._ensureInitialized();
    const config = this._acquireConfig;
    const startMs = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await this._store.acquire(this._id, config);
      if (result.success) {
        const waitMs = Date.now() - startMs;
        this._updateMetricsOnAcquire(waitMs);
        return;
      }
      await sleep(result.waitMs > 0 ? result.waitMs : 10);
    }
  }

  /**
   * Tries once. Returns false if the slot is unavailable.
   * If timeout is provided, retries until timeout expires.
   */
  async tryAcquire(timeout?: number): Promise<boolean> {
    this._ensureInitialized();
    const config = this._acquireConfig;
    const effectiveTimeout = timeout ?? this._timeout;
    const deadline = effectiveTimeout !== null ? Date.now() + effectiveTimeout : null;

    const startMs = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await this._store.acquire(this._id, config);
      if (result.success) {
        const waitMs = Date.now() - startMs;
        this._updateMetricsOnAcquire(waitMs);
        return true;
      }

      // No timeout — return immediately
      if (deadline === null) {
        this._metrics.timeouts += 1;
        return false;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this._metrics.timeouts += 1;
        return false;
      }

      const sleepMs = Math.min(result.waitMs > 0 ? result.waitMs : 10, remaining);
      await sleep(sleepMs);
    }
  }

  /**
   * Releases a concurrency slot.
   */
  async release(): Promise<void> {
    this._ensureInitialized();
    await this._store.release(this._id);
    this._metrics.currentConcurrent = Math.max(0, this._metrics.currentConcurrent - 1);
    this._metrics.totalReleases += 1;
  }

  /**
   * Acquires a slot, runs fn, then releases. Optionally respects a timeout.
   */
  async using(fn: () => Promise<void>, timeout?: number): Promise<void> {
    const acquired = await this.tryAcquire(timeout);
    if (!acquired) {
      throw new Error(`RateLimiter "${this._id}": failed to acquire slot within timeout`);
    }
    try {
      await fn();
    } finally {
      await this.release();
    }
  }

  // ---- Check (rate-limit by identifier) ------------------------------------

  /**
   * Checks and consumes a rate-limit slot for a given identifier.
   * key = identifier ? `${id}:${identifier}` : id
   */
  async checkLimit(identifier?: string): Promise<RateLimitResult> {
    this._ensureInitialized();
    const key = identifier ? `${this._id}:${identifier}` : this._id;
    const config = this._acquireConfig;

    const result = await this._store.acquire(key, config);

    // Derive limit and remaining from config fields
    const limit =
      this._algorithm === 'sliding-window'
        ? (this._limit ?? 1)
        : (this._ratePerSecond ?? 1);

    const remaining = result.success
      ? Math.max(0, limit - (result.currentCount ?? 1))
      : 0;

    const resetIn = result.success ? 0 : result.waitMs / 1000;

    return createRateLimitResult({
      allowed: result.success,
      limit,
      remaining,
      resetIn,
      limiterId: this._id,
    });
  }

  // ---- Getters --------------------------------------------------------------

  get groupId(): string {
    return this._id;
  }

  get ratePerSecond(): number | null {
    return this._ratePerSecond;
  }

  get maxConcurrent(): number | null {
    return this._maxConcurrent;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get defaultTimeout(): number | null {
    return this._timeout;
  }

  /**
   * Whether the limiter should block requests when the store is unavailable.
   * NOTE: This field is stored but not enforced by RateLimiter itself.
   * Use `failOpen` option on withRateLimit/withRateLimitAction wrappers instead.
   * Per-limiter failClosed enforcement is planned for P1.
   */
  get failClosed(): boolean {
    return this._failClosed;
  }

  // ---- Introspection --------------------------------------------------------

  getMetrics(): RateLimiterMetrics {
    // Return a copy
    return { ...this._metrics };
  }

  getConfig(): LimiterReadOnlyConfig {
    return {
      id: this._id,
      algorithm: this._algorithm,
      storeId: this._storeId,
      ratePerSecond: this._ratePerSecond,
      maxConcurrent: this._maxConcurrent,
      timeout: this._timeout,
      limit: this._limit,
      windowSeconds: this._windowSeconds,
      failClosed: this._failClosed,
    };
  }

  async getState(identifier?: string): Promise<LimiterState> {
    this._ensureInitialized();
    const key = identifier ? `${this._id}:${identifier}` : this._id;
    return this._store.getState(key, this._acquireConfig);
  }

  /**
   * Resets all stored state for this limiter (used by testing utilities).
   */
  async resetState(): Promise<void> {
    this._ensureInitialized();
    await this._store.reset(this._id);
  }
}
