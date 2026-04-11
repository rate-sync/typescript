import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  defineConfig,
  setupRateSyncFromConfig,
} from '../../src/core/config.js';
import { listStores, listLimiters, getLimiter, closeAll } from '../../src/core/registry.js';

beforeEach(async () => {
  await closeAll();
});

afterEach(async () => {
  await closeAll();
});

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

describe('defineConfig', () => {
  it('returns the same config object (identity function)', () => {
    const config = {
      stores: { main: { engine: 'memory' as const } },
      limiters: { 'test-limiter': { store: 'main', algorithm: 'token-bucket' as const, ratePerSecond: 10 } },
    };
    expect(defineConfig(config)).toBe(config);
  });
});

// ---------------------------------------------------------------------------
// setupRateSyncFromConfig
// ---------------------------------------------------------------------------

describe('setupRateSyncFromConfig', () => {
  it('registers stores and limiters from a config object', async () => {
    await setupRateSyncFromConfig({
      stores: { 'test-store': { engine: 'memory' } },
      limiters: { test: { store: 'test-store', ratePerSecond: 10 } },
    });

    expect(listStores()).toContain('test-store');
    expect(listLimiters()).toContain('test');
    const limiter = getLimiter('test');
    expect(limiter.isInitialized).toBe(true);
  });

  it('works with a sliding-window limiter', async () => {
    await setupRateSyncFromConfig({
      stores: { 'auth-store': { engine: 'memory' } },
      limiters: {
        login: { store: 'auth-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 60 },
      },
    });

    expect(listStores()).toContain('auth-store');
    expect(listLimiters()).toContain('login');
    const limiter = getLimiter('login');
    expect(limiter.isInitialized).toBe(true);
  });

  it('resolves without error when stores and limiters are empty', async () => {
    await expect(setupRateSyncFromConfig({ stores: {}, limiters: {} })).resolves.toBeUndefined();
    expect(listStores()).toHaveLength(0);
    expect(listLimiters()).toHaveLength(0);
  });

  it('works with multiple stores and limiters', async () => {
    await setupRateSyncFromConfig({
      stores: {
        'store-a': { engine: 'memory' },
        'store-b': { engine: 'memory' },
      },
      limiters: {
        limA: { store: 'store-a', ratePerSecond: 5 },
        limB: { store: 'store-b', ratePerSecond: 50 },
      },
    });

    expect(listStores()).toContain('store-a');
    expect(listStores()).toContain('store-b');
    expect(listLimiters()).toContain('limA');
    expect(listLimiters()).toContain('limB');
    expect(getLimiter('limA').isInitialized).toBe(true);
    expect(getLimiter('limB').isInitialized).toBe(true);
  });
});
