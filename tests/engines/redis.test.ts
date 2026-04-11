import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisStore } from '../../src/engines/redis/index.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY_PREFIX = 'test_ratesync';

let store: RedisStore;
let available = false;

beforeAll(async () => {
  store = new RedisStore({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
  try {
    await store.initialize();
    available = true;
  } catch {
    // Redis not available — tests will be skipped
  }
});

afterAll(async () => {
  if (available) {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('RedisStore — lifecycle', () => {
  it('should initialize without throwing when Redis is available', async () => {
    if (!available) return;
    // Already initialized in beforeAll — just verify no errors
    expect(available).toBe(true);
  });

  it('should throw when acquire is called before initialize', async () => {
    if (!available) return;
    const uninitStore = new RedisStore({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    await expect(
      uninitStore.acquire('lifecycle:key', { algorithm: 'token-bucket', ratePerSecond: 10 }),
    ).rejects.toThrow('not initialized');
  });

  it('calling initialize() twice does not leak a second client', async () => {
    if (!available) return;
    // Create a fresh store and initialize twice — should not throw and should
    // still work correctly (idempotency guard: if (this.client) return)
    const idempotentStore = new RedisStore({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    await idempotentStore.initialize();
    await expect(idempotentStore.initialize()).resolves.toBeUndefined();
    // Verify the store is still functional
    const result = await idempotentStore.acquire('lifecycle:idempotent', {
      algorithm: 'token-bucket',
      ratePerSecond: 100,
    });
    expect(result.success).toBe(true);
    await idempotentStore.close();
  });
});

// ---------------------------------------------------------------------------
// Token Bucket
// ---------------------------------------------------------------------------

describe('RedisStore — Token Bucket', () => {
  const config = { algorithm: 'token-bucket' as const, ratePerSecond: 1 };

  it('first request should succeed with waitMs = 0', async () => {
    if (!available) return;
    await store.reset('tb:key1');
    const result = await store.acquire('tb:key1', config);
    expect(result.success).toBe(true);
    expect(result.waitMs).toBe(0);
  });

  it('rapid second request should fail with waitMs > 0', async () => {
    if (!available) return;
    await store.reset('tb:key2');
    await store.acquire('tb:key2', config);
    const result = await store.acquire('tb:key2', config);
    expect(result.success).toBe(false);
    expect(result.waitMs).toBeGreaterThan(0);
  });

  it('waitMs should be close to interval (≈1000ms for 1 req/s)', async () => {
    if (!available) return;
    await store.reset('tb:key3');
    await store.acquire('tb:key3', config);
    const result = await store.acquire('tb:key3', config);
    // The two Redis round-trips consume some of the interval, so the remaining
    // wait will be slightly less than 1000ms. Allow a generous lower bound.
    expect(result.waitMs).toBeGreaterThan(750);
    expect(result.waitMs).toBeLessThanOrEqual(1000);
  });

  it('different keys should be isolated', async () => {
    if (!available) return;
    await store.reset('tb:keyA');
    await store.reset('tb:keyB');

    await store.acquire('tb:keyA', config);
    const resultA2 = await store.acquire('tb:keyA', config);
    expect(resultA2.success).toBe(false);

    const resultB1 = await store.acquire('tb:keyB', config);
    expect(resultB1.success).toBe(true);
    expect(resultB1.waitMs).toBe(0);
  });

  it('after reset, a previously blocked key should succeed again', async () => {
    if (!available) return;
    // Use a slower rate so the interval (2s) exceeds any Redis round-trip latency,
    // preventing the "blocked" assertion from racing with token refill.
    const slowConfig = { algorithm: 'token-bucket' as const, ratePerSecond: 0.5 };
    await store.reset('tb:key4');
    await store.acquire('tb:key4', slowConfig);
    const blocked = await store.acquire('tb:key4', slowConfig);
    expect(blocked.success).toBe(false);

    await store.reset('tb:key4');
    const afterReset = await store.acquire('tb:key4', slowConfig);
    expect(afterReset.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sliding Window
// ---------------------------------------------------------------------------

describe('RedisStore — Sliding Window', () => {
  const config = { algorithm: 'sliding-window' as const, limit: 3, windowSeconds: 60 };

  it('first N requests within limit should all succeed', async () => {
    if (!available) return;
    await store.reset('sw:key1');
    for (let i = 0; i < 3; i++) {
      const result = await store.acquire('sw:key1', config);
      expect(result.success).toBe(true);
      expect(result.waitMs).toBe(0);
    }
  });

  it('N+1 request should fail with waitMs > 0', async () => {
    if (!available) return;
    await store.reset('sw:key2');
    for (let i = 0; i < 3; i++) {
      await store.acquire('sw:key2', config);
    }
    const result = await store.acquire('sw:key2', config);
    expect(result.success).toBe(false);
    expect(result.waitMs).toBeGreaterThan(0);
  });

  it('currentCount should reflect window usage on failure', async () => {
    if (!available) return;
    await store.reset('sw:key3');
    for (let i = 0; i < 3; i++) {
      await store.acquire('sw:key3', config);
    }
    const result = await store.acquire('sw:key3', config);
    expect(result.success).toBe(false);
    expect(result.currentCount).toBe(3);
  });

  it('different keys should be isolated', async () => {
    if (!available) return;
    await store.reset('sw:keyA');
    await store.reset('sw:keyB');

    for (let i = 0; i < 3; i++) {
      await store.acquire('sw:keyA', config);
    }
    const resultA4 = await store.acquire('sw:keyA', config);
    expect(resultA4.success).toBe(false);

    const resultB1 = await store.acquire('sw:keyB', config);
    expect(resultB1.success).toBe(true);
  });

  it('after reset, a previously blocked key should succeed again', async () => {
    if (!available) return;
    await store.reset('sw:key4');
    for (let i = 0; i < 3; i++) {
      await store.acquire('sw:key4', config);
    }
    const blocked = await store.acquire('sw:key4', config);
    expect(blocked.success).toBe(false);

    await store.reset('sw:key4');
    const afterReset = await store.acquire('sw:key4', config);
    expect(afterReset.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrent limiting (maxConcurrent)
// ---------------------------------------------------------------------------

describe('RedisStore — maxConcurrent', () => {
  it('should block when maxConcurrent is reached (token-bucket)', async () => {
    if (!available) return;
    const key = 'cc:tb:key1';
    await store.reset(key);

    const config = {
      algorithm: 'token-bucket' as const,
      ratePerSecond: 100, // high rate to avoid rate-limiting interference
      maxConcurrent: 1,
    };

    const first = await store.acquire(key, config);
    expect(first.success).toBe(true);
    expect(first.concurrentCount).toBe(1);

    const second = await store.acquire(key, config);
    expect(second.success).toBe(false);
    expect(second.waitMs).toBe(0); // concurrent block returns waitMs = -1 → mapped to 0

    await store.release(key);

    await store.reset(key);
  });

  it('should allow requests after release (sliding-window)', async () => {
    if (!available) return;
    const key = 'cc:sw:key1';
    await store.reset(key);

    const config = {
      algorithm: 'sliding-window' as const,
      limit: 100, // high to avoid window interference
      windowSeconds: 60,
      maxConcurrent: 1,
    };

    const first = await store.acquire(key, config);
    expect(first.success).toBe(true);
    expect(first.concurrentCount).toBe(1);

    const second = await store.acquire(key, config);
    expect(second.success).toBe(false);

    await store.release(key);

    const third = await store.acquire(key, config);
    expect(third.success).toBe(true);

    await store.reset(key);
  });
});

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------

describe('RedisStore — getState', () => {
  it('should return correct state for a new sliding-window key', async () => {
    if (!available) return;
    await store.reset('gs:key1');
    const config = { algorithm: 'sliding-window' as const, limit: 5, windowSeconds: 60 };
    const state = await store.getState('gs:key1', config);
    expect(state.allowed).toBe(true);
    expect(state.remaining).toBe(5);
    expect(state.currentUsage).toBe(0);
    expect(state.resetAt).toBeGreaterThan(0);
  });

  it('should reflect usage after acquires for sliding-window', async () => {
    if (!available) return;
    await store.reset('gs:key2');
    const config = { algorithm: 'sliding-window' as const, limit: 5, windowSeconds: 60 };
    await store.acquire('gs:key2', config);
    await store.acquire('gs:key2', config);

    const state = await store.getState('gs:key2', config);
    expect(state.currentUsage).toBe(2);
    expect(state.remaining).toBe(3);
    expect(state.allowed).toBe(true);
  });

  it('should reflect blocked state when limit reached for sliding-window', async () => {
    if (!available) return;
    await store.reset('gs:key3');
    const config = { algorithm: 'sliding-window' as const, limit: 2, windowSeconds: 60 };
    await store.acquire('gs:key3', config);
    await store.acquire('gs:key3', config);

    const state = await store.getState('gs:key3', config);
    expect(state.allowed).toBe(false);
    expect(state.remaining).toBe(0);
    expect(state.currentUsage).toBe(2);
  });

  it('should return correct state for a new token-bucket key', async () => {
    if (!available) return;
    await store.reset('gs:tb1');
    const config = { algorithm: 'token-bucket' as const, ratePerSecond: 2 };
    const state = await store.getState('gs:tb1', config);
    expect(state.allowed).toBe(true);
    expect(state.remaining).toBe(1);
    expect(state.currentUsage).toBe(0);
    expect(state.resetAt).toBeGreaterThan(0);
  });

  it('should reflect blocked state after token-bucket acquire', async () => {
    if (!available) return;
    await store.reset('gs:tb2');
    const config = { algorithm: 'token-bucket' as const, ratePerSecond: 1 };
    await store.acquire('gs:tb2', config);

    const state = await store.getState('gs:tb2', config);
    expect(state.allowed).toBe(false);
    expect(state.remaining).toBe(0);
    expect(state.currentUsage).toBe(1);
  });
});
