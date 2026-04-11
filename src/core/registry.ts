import { MemoryStore } from '../engines/memory/index.js';
import type { SupportedEngineConfig, LimiterConfig, MultiLimiterResult, RateLimitResult } from './schemas.js';
import { createMultiLimiterResult } from './schemas.js';
import { LimiterNotFoundError, RateLimiterAlreadyConfiguredError, StoreNotFoundError } from './errors.js';
import type { RateLimitStore } from '../engines/base.js';
import { RateLimiter } from './rate-limiter.js';

// ---------------------------------------------------------------------------
// Registry class (singleton via globalThis)
// ---------------------------------------------------------------------------

class Registry {
  private stores = new Map<string, RateLimitStore>();
  private limiters = new Map<string, RateLimiter>();

  // ---- Stores ---------------------------------------------------------------

  async configureStore(storeId: string, config: SupportedEngineConfig): Promise<void> {
    let store: RateLimitStore;

    if (config.engine === 'memory') {
      store = new MemoryStore();
    } else if (config.engine === 'redis') {
      // Dynamic import: redis is an optional peer dependency
      const { RedisStore } = await import('../engines/redis/index.js');
      store = new RedisStore({
        url: config.url,
        db: config.db,
        password: config.password,
        keyPrefix: config.keyPrefix,
        socketTimeout: config.socketTimeout,
      });
    } else {
      // This branch is unreachable given SupportedEngineConfig = MemoryEngineConfig | RedisEngineConfig.
      // Left as a safeguard for runtime callers that bypass TypeScript.
      const _exhaustive: never = config;
      throw new Error(`Engine is not yet supported in the registry.`);
    }

    this.stores.set(storeId, store);
  }

  getStore(storeId: string): RateLimitStore {
    const store = this.stores.get(storeId);
    if (!store) {
      throw new StoreNotFoundError(storeId);
    }
    return store;
  }

  listStores(): string[] {
    return Array.from(this.stores.keys());
  }

  // ---- Limiters -------------------------------------------------------------

  configureLimiter(limiterId: string, config: LimiterConfig): void {
    if (this.limiters.has(limiterId)) {
      throw new RateLimiterAlreadyConfiguredError(limiterId);
    }

    const store = this.stores.get(config.store);
    if (!store) {
      throw new StoreNotFoundError(config.store);
    }

    const limiter = new RateLimiter({
      id: limiterId,
      store,
      storeId: config.store,
      algorithm: config.algorithm,
      ratePerSecond: config.ratePerSecond,
      maxConcurrent: config.maxConcurrent,
      limit: config.limit,
      windowSeconds: config.windowSeconds,
      timeout: config.timeout,
      failClosed: config.failClosed,
    });

    this.limiters.set(limiterId, limiter);
  }

  getLimiter(limiterId: string): RateLimiter {
    const limiter = this.limiters.get(limiterId);
    if (!limiter) {
      throw new LimiterNotFoundError(limiterId);
    }
    return limiter;
  }

  cloneLimiter(baseId: string, newId: string): void {
    const base = this.getLimiter(baseId);
    const baseConfig = base.getConfig();

    const store = this.stores.get(baseConfig.storeId);
    if (!store) {
      throw new StoreNotFoundError(baseConfig.storeId);
    }

    const cloned = new RateLimiter({
      id: newId,
      store,
      storeId: baseConfig.storeId,
      algorithm: baseConfig.algorithm,
      ratePerSecond: baseConfig.ratePerSecond ?? undefined,
      maxConcurrent: baseConfig.maxConcurrent ?? undefined,
      limit: baseConfig.limit ?? undefined,
      windowSeconds: baseConfig.windowSeconds ?? undefined,
      timeout: baseConfig.timeout ?? undefined,
      failClosed: baseConfig.failClosed,
    });

    this.limiters.set(newId, cloned);
  }

  getOrCloneLimiter(baseId: string, newId: string): RateLimiter {
    if (this.limiters.has(newId)) {
      return this.getLimiter(newId);
    }
    this.cloneLimiter(baseId, newId);
    return this.getLimiter(newId);
  }

  listLimiters(): string[] {
    return Array.from(this.limiters.keys());
  }

  // ---- Shorthand operations -------------------------------------------------

  async acquire(limiterId: string): Promise<void> {
    return this.getLimiter(limiterId).acquire();
  }

  async initializeLimiter(limiterId: string): Promise<void> {
    return this.getLimiter(limiterId).initialize();
  }

  async initializeAllLimiters(): Promise<void> {
    await Promise.all(
      Array.from(this.limiters.values()).map((limiter) => limiter.initialize()),
    );
  }

  async checkLimiter(limiterId: string, identifier?: string): Promise<RateLimitResult> {
    return this.getLimiter(limiterId).checkLimit(identifier);
  }

  async checkMultiLimiters(
    limiterIds: string[],
    identifiers?: string[],
  ): Promise<MultiLimiterResult> {
    const results = await Promise.all(
      limiterIds.map((id, index) =>
        this.getLimiter(id).checkLimit(identifiers?.[index]),
      ),
    );
    return createMultiLimiterResult(results);
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.stores.values()).map((store) => store.close()));
    this.stores.clear();
    this.limiters.clear();

    const g = globalThis as unknown as { __rateSyncRegistry?: Registry };
    delete g.__rateSyncRegistry;
    _cached = null;
  }
}

// ---------------------------------------------------------------------------
// Singleton via globalThis (hot-reload safe)
// ---------------------------------------------------------------------------

let _cached: Registry | null = null;

/**
 * Returns the global Registry instance, creating a new one if it doesn't exist.
 * The module-level cache avoids repeated globalThis lookups on hot paths.
 * After closeAll() sets _cached to null, the next call creates a fresh Registry.
 */
function getRegistry(): Registry {
  if (_cached) return _cached;
  const g = globalThis as unknown as { __rateSyncRegistry?: Registry };
  _cached = (g.__rateSyncRegistry ??= new Registry());
  return _cached;
}

// ---------------------------------------------------------------------------
// Module-level functions
// ---------------------------------------------------------------------------

/**
 * Register a new store backend.
 *
 * @param storeId - Unique identifier for this store
 * @param config - Store configuration (`MemoryEngineConfig` or `RedisEngineConfig`)
 * @throws {Error} If engine type is not supported
 */
export async function configureStore(storeId: string, config: SupportedEngineConfig): Promise<void> {
  return getRegistry().configureStore(storeId, config);
}

/**
 * Register a new rate limiter against a previously configured store.
 *
 * @param limiterId - Unique identifier for this limiter
 * @param config - Limiter configuration including algorithm, limits, and store reference
 * @throws {RateLimiterAlreadyConfiguredError} If a limiter with `limiterId` already exists
 * @throws {StoreNotFoundError} If the referenced store has not been configured
 */
export function configureLimiter(limiterId: string, config: LimiterConfig): void {
  getRegistry().configureLimiter(limiterId, config);
}

/**
 * Retrieve a previously configured limiter by ID.
 *
 * @param limiterId - The limiter identifier to look up
 * @returns The `RateLimiter` instance
 * @throws {LimiterNotFoundError} If no limiter with `limiterId` has been configured
 */
export function getLimiter(limiterId: string): RateLimiter {
  return getRegistry().getLimiter(limiterId);
}

/**
 * Retrieve a previously configured store by ID.
 *
 * @param storeId - The store identifier to look up
 * @returns The `RateLimitStore` instance
 * @throws {StoreNotFoundError} If no store with `storeId` has been configured
 */
export function getStore(storeId: string): RateLimitStore {
  return getRegistry().getStore(storeId);
}

/**
 * Clone an existing limiter's configuration under a new ID.
 * Useful for creating per-user or per-tenant limiters from a shared base config.
 *
 * @param baseId - The ID of the existing limiter to clone
 * @param newId - The ID for the new cloned limiter
 * @throws {LimiterNotFoundError} If `baseId` does not exist
 * @throws {StoreNotFoundError} If the base limiter's store is no longer available
 */
export function cloneLimiter(baseId: string, newId: string): void {
  getRegistry().cloneLimiter(baseId, newId);
}

/**
 * Return an existing limiter by `newId`, or clone it from `baseId` if it doesn't exist yet.
 * Idempotent — safe to call on every request for per-user / per-tenant scenarios.
 *
 * @param baseId - The ID of the limiter to use as the clone source
 * @param newId - The ID to look up or create
 * @returns The existing or newly cloned `RateLimiter` instance
 * @throws {LimiterNotFoundError} If `baseId` does not exist
 */
export function getOrCloneLimiter(baseId: string, newId: string): RateLimiter {
  return getRegistry().getOrCloneLimiter(baseId, newId);
}

/**
 * Return the IDs of all configured stores.
 *
 * @returns Array of store ID strings
 */
export function listStores(): string[] {
  return getRegistry().listStores();
}

/**
 * Return the IDs of all configured limiters.
 *
 * @returns Array of limiter ID strings
 */
export function listLimiters(): string[] {
  return getRegistry().listLimiters();
}

/**
 * Block until a rate-limit slot is available for the given limiter.
 * Equivalent to `getLimiter(limiterId).acquire()`.
 *
 * @param limiterId - The limiter to acquire a slot from
 * @throws {LimiterNotFoundError} If no limiter with `limiterId` has been configured
 * @throws {RateLimiterNotInitializedError} If the limiter has not been initialized
 */
export async function acquire(limiterId: string): Promise<void> {
  return getRegistry().acquire(limiterId);
}

/**
 * Initialize a single limiter (connects to its backing store).
 * Must be called before `acquire` or `checkLimiter` unless `initializeAllLimiters` was used.
 *
 * @param limiterId - The limiter to initialize
 * @throws {LimiterNotFoundError} If no limiter with `limiterId` has been configured
 */
export async function initializeLimiter(limiterId: string): Promise<void> {
  return getRegistry().initializeLimiter(limiterId);
}

/**
 * Initialize all configured limiters in parallel.
 * Call this once at application startup after all stores and limiters are configured.
 */
export async function initializeAllLimiters(): Promise<void> {
  return getRegistry().initializeAllLimiters();
}

/**
 * Check and consume a rate-limit slot for an optional per-identifier key.
 * The effective store key is `limiterId` when `identifier` is omitted, or
 * `limiterId:identifier` when provided.
 *
 * @param limiterId - The limiter to check against
 * @param identifier - Optional per-user / per-IP discriminator
 * @returns A `RateLimitResult` with `allowed`, `remaining`, `resetIn`, and `retryAfter`
 * @throws {LimiterNotFoundError} If no limiter with `limiterId` has been configured
 * @throws {RateLimiterNotInitializedError} If the limiter has not been initialized
 */
export async function checkLimiter(
  limiterId: string,
  identifier?: string,
): Promise<RateLimitResult> {
  return getRegistry().checkLimiter(limiterId, identifier);
}

/**
 * Check and consume slots for multiple limiters in parallel.
 * Each `identifiers[i]` is paired with `limiterIds[i]`; omit `identifiers` to use bare limiter IDs as keys.
 *
 * @param limiterIds - Ordered list of limiter IDs to check
 * @param identifiers - Optional ordered list of per-request identifiers (must match length of `limiterIds`)
 * @returns A `MultiLimiterResult` aggregating all individual results
 * @throws {LimiterNotFoundError} If any limiter ID in `limiterIds` has not been configured
 */
export async function checkMultiLimiters(
  limiterIds: string[],
  identifiers?: string[],
): Promise<MultiLimiterResult> {
  return getRegistry().checkMultiLimiters(limiterIds, identifiers);
}

/**
 * Close all store connections and reset the registry to an empty state.
 * Subsequent calls to any registry function will start fresh.
 * Useful in tests and graceful-shutdown handlers.
 */
export async function closeAll(): Promise<void> {
  return getRegistry().closeAll();
}
