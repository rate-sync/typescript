import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  configureStore,
  configureLimiter,
  getLimiter,
  getKeyedLimiter,
  getStore,
  listLimiters,
  closeAll,
} from '../../src/core/registry.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { LimiterNotFoundError } from '../../src/core/errors.js';
import type { RateLimitStore } from '../../src/engines/base.js';

beforeEach(async () => {
  await closeAll();
});

afterEach(async () => {
  await closeAll();
});

async function setup(): Promise<void> {
  await configureStore('mem', { engine: 'memory' });
  configureLimiter('login', {
    store: 'mem',
    algorithm: 'sliding-window',
    limit: 2,
    windowSeconds: 60,
  });
}

describe('getKeyedLimiter', () => {
  it('returns an initialized limiter whose id is "{base}:{identifier}"', async () => {
    await setup();

    const limiter = await getKeyedLimiter('login', '1.2.3.4');

    expect(limiter.groupId).toBe('login:1.2.3.4');
    expect(limiter.isInitialized).toBe(true);
    expect(limiter.getConfig().limit).toBe(2);
    expect(limiter.getConfig().windowSeconds).toBe(60);
  });

  it('registers nothing, however many identifiers pass through', async () => {
    await setup();
    const before = listLimiters();

    for (let i = 0; i < 5000; i++) {
      await getKeyedLimiter('login', `id-${i}`);
    }

    expect(listLimiters()).toEqual(before);
  });

  it('shares the base limiter store (one connection per store, not per identifier)', async () => {
    await setup();
    const store = getStore('mem');
    const initialize = vi.spyOn(store, 'initialize');

    for (let i = 0; i < 1000; i++) {
      await getKeyedLimiter('login', `id-${i}`);
    }

    // The base is initialized once; views never reach the store's initialize()
    expect(initialize.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('gives each identifier its own budget', async () => {
    await setup();
    const a = await getKeyedLimiter('login', 'a');
    const b = await getKeyedLimiter('login', 'b');

    expect(await a.tryAcquire()).toBe(true);
    expect(await a.tryAcquire()).toBe(true);
    expect(await a.tryAcquire()).toBe(false);
    expect(await b.tryAcquire()).toBe(true);

    // a new object for the same identifier addresses the same state in the store
    expect(await (await getKeyedLimiter('login', 'a')).tryAcquire()).toBe(false);
  });

  it('addresses the same store key as a registered clone of the same id', async () => {
    await setup();
    const keys: string[] = [];
    const store = getStore('mem');
    const acquire = store.acquire.bind(store);
    vi.spyOn(store, 'acquire').mockImplementation((key, config) => {
      keys.push(key);
      return acquire(key, config);
    });

    await (await getKeyedLimiter('login', 'x:y')).tryAcquire();

    expect(keys).toEqual(['login:x:y']);
  });

  it('metrics are per returned object', async () => {
    await setup();
    const a = await getKeyedLimiter('login', 'a');
    await a.tryAcquire();

    expect(a.getMetrics().totalAcquisitions).toBe(1);
    expect(getLimiter('login').getMetrics().totalAcquisitions).toBe(0);
  });

  it('throws LimiterNotFoundError for an unknown base', async () => {
    await expect(getKeyedLimiter('nope', 'a')).rejects.toBeInstanceOf(LimiterNotFoundError);
  });

  it('does not retry a failing store on every call (fail-open outage)', async () => {
    await setup();
    const store = getStore('mem') as RateLimitStore;
    const initialize = vi.spyOn(store, 'initialize').mockRejectedValue(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 20; i++) {
      const limiter = await getKeyedLimiter('login', `id-${i}`);
      // degraded, fail-open
      expect(await limiter.tryAcquire()).toBe(true);
    }

    expect(initialize).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a view of a RateLimiter is independent of the original object', async () => {
    await setup();
    const base = getLimiter('login');
    await base.initialize();

    const view = base.forKey('a');

    expect(view).toBeInstanceOf(RateLimiter);
    expect(view).not.toBe(base);
    expect(view.groupId).toBe('login:a');
    expect(view.isInitialized).toBe(true);
  });
});
