import type { AcquireConfig, RateLimitStore } from '../engines/base.js';
import {
  createMetrics,
  createRateLimitResult,
  type LimiterReadOnlyConfig,
  type LimiterState,
  type RateLimitResult,
  type RateLimiterMetrics,
} from './schemas.js';
import {
  ConfigValidationError,
  RateLimiterAcquisitionError,
  RateLimiterNotInitializedError,
} from './errors.js';

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private _initPromise: Promise<void> | null = null;
  /**
   * Set when initialize() fails with failClosed=false. While degraded,
   * acquire()/tryAcquire()/release()/getState()/checkLimit() return
   * permissive (allow) results instead of throwing
   * RateLimiterNotInitializedError. Cleared on the next successful
   * initialize().
   */
  private _degraded = false;
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
    // A token bucket is gated by ratePerSecond, maxConcurrent or both. With neither it would
    // admit everything forever, silently, so refuse it here instead of failing open.
    if (
      this._algorithm === 'token-bucket' &&
      !(this._ratePerSecond !== null && this._ratePerSecond > 0) &&
      !(this._maxConcurrent !== null && this._maxConcurrent > 0)
    ) {
      throw new ConfigValidationError(
        `Limiter "${this._id}": a token-bucket limiter needs ratePerSecond or maxConcurrent (a positive number); with neither it would not limit anything.`,
        'ratePerSecond',
        'ratePerSecond or maxConcurrent',
        'neither',
      );
    }
    this._metrics = createMetrics();
    this._acquireConfig = this._buildAcquireConfig();
  }

  // ---- Lifecycle ------------------------------------------------------------

  /**
   * Connect to the backing store and mark this limiter as ready.
   * Safe to call multiple times — subsequent calls are no-ops.
   * Must complete before calling `acquire`, `tryAcquire`, `checkLimit`, or `getState`.
   *
   * Honors `failClosed` on backend failure: if `failClosed` is `true`, rejects
   * with `RateLimiterAcquisitionError`. If `failClosed` is `false` (default),
   * logs a warning and resolves without rejecting, leaving the limiter in a
   * degraded fail-open mode where `acquire`/`tryAcquire`/`release`/`getState`/
   * `checkLimit` return permissive (allow) results until a later
   * `initialize()` call succeeds.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;
    if (!this._initPromise) {
      this._initPromise = this._store
        .initialize()
        .then(() => {
          this._initialized = true;
          this._degraded = false;
        })
        .catch((error: unknown) => {
          // Clear the cached promise so a later initialize() call retries
          // against the backend instead of replaying this rejection forever.
          this._initPromise = null;

          if (this._failClosed) {
            throw new RateLimiterAcquisitionError(
              `Backend failure and failClosed=true for limiter "${this._id}": ${toErrorMessage(error)}`,
              this._id,
            );
          }

          // Fail-open: don't let a backend outage block startup.
          console.warn(
            `[rate-sync] Backend unavailable for limiter "${this._id}", continuing in degraded fail-open mode (failClosed=false): ${toErrorMessage(error)}`,
          );
          this._degraded = true;
        });
    }
    await this._initPromise;
  }

  /**
   * Return a limiter for one key that shares this limiter's store (and so its connection).
   *
   * The returned limiter has the id `"{this.groupId}:{identifier}"` and this limiter's
   * configuration. It is ready to use when this limiter is initialized (or degraded), and it has
   * its own metrics. Nothing is registered. Prefer `getKeyedLimiter`, which also initializes the
   * base limiter.
   *
   * @param identifier - The per-caller key (user id, client address, tenant, hash)
   */
  forKey(identifier: string): RateLimiter {
    const view = new RateLimiter({
      id: `${this._id}:${identifier}`,
      store: this._store,
      storeId: this._storeId,
      algorithm: this._algorithm,
      ratePerSecond: this._ratePerSecond ?? undefined,
      maxConcurrent: this._maxConcurrent ?? undefined,
      limit: this._limit ?? undefined,
      windowSeconds: this._windowSeconds ?? undefined,
      timeout: this._timeout ?? undefined,
      failClosed: this._failClosed,
    });
    view._initialized = this._initialized;
    view._degraded = this._degraded;
    return view;
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

  /**
   * Handle a backend failure raised by a store call after successful
   * initialization. Mirrors the fail_closed contract of `initialize()`:
   * throws when `failClosed` is `true`, otherwise logs a warning and
   * returns so the caller can fall back to a permissive result.
   */
  private _handleBackendFailure(error: unknown): void {
    if (this._failClosed) {
      throw new RateLimiterAcquisitionError(
        `Backend failure and failClosed=true for limiter "${this._id}": ${toErrorMessage(error)}`,
        this._id,
      );
    }
    console.warn(
      `[rate-sync] Backend failure for limiter "${this._id}", allowing request (fail-open): ${toErrorMessage(error)}`,
    );
  }

  /** Logs the degraded-mode fallback used when a method is called while not initialized. */
  private _warnDegraded(method: string): void {
    console.warn(
      `[rate-sync] Limiter "${this._id}": backend unavailable (degraded fail-open mode), ${method}() returning a permissive result`,
    );
  }

  private _permissiveLimiterState(): LimiterState {
    return {
      allowed: true,
      remaining: 100,
      resetAt: Math.floor(Date.now() / 1000) + 1,
      currentUsage: 0,
    };
  }

  private _permissiveRateLimitResult(): RateLimitResult {
    const limit =
      this._algorithm === 'sliding-window'
        ? (this._limit ?? 1)
        : (this._ratePerSecond ?? this._maxConcurrent ?? 1);
    return createRateLimitResult({
      allowed: true,
      limit,
      remaining: limit,
      resetIn: 0,
      limiterId: this._id,
    });
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
   *
   * In degraded fail-open mode (initialize() failed with failClosed=false),
   * returns immediately without acquiring a real slot. On a backend failure
   * after successful initialization, honors failClosed the same way.
   */
  async acquire(): Promise<void> {
    if (!this._initialized) {
      if (this._degraded) {
        this._warnDegraded('acquire');
        return;
      }
      throw new RateLimiterNotInitializedError(this._id);
    }
    const config = this._acquireConfig;
    const startMs = Date.now();

    try {
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
    } catch (error: unknown) {
      this._handleBackendFailure(error);
    }
  }

  /**
   * Tries once. Returns false if the slot is unavailable.
   * If timeout is provided, retries until timeout expires.
   *
   * In degraded fail-open mode (initialize() failed with failClosed=false),
   * returns true immediately without acquiring a real slot. On a backend
   * failure after successful initialization, honors failClosed the same way.
   */
  async tryAcquire(timeout?: number): Promise<boolean> {
    if (!this._initialized) {
      if (this._degraded) {
        this._warnDegraded('tryAcquire');
        return true;
      }
      throw new RateLimiterNotInitializedError(this._id);
    }
    const config = this._acquireConfig;
    const effectiveTimeout = timeout ?? this._timeout;
    const deadline = effectiveTimeout !== null ? Date.now() + effectiveTimeout : null;

    const startMs = Date.now();

    try {
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
    } catch (error: unknown) {
      this._handleBackendFailure(error);
      return true;
    }
  }

  /**
   * Releases a concurrency slot.
   *
   * In degraded fail-open mode (initialize() failed with failClosed=false),
   * this is a no-op. On a backend failure after successful initialization,
   * honors failClosed the same way as acquire()/tryAcquire().
   */
  async release(): Promise<void> {
    if (!this._initialized) {
      if (this._degraded) {
        this._warnDegraded('release');
        return;
      }
      throw new RateLimiterNotInitializedError(this._id);
    }
    try {
      await this._store.release(this._id);
    } catch (error: unknown) {
      this._handleBackendFailure(error);
      return;
    }
    this._metrics.currentConcurrent = Math.max(0, this._metrics.currentConcurrent - 1);
    this._metrics.totalReleases += 1;
  }

  /**
   * Acquires a slot, runs fn, then releases. Optionally respects a timeout.
   */
  async using(fn: () => Promise<void>, timeout?: number): Promise<void> {
    const acquired = await this.tryAcquire(timeout);
    if (!acquired) {
      throw new RateLimiterAcquisitionError(
        `Failed to acquire rate limiter "${this._id}" within timeout`,
        this._id,
      );
    }
    try {
      await fn();
    } finally {
      await this.release();
    }
  }

  // ---- Check (rate-limit by identifier) ------------------------------------

  /**
   * Checks and consumes a rate-limit slot for a given identifier. A concurrency slot, if the
   * limiter has `maxConcurrent`, is checked but not held: it is released right away.
   * key = identifier ? `${id}:${identifier}` : id
   *
   * In degraded fail-open mode (initialize() failed with failClosed=false),
   * returns a permissive (allowed) result without consuming a real slot. On
   * a backend failure after successful initialization, honors failClosed
   * the same way as acquire()/tryAcquire().
   */
  async checkLimit(identifier?: string): Promise<RateLimitResult> {
    if (!this._initialized) {
      if (this._degraded) {
        this._warnDegraded('checkLimit');
        return this._permissiveRateLimitResult();
      }
      throw new RateLimiterNotInitializedError(this._id);
    }
    const key = identifier ? `${this._id}:${identifier}` : this._id;
    const config = this._acquireConfig;

    let result: Awaited<ReturnType<RateLimitStore['acquire']>>;
    try {
      result = await this._store.acquire(key, config);
    } catch (error: unknown) {
      this._handleBackendFailure(error);
      return this._permissiveRateLimitResult();
    }

    // checkLimit is a momentary admission check, not a held slot: nothing would ever release the
    // concurrency slot it took, so give it back right away (it still refused when all were held).
    if (result.success && this._maxConcurrent !== null) {
      try {
        await this._store.release(key);
      } catch (error: unknown) {
        this._handleBackendFailure(error);
      }
    }

    // Derive limit and remaining from config fields
    const limit =
      this._algorithm === 'sliding-window'
        ? (this._limit ?? 1)
        : (this._ratePerSecond ?? this._maxConcurrent ?? 1);

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

  /**
   * The limiter's unique ID within the registry (also used as the base store key).
   */
  get groupId(): string {
    return this._id;
  }

  /**
   * Maximum requests per second allowed by this limiter, or `null` if not configured.
   */
  get ratePerSecond(): number | null {
    return this._ratePerSecond;
  }

  /**
   * Maximum number of concurrent in-flight requests allowed, or `null` if not configured.
   */
  get maxConcurrent(): number | null {
    return this._maxConcurrent;
  }

  /**
   * Whether `initialize()` has completed successfully.
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Default timeout in milliseconds used by `tryAcquire` and `using`, or `null` if none was set.
   */
  get defaultTimeout(): number | null {
    return this._timeout;
  }

  /**
   * Whether the limiter should block requests when the store is unavailable.
   *
   * Enforced by `initialize()`, `acquire()`, `tryAcquire()`, `release()`,
   * `checkLimit()`, and `getState()`: on a backend failure, `true` throws
   * `RateLimiterAcquisitionError`; `false` (default) logs a warning and
   * returns a permissive (allow) result instead.
   */
  get failClosed(): boolean {
    return this._failClosed;
  }

  // ---- Introspection --------------------------------------------------------

  /**
   * Return a snapshot of runtime metrics for this limiter.
   * Includes total acquisitions, wait times, concurrent counts, and timeout counts.
   *
   * @returns A shallow copy of the current `RateLimiterMetrics`
   */
  getMetrics(): RateLimiterMetrics {
    // Return a copy
    return { ...this._metrics };
  }

  /**
   * Return the immutable configuration this limiter was created with.
   * Useful for inspecting a cloned limiter or for serialisation / debugging.
   *
   * @returns A `LimiterReadOnlyConfig` snapshot
   */
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

  /**
   * Returns the current state without consuming a slot.
   *
   * In degraded fail-open mode (initialize() failed with failClosed=false),
   * returns a permissive (allowed) state. On a backend failure after
   * successful initialization, honors failClosed the same way as
   * acquire()/tryAcquire().
   */
  async getState(identifier?: string): Promise<LimiterState> {
    if (!this._initialized) {
      if (this._degraded) {
        this._warnDegraded('getState');
        return this._permissiveLimiterState();
      }
      throw new RateLimiterNotInitializedError(this._id);
    }
    const key = identifier ? `${this._id}:${identifier}` : this._id;
    try {
      return await this._store.getState(key, this._acquireConfig);
    } catch (error: unknown) {
      this._handleBackendFailure(error);
      return this._permissiveLimiterState();
    }
  }

  /**
   * Resets all stored state for this limiter, including per-identifier keys.
   * Calls store.reset() with a wildcard-style key so the store can clear all
   * related entries (e.g., "limiter-id" and "limiter-id:user-1").
   */
  async resetState(identifier?: string): Promise<void> {
    this._ensureInitialized();
    const key = identifier ? `${this._id}:${identifier}` : this._id;
    await this._store.reset(key);
  }
}
