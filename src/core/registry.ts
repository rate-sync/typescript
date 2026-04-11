import { MemoryStore } from '../engines/memory/index.js';
import type { EngineConfig, LimiterConfig, MultiLimiterResult, RateLimitResult } from './schemas.js';
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

  async configureStore(storeId: string, config: EngineConfig): Promise<void> {
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
      // postgres: not yet supported via registry
      throw new Error(
        `Engine "${config.engine}" is not yet supported in the registry.`,
      );
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
  }
}

// ---------------------------------------------------------------------------
// Singleton via globalThis (hot-reload safe)
// ---------------------------------------------------------------------------

/**
 * Returns the global Registry instance, creating a new one if it doesn't exist.
 * Reading from globalThis on every call ensures that after closeAll() deletes
 * the singleton, the next call gets a fresh Registry rather than the stale
 * module-level reference.
 */
function getRegistry(): Registry {
  const g = globalThis as unknown as { __rateSyncRegistry?: Registry };
  return (g.__rateSyncRegistry ??= new Registry());
}

// ---------------------------------------------------------------------------
// Module-level functions
// ---------------------------------------------------------------------------

export async function configureStore(storeId: string, config: EngineConfig): Promise<void> {
  return getRegistry().configureStore(storeId, config);
}

export function configureLimiter(limiterId: string, config: LimiterConfig): void {
  getRegistry().configureLimiter(limiterId, config);
}

export function getLimiter(limiterId: string): RateLimiter {
  return getRegistry().getLimiter(limiterId);
}

export function cloneLimiter(baseId: string, newId: string): void {
  getRegistry().cloneLimiter(baseId, newId);
}

export function getOrCloneLimiter(baseId: string, newId: string): RateLimiter {
  return getRegistry().getOrCloneLimiter(baseId, newId);
}

export function getStore(storeId: string): RateLimitStore {
  return getRegistry().getStore(storeId);
}

export function listStores(): string[] {
  return getRegistry().listStores();
}

export function listLimiters(): string[] {
  return getRegistry().listLimiters();
}

export async function acquire(limiterId: string): Promise<void> {
  return getRegistry().acquire(limiterId);
}

export async function initializeLimiter(limiterId: string): Promise<void> {
  return getRegistry().initializeLimiter(limiterId);
}

export async function initializeAllLimiters(): Promise<void> {
  return getRegistry().initializeAllLimiters();
}

export async function checkLimiter(
  limiterId: string,
  identifier?: string,
): Promise<RateLimitResult> {
  return getRegistry().checkLimiter(limiterId, identifier);
}

export async function checkMultiLimiters(
  limiterIds: string[],
  identifiers?: string[],
): Promise<MultiLimiterResult> {
  return getRegistry().checkMultiLimiters(limiterIds, identifiers);
}

export async function closeAll(): Promise<void> {
  return getRegistry().closeAll();
}
