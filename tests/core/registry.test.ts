import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  configureStore,
  configureLimiter,
  getLimiter,
  cloneLimiter,
  getOrCloneLimiter,
  listStores,
  listLimiters,
  initializeLimiter,
  initializeAllLimiters,
  checkLimiter,
  checkMultiLimiters,
  closeAll,
} from '../../src/core/registry.js';
import { StoreNotFoundError, LimiterNotFoundError } from '../../src/core/errors.js';

// Reset the registry between each test by closing all state
beforeEach(async () => {
  await closeAll();
});

afterEach(async () => {
  await closeAll();
});

// ---------------------------------------------------------------------------
// Helper: set up a store + limiter in one call
// ---------------------------------------------------------------------------
async function setup(storeName = 'mem', limiterName = 'lim') {
  await configureStore(storeName, { engine: 'memory' });
  configureLimiter(limiterName, {
    store: storeName,
    algorithm: 'sliding-window',
    limit: 10,
    windowSeconds: 60,
  });
  await initializeLimiter(limiterName);
  return { storeName, limiterName };
}

// ---------------------------------------------------------------------------
// configureStore
// ---------------------------------------------------------------------------

describe('configureStore', () => {
  it('adds the store to listStores()', async () => {
    await configureStore('main', { engine: 'memory' });
    expect(listStores()).toContain('main');
  });

  it('supports multiple stores', async () => {
    await configureStore('store-a', { engine: 'memory' });
    await configureStore('store-b', { engine: 'memory' });
    const stores = listStores();
    expect(stores).toContain('store-a');
    expect(stores).toContain('store-b');
  });
});

// ---------------------------------------------------------------------------
// configureLimiter
// ---------------------------------------------------------------------------

describe('configureLimiter', () => {
  it('adds limiter to listLimiters()', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('api', { store: 'mem', algorithm: 'token-bucket', ratePerSecond: 10 });
    expect(listLimiters()).toContain('api');
  });

  it('throws StoreNotFoundError when store does not exist', () => {
    expect(() =>
      configureLimiter('api', { store: 'nonexistent', algorithm: 'token-bucket' }),
    ).toThrow(StoreNotFoundError);
  });

  it('thrown StoreNotFoundError has correct storeId', () => {
    expect(() =>
      configureLimiter('api', { store: 'ghost' }),
    ).toThrow(expect.objectContaining({ storeId: 'ghost' }));
  });
});

// ---------------------------------------------------------------------------
// getLimiter
// ---------------------------------------------------------------------------

describe('getLimiter', () => {
  it('returns the configured limiter', async () => {
    await setup('mem', 'lim');
    const limiter = getLimiter('lim');
    expect(limiter).toBeDefined();
    expect(limiter.groupId).toBe('lim');
  });

  it('throws LimiterNotFoundError for unknown id', () => {
    expect(() => getLimiter('unknown')).toThrow(LimiterNotFoundError);
  });

  it('thrown LimiterNotFoundError has correct limiterId', () => {
    expect(() => getLimiter('ghost')).toThrow(
      expect.objectContaining({ limiterId: 'ghost' }),
    );
  });
});

// ---------------------------------------------------------------------------
// initializeLimiter
// ---------------------------------------------------------------------------

describe('initializeLimiter', () => {
  it('marks the limiter as initialized', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('lim', { store: 'mem', algorithm: 'token-bucket', ratePerSecond: 5 });

    const limiter = getLimiter('lim');
    expect(limiter.isInitialized).toBe(false);

    await initializeLimiter('lim');
    expect(limiter.isInitialized).toBe(true);
  });

  it('throws LimiterNotFoundError for unknown id', async () => {
    await expect(initializeLimiter('nope')).rejects.toThrow(LimiterNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// initializeAllLimiters
// ---------------------------------------------------------------------------

describe('initializeAllLimiters', () => {
  it('initializes all configured limiters', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('limA', { store: 'mem', algorithm: 'token-bucket', ratePerSecond: 5 });
    configureLimiter('limB', { store: 'mem', algorithm: 'sliding-window', limit: 10, windowSeconds: 60 });

    await initializeAllLimiters();

    expect(getLimiter('limA').isInitialized).toBe(true);
    expect(getLimiter('limB').isInitialized).toBe(true);
  });

  it('resolves immediately when no limiters are configured', async () => {
    await expect(initializeAllLimiters()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkLimiter
// ---------------------------------------------------------------------------

describe('checkLimiter', () => {
  it('returns a RateLimitResult with expected shape', async () => {
    await setup('mem', 'lim');
    const result = await checkLimiter('lim');
    expect(typeof result.allowed).toBe('boolean');
    expect(typeof result.limit).toBe('number');
    expect(typeof result.remaining).toBe('number');
    expect(typeof result.resetIn).toBe('number');
    expect(typeof result.resetAt).toBe('number');
    expect(typeof result.retryAfter).toBe('number');
    expect(result.limiterId).toBe('lim');
  });

  it('returns allowed=true for a fresh limiter', async () => {
    await setup('mem', 'lim');
    const result = await checkLimiter('lim');
    expect(result.allowed).toBe(true);
  });

  it('uses identifier as a namespace for the key', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('user-lim', {
      store: 'mem',
      algorithm: 'sliding-window',
      limit: 1,
      windowSeconds: 60,
    });
    await initializeLimiter('user-lim');

    // First call for user-1 should succeed
    const r1 = await checkLimiter('user-lim', 'user-1');
    expect(r1.allowed).toBe(true);

    // Second call for user-1 should be blocked
    const r2 = await checkLimiter('user-lim', 'user-1');
    expect(r2.allowed).toBe(false);

    // user-2 should still be allowed (separate namespace)
    const r3 = await checkLimiter('user-lim', 'user-2');
    expect(r3.allowed).toBe(true);
  });

  it('throws LimiterNotFoundError for unknown limiter', async () => {
    await expect(checkLimiter('ghost')).rejects.toThrow(LimiterNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// checkMultiLimiters
// ---------------------------------------------------------------------------

describe('checkMultiLimiters', () => {
  it('returns a MultiLimiterResult with combined results', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('limX', { store: 'mem', algorithm: 'sliding-window', limit: 5, windowSeconds: 60 });
    configureLimiter('limY', { store: 'mem', algorithm: 'sliding-window', limit: 5, windowSeconds: 60 });
    await initializeAllLimiters();

    const result = await checkMultiLimiters(['limX', 'limY']);
    expect(result.allowed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(typeof result.limit).toBe('number');
    expect(typeof result.remaining).toBe('number');
    expect(typeof result.resetAt).toBe('number');
    expect(typeof result.retryAfter).toBe('number');
  });

  it('allowed=false when any limiter is denied', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('limA', { store: 'mem', algorithm: 'sliding-window', limit: 1, windowSeconds: 60 });
    configureLimiter('limB', { store: 'mem', algorithm: 'sliding-window', limit: 10, windowSeconds: 60 });
    await initializeAllLimiters();

    // Exhaust limA
    await checkLimiter('limA');

    const result = await checkMultiLimiters(['limA', 'limB']);
    expect(result.allowed).toBe(false);
    expect(result.blockingLimiterId).toBe('limA');
  });
});

// ---------------------------------------------------------------------------
// cloneLimiter
// ---------------------------------------------------------------------------

describe('cloneLimiter', () => {
  it('creates a new limiter with the new id', async () => {
    await setup('mem', 'base');
    cloneLimiter('base', 'clone');
    expect(listLimiters()).toContain('clone');
    const cloned = getLimiter('clone');
    expect(cloned.groupId).toBe('clone');
  });

  it('clone has the same config as base (except id)', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('base', {
      store: 'mem',
      algorithm: 'sliding-window',
      limit: 42,
      windowSeconds: 30,
      failClosed: true,
    });
    await initializeLimiter('base');
    cloneLimiter('base', 'clone2');

    const baseConfig = getLimiter('base').getConfig();
    const cloneConfig = getLimiter('clone2').getConfig();

    expect(cloneConfig.id).toBe('clone2');
    expect(cloneConfig.algorithm).toBe(baseConfig.algorithm);
    expect(cloneConfig.limit).toBe(baseConfig.limit);
    expect(cloneConfig.windowSeconds).toBe(baseConfig.windowSeconds);
    expect(cloneConfig.failClosed).toBe(baseConfig.failClosed);
  });

  it('throws LimiterNotFoundError when base does not exist', () => {
    expect(() => cloneLimiter('nonexistent', 'clone')).toThrow(LimiterNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getOrCloneLimiter
// ---------------------------------------------------------------------------

describe('getOrCloneLimiter', () => {
  it('returns existing limiter when newId already exists', async () => {
    await setup('mem', 'lim');
    configureLimiter('lim2', { store: 'mem', algorithm: 'sliding-window', limit: 10, windowSeconds: 60 });
    await initializeLimiter('lim2');

    const existing = getLimiter('lim2');
    const result = getOrCloneLimiter('lim', 'lim2');
    expect(result).toBe(existing);
  });

  it('clones from base when newId does not exist', async () => {
    await setup('mem', 'lim');
    const cloned = getOrCloneLimiter('lim', 'lim-clone');
    expect(cloned.groupId).toBe('lim-clone');
    expect(listLimiters()).toContain('lim-clone');
  });

  it('subsequent call returns the same cloned limiter', async () => {
    await setup('mem', 'lim');
    const first = getOrCloneLimiter('lim', 'dyn');
    const second = getOrCloneLimiter('lim', 'dyn');
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// closeAll
// ---------------------------------------------------------------------------

describe('closeAll', () => {
  it('clears all stores and limiters', async () => {
    await setup('mem', 'lim');
    expect(listStores().length).toBeGreaterThan(0);
    expect(listLimiters().length).toBeGreaterThan(0);

    await closeAll();

    expect(listStores()).toHaveLength(0);
    expect(listLimiters()).toHaveLength(0);
  });

  it('resets the globalThis singleton', async () => {
    await setup('mem', 'lim');
    await closeAll();

    const g = globalThis as unknown as { __rateSyncRegistry?: unknown };
    expect(g.__rateSyncRegistry).toBeUndefined();
  });

  it('calling closeAll twice does not throw', async () => {
    await setup('mem', 'lim');
    await closeAll();
    await expect(closeAll()).resolves.toBeUndefined();
  });

  it('after closeAll(), new configureStore/configureLimiter still works', async () => {
    await setup('mem', 'lim');
    await closeAll();

    // getRegistry() should create a fresh Registry instance
    await configureStore('mem2', { engine: 'memory' });
    configureLimiter('lim2', { store: 'mem2', algorithm: 'sliding-window', limit: 5, windowSeconds: 60 });
    expect(listStores()).toContain('mem2');
    expect(listLimiters()).toContain('lim2');
  });
});
