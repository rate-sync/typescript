import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../../src/engines/memory/index.js';
import { RedisStore } from '../../src/engines/redis/index.js';
import { IORedisStore } from '../../src/engines/redis/ioredis-store.js';
import type { RateLimitStore } from '../../src/engines/base.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
// A fresh prefix per store instance keeps runs (and the stores) independent of each other.
const prefix = () => `compliance_${Math.random().toString(36).slice(2, 10)}`;

// Every store must behave the same. The Redis ones are skipped (reported as skipped) when no
// server is reachable.
const storeFactories: [string, () => RateLimitStore][] = [
  ['memory', () => new MemoryStore()],
  ['redis', () => new RedisStore({ url: REDIS_URL, keyPrefix: prefix() })],
  ['ioredis', () => new IORedisStore({ url: REDIS_URL, keyPrefix: prefix() })],
];

for (const [name, factory] of storeFactories) {
  describe(`Compliance: ${name}`, () => {
    let store: RateLimitStore;
    let ready = false;

    beforeEach(async (ctx) => {
      store = factory();
      ready = false;
      try {
        await store.initialize();
        ready = true;
      } catch {
        // No server for this store: the test is reported as skipped, not passed.
        try {
          await store.close();
        } catch {
          // nothing to close
        }
        ctx.skip();
      }
    });

    afterEach(async () => {
      if (ready) await store.close();
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

    // --- Concurrency-only token bucket (no ratePerSecond means no rate gate) ---

    it('admits a burst up to maxConcurrent when no ratePerSecond is set', async () => {
      const config = { algorithm: 'token-bucket' as const, maxConcurrent: 3 };
      for (let i = 0; i < 3; i++) {
        const result = await store.acquire('cc:burst', config);
        expect(result.success).toBe(true);
      }
      const refused = await store.acquire('cc:burst', config);
      expect(refused.success).toBe(false);
      expect(refused.waitMs).toBe(0); // a concurrency refusal is not a rate wait
    });

    it('frees a concurrency slot on release', async () => {
      const config = { algorithm: 'token-bucket' as const, maxConcurrent: 1 };
      expect((await store.acquire('cc:release', config)).success).toBe(true);
      expect((await store.acquire('cc:release', config)).success).toBe(false);

      await store.release('cc:release');

      expect((await store.acquire('cc:release', config)).success).toBe(true);
    });

    it('keeps concurrency slots per key', async () => {
      const config = { algorithm: 'token-bucket' as const, maxConcurrent: 1 };
      expect((await store.acquire('cc:key-a', config)).success).toBe(true);
      expect((await store.acquire('cc:key-b', config)).success).toBe(true);
    });

    it('still rate limits when ratePerSecond is explicit', async () => {
      const config = { algorithm: 'token-bucket' as const, ratePerSecond: 1, maxConcurrent: 5 };
      expect((await store.acquire('cc:rate', config)).success).toBe(true);
      const blocked = await store.acquire('cc:rate', config);
      expect(blocked.success).toBe(false);
      expect(blocked.waitMs).toBeGreaterThan(0);
    });

    it('enforces maxConcurrent on a sliding window too', async () => {
      const config = {
        algorithm: 'sliding-window' as const,
        limit: 10,
        windowSeconds: 60,
        maxConcurrent: 2,
      };
      expect((await store.acquire('cc:sw', config)).success).toBe(true);
      expect((await store.acquire('cc:sw', config)).success).toBe(true);
      expect((await store.acquire('cc:sw', config)).success).toBe(false);
      await store.release('cc:sw');
      expect((await store.acquire('cc:sw', config)).success).toBe(true);
    });

    it('reports the free concurrency slots in getState for a concurrency-only bucket', async () => {
      const config = { algorithm: 'token-bucket' as const, maxConcurrent: 3 };
      await store.acquire('cc:state', config);
      const state = await store.getState('cc:state', config);
      expect(state.allowed).toBe(true);
      expect(state.remaining).toBe(2);
      expect(state.currentUsage).toBe(1);
    });

    it('rejects a token-bucket config with neither ratePerSecond nor maxConcurrent', async () => {
      const config = { algorithm: 'token-bucket' as const };
      await expect(store.acquire('cc:neither', config)).rejects.toThrow(/ratePerSecond or maxConcurrent/);
      await expect(store.getState('cc:neither', config)).rejects.toThrow(/ratePerSecond or maxConcurrent/);
      // a zero rate with no maxConcurrent is not a gate either
      await expect(
        store.acquire('cc:zero', { algorithm: 'token-bucket' as const, ratePerSecond: 0 }),
      ).rejects.toThrow(/ratePerSecond or maxConcurrent/);
    });

    it('leaves sliding-window configs untouched by that rule', async () => {
      const result = await store.acquire('cc:sw-ok', {
        algorithm: 'sliding-window' as const,
        limit: 1,
        windowSeconds: 60,
      });
      expect(result.success).toBe(true);
    });
  });
}
