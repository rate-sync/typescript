import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/engines/memory/index.js';
import type { RateLimitStore } from '../../src/engines/base.js';

const storeFactories: [string, () => RateLimitStore][] = [
  ['memory', () => new MemoryStore()],
];

for (const [name, factory] of storeFactories) {
  describe(`Compliance: ${name}`, () => {
    let store: RateLimitStore;

    beforeEach(async () => {
      store = factory();
      await store.initialize();
    });

    afterEach(async () => {
      await store.close();
    });

    // --- Token Bucket ---

    it('allows first token-bucket request', async () => {
      const result = await store.acquire('tb:key1', {
        algorithm: 'token-bucket',
        ratePerSecond: 10,
      });
      expect(result.success).toBe(true);
      expect(result.waitMs).toBe(0);
    });

    it('blocks rapid token-bucket request', async () => {
      // First request succeeds
      await store.acquire('tb:key2', { algorithm: 'token-bucket', ratePerSecond: 1 });
      // Immediate second request should be blocked (rate = 1/s, interval = 1s)
      const result = await store.acquire('tb:key2', { algorithm: 'token-bucket', ratePerSecond: 1 });
      expect(result.success).toBe(false);
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it('isolates token-bucket keys', async () => {
      await store.acquire('tb:isolation-a', { algorithm: 'token-bucket', ratePerSecond: 1 });
      // Second request on a DIFFERENT key should still succeed
      const result = await store.acquire('tb:isolation-b', {
        algorithm: 'token-bucket',
        ratePerSecond: 1,
      });
      expect(result.success).toBe(true);
    });

    // --- Sliding Window ---

    it('allows N sliding-window requests', async () => {
      const limit = 3;
      for (let i = 0; i < limit; i++) {
        const result = await store.acquire('sw:key1', {
          algorithm: 'sliding-window',
          limit,
          windowSeconds: 60,
        });
        expect(result.success).toBe(true);
      }
    });

    it('blocks N+1 sliding-window request', async () => {
      const limit = 3;
      for (let i = 0; i < limit; i++) {
        await store.acquire('sw:key2', {
          algorithm: 'sliding-window',
          limit,
          windowSeconds: 60,
        });
      }
      const result = await store.acquire('sw:key2', {
        algorithm: 'sliding-window',
        limit,
        windowSeconds: 60,
      });
      expect(result.success).toBe(false);
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it('isolates sliding-window keys', async () => {
      const limit = 1;
      // Exhaust key-a
      await store.acquire('sw:iso-a', { algorithm: 'sliding-window', limit, windowSeconds: 60 });
      const blocked = await store.acquire('sw:iso-a', {
        algorithm: 'sliding-window',
        limit,
        windowSeconds: 60,
      });
      expect(blocked.success).toBe(false);

      // key-b should still be allowed
      const result = await store.acquire('sw:iso-b', {
        algorithm: 'sliding-window',
        limit,
        windowSeconds: 60,
      });
      expect(result.success).toBe(true);
    });

    // --- Reset ---

    it('reset clears state', async () => {
      const config = { algorithm: 'token-bucket' as const, ratePerSecond: 1 };
      // Use up the token
      await store.acquire('reset:key', config);
      // Verify it's blocked
      const blocked = await store.acquire('reset:key', config);
      expect(blocked.success).toBe(false);

      // Reset and try again
      await store.reset('reset:key');
      const result = await store.acquire('reset:key', config);
      expect(result.success).toBe(true);
    });
  });
}
