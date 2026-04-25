import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { IORedisStore } from '../../src/engines/redis/ioredis-store.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY_PREFIX = 'test_ratesync_ioredis';

let store: IORedisStore;
let externalClient: IORedis;
let available = false;

beforeAll(async () => {
  externalClient = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await externalClient.connect();
    store = new IORedisStore({ client: externalClient, keyPrefix: KEY_PREFIX });
    await store.initialize();
    available = true;
  } catch {
    // Redis not available — tests will be skipped
  }
});

afterAll(async () => {
  if (available) {
    await store.close();
    await externalClient.quit();
  } else {
    externalClient.disconnect();
  }
});

describe('IORedisStore — construction', () => {
  it('throws when neither url nor client are provided', () => {
    expect(() => new IORedisStore({})).toThrow(/requires either/);
  });
});

describe('IORedisStore — lifecycle', () => {
  it('does not own externally-supplied clients', async () => {
    if (!available) return;
    // close() must not disconnect the user-owned client
    const owned = new IORedisStore({ client: externalClient, keyPrefix: KEY_PREFIX });
    await owned.initialize();
    await owned.close();
    expect(externalClient.status).toBe('ready');
  });

  it('stays usable after close() when client was externally supplied', async () => {
    if (!available) return;
    const reusable = new IORedisStore({ client: externalClient, keyPrefix: KEY_PREFIX });
    await reusable.initialize();
    await reusable.close();
    // The host application can still hand the same client around — the
    // store mustn't have nulled its reference on a no-op close().
    const result = await reusable.acquire('reuse:close', {
      algorithm: 'token-bucket',
      ratePerSecond: 100,
    });
    expect(result.success).toBe(true);
  });

  it('throws when acquire is called before initialize', async () => {
    if (!available) return;
    const uninit = new IORedisStore({ client: externalClient, keyPrefix: KEY_PREFIX });
    await expect(
      uninit.acquire('lifecycle:key', { algorithm: 'token-bucket', ratePerSecond: 10 }),
    ).rejects.toThrow('not initialized');
  });
});

describe('IORedisStore — Sliding Window', () => {
  const config = { algorithm: 'sliding-window' as const, limit: 3, windowSeconds: 5 };

  it('allows up to limit requests in the window', async () => {
    if (!available) return;
    await store.reset('sw:key1');
    const r1 = await store.acquire('sw:key1', config);
    const r2 = await store.acquire('sw:key1', config);
    const r3 = await store.acquire('sw:key1', config);
    expect(r1.success && r2.success && r3.success).toBe(true);
    expect(r3.currentCount).toBe(3);
  });

  it('rejects the (limit + 1)th request with waitMs > 0', async () => {
    if (!available) return;
    await store.reset('sw:key2');
    await store.acquire('sw:key2', config);
    await store.acquire('sw:key2', config);
    await store.acquire('sw:key2', config);
    const denied = await store.acquire('sw:key2', config);
    expect(denied.success).toBe(false);
    expect(denied.waitMs).toBeGreaterThan(0);
  });

  it('isolates state per key', async () => {
    if (!available) return;
    await store.reset('sw:keyA');
    await store.reset('sw:keyB');
    await store.acquire('sw:keyA', config);
    await store.acquire('sw:keyA', config);
    await store.acquire('sw:keyA', config);
    const denied = await store.acquire('sw:keyA', config);
    const fresh = await store.acquire('sw:keyB', config);
    expect(denied.success).toBe(false);
    expect(fresh.success).toBe(true);
  });

  it('getState reports remaining without consuming a slot', async () => {
    if (!available) return;
    await store.reset('sw:state');
    await store.acquire('sw:state', config);
    const state = await store.getState('sw:state', config);
    expect(state.allowed).toBe(true);
    expect(state.remaining).toBe(2);
    expect(state.currentUsage).toBe(1);
  });
});

describe('IORedisStore — Token Bucket', () => {
  const config = { algorithm: 'token-bucket' as const, ratePerSecond: 5 };

  it('first request succeeds with waitMs = 0', async () => {
    if (!available) return;
    await store.reset('tb:first');
    const r = await store.acquire('tb:first', config);
    expect(r.success).toBe(true);
    expect(r.waitMs).toBe(0);
  });

  it('rapid second request is denied with waitMs > 0', async () => {
    if (!available) return;
    await store.reset('tb:second');
    await store.acquire('tb:second', config);
    const denied = await store.acquire('tb:second', config);
    expect(denied.success).toBe(false);
    expect(denied.waitMs).toBeGreaterThan(0);
  });
});

describe('IORedisStore — reset', () => {
  it('clears all keys for a given identifier', async () => {
    if (!available) return;
    const config = { algorithm: 'sliding-window' as const, limit: 1, windowSeconds: 5 };
    await store.acquire('reset:victim', config);
    const denied = await store.acquire('reset:victim', config);
    expect(denied.success).toBe(false);
    await store.reset('reset:victim');
    const recovered = await store.acquire('reset:victim', config);
    expect(recovered.success).toBe(true);
  });
});
