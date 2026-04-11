import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/engines/memory/index.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.initialize();
  });

  describe('initialize / close', () => {
    it('should initialize without throwing', async () => {
      const s = new MemoryStore();
      await expect(s.initialize()).resolves.toBeUndefined();
    });

    it('should close and clear all state without throwing', async () => {
      await store.acquire('key1', { algorithm: 'sliding-window', limit: 5, windowSeconds: 60 });
      await expect(store.close()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Token Bucket
  // ---------------------------------------------------------------------------

  describe('Token Bucket', () => {
    const config = { algorithm: 'token-bucket' as const, ratePerSecond: 1 };

    it('first request should succeed with waitMs = 0', async () => {
      const result = await store.acquire('tb:key1', config);
      expect(result.success).toBe(true);
      expect(result.waitMs).toBe(0);
    });

    it('rapid second request should fail with waitMs > 0', async () => {
      await store.acquire('tb:key2', config);
      const result = await store.acquire('tb:key2', config);
      expect(result.success).toBe(false);
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it('different keys should be isolated', async () => {
      await store.acquire('tb:keyA', config);
      // Second request on keyA should fail
      const resultA2 = await store.acquire('tb:keyA', config);
      expect(resultA2.success).toBe(false);

      // First request on keyB should succeed
      const resultB1 = await store.acquire('tb:keyB', config);
      expect(resultB1.success).toBe(true);
      expect(resultB1.waitMs).toBe(0);
    });

    it('waitMs should be close to the interval (1000ms for 1 req/s)', async () => {
      await store.acquire('tb:key3', config);
      const result = await store.acquire('tb:key3', config);
      // Should be close to 1000ms (within some tolerance for test timing)
      expect(result.waitMs).toBeGreaterThan(900);
      expect(result.waitMs).toBeLessThanOrEqual(1000);
    });

    it('after reset, a previously blocked key should succeed again', async () => {
      await store.acquire('tb:key4', config);
      const blocked = await store.acquire('tb:key4', config);
      expect(blocked.success).toBe(false);

      await store.reset('tb:key4');
      const afterReset = await store.acquire('tb:key4', config);
      expect(afterReset.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Sliding Window
  // ---------------------------------------------------------------------------

  describe('Sliding Window', () => {
    const config = { algorithm: 'sliding-window' as const, limit: 3, windowSeconds: 60 };

    it('first N requests within limit should all succeed', async () => {
      for (let i = 0; i < 3; i++) {
        const result = await store.acquire('sw:key1', config);
        expect(result.success).toBe(true);
        expect(result.waitMs).toBe(0);
      }
    });

    it('N+1 request should fail with waitMs > 0 and correct currentCount', async () => {
      for (let i = 0; i < 3; i++) {
        await store.acquire('sw:key2', config);
      }
      const result = await store.acquire('sw:key2', config);
      expect(result.success).toBe(false);
      expect(result.waitMs).toBeGreaterThan(0);
      expect(result.currentCount).toBe(3);
    });

    it('different keys should be isolated', async () => {
      // Fill keyA to the limit
      for (let i = 0; i < 3; i++) {
        await store.acquire('sw:keyA', config);
      }
      const resultA4 = await store.acquire('sw:keyA', config);
      expect(resultA4.success).toBe(false);

      // keyB should still succeed on first request
      const resultB1 = await store.acquire('sw:keyB', config);
      expect(resultB1.success).toBe(true);
    });

    it('after reset, a previously blocked key should succeed again', async () => {
      for (let i = 0; i < 3; i++) {
        await store.acquire('sw:key3', config);
      }
      const blocked = await store.acquire('sw:key3', config);
      expect(blocked.success).toBe(false);

      await store.reset('sw:key3');
      const afterReset = await store.acquire('sw:key3', config);
      expect(afterReset.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  describe('getState', () => {
    it('should return correct state for a new sliding-window key', async () => {
      const config = { algorithm: 'sliding-window' as const, limit: 5, windowSeconds: 60 };
      const state = await store.getState('gs:key1', config);
      expect(state.allowed).toBe(true);
      expect(state.remaining).toBe(5);
      expect(state.currentUsage).toBe(0);
      expect(state.resetAt).toBeGreaterThan(0);
    });

    it('should reflect usage after acquires for sliding-window', async () => {
      const config = { algorithm: 'sliding-window' as const, limit: 5, windowSeconds: 60 };
      await store.acquire('gs:key2', config);
      await store.acquire('gs:key2', config);

      const state = await store.getState('gs:key2', config);
      expect(state.currentUsage).toBe(2);
      expect(state.remaining).toBe(3);
      expect(state.allowed).toBe(true);
    });

    it('should reflect blocked state when limit reached for sliding-window', async () => {
      const config = { algorithm: 'sliding-window' as const, limit: 2, windowSeconds: 60 };
      await store.acquire('gs:key3', config);
      await store.acquire('gs:key3', config);

      const state = await store.getState('gs:key3', config);
      expect(state.allowed).toBe(false);
      expect(state.remaining).toBe(0);
      expect(state.currentUsage).toBe(2);
    });

    it('should return correct state for token-bucket', async () => {
      const config = { algorithm: 'token-bucket' as const, ratePerSecond: 2 };
      const state = await store.getState('gs:tb1', config);
      expect(state.allowed).toBe(true);
      expect(state.remaining).toBeGreaterThanOrEqual(0);
      expect(state.resetAt).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // release (no-op for P0)
  // ---------------------------------------------------------------------------

  describe('release', () => {
    it('should be a no-op and not throw', async () => {
      await store.acquire('rel:key1', {
        algorithm: 'sliding-window',
        limit: 5,
        windowSeconds: 60,
      });
      await expect(store.release('rel:key1')).resolves.toBeUndefined();
    });
  });
});
