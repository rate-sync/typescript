import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { MemoryStore } from '../../src/engines/memory/index.js';
import { RateLimiterNotInitializedError } from '../../src/core/errors.js';

function makeStore(): MemoryStore {
  return new MemoryStore();
}

function makeLimiter(overrides: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}): RateLimiter {
  return new RateLimiter({
    id: 'test-limiter',
    store: makeStore(),
    storeId: 'mem',
    algorithm: 'token-bucket',
    ratePerSecond: 10,
    ...overrides,
  });
}

describe('RateLimiter', () => {
  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  describe('getters', () => {
    it('groupId returns the id', () => {
      const limiter = makeLimiter({ id: 'my-limiter' });
      expect(limiter.groupId).toBe('my-limiter');
    });

    it('ratePerSecond returns configured value', () => {
      const limiter = makeLimiter({ ratePerSecond: 5 });
      expect(limiter.ratePerSecond).toBe(5);
    });

    it('ratePerSecond returns null when not configured', () => {
      const limiter = makeLimiter({ ratePerSecond: undefined });
      expect(limiter.ratePerSecond).toBeNull();
    });

    it('maxConcurrent returns configured value', () => {
      const limiter = makeLimiter({ maxConcurrent: 3, ratePerSecond: undefined });
      expect(limiter.maxConcurrent).toBe(3);
    });

    it('maxConcurrent returns null when not set', () => {
      const limiter = makeLimiter();
      expect(limiter.maxConcurrent).toBeNull();
    });

    it('defaultTimeout returns configured value', () => {
      const limiter = makeLimiter({ timeout: 2000 });
      expect(limiter.defaultTimeout).toBe(2000);
    });

    it('defaultTimeout returns null when not set', () => {
      const limiter = makeLimiter();
      expect(limiter.defaultTimeout).toBeNull();
    });

    it('failClosed defaults to false', () => {
      const limiter = makeLimiter();
      expect(limiter.failClosed).toBe(false);
    });

    it('failClosed returns true when set', () => {
      const limiter = makeLimiter({ failClosed: true });
      expect(limiter.failClosed).toBe(true);
    });

    it('isInitialized is false before initialize()', () => {
      const limiter = makeLimiter();
      expect(limiter.isInitialized).toBe(false);
    });

    it('isInitialized is true after initialize()', async () => {
      const limiter = makeLimiter();
      await limiter.initialize();
      expect(limiter.isInitialized).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // initialize
  // --------------------------------------------------------------------------

  describe('initialize()', () => {
    it('resolves without error', async () => {
      const limiter = makeLimiter();
      await expect(limiter.initialize()).resolves.toBeUndefined();
    });

    it('calling initialize() twice does not throw', async () => {
      const limiter = makeLimiter();
      await limiter.initialize();
      await expect(limiter.initialize()).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // acquire / release
  // --------------------------------------------------------------------------

  describe('acquire()', () => {
    it('succeeds after initialize', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      await expect(limiter.acquire()).resolves.toBeUndefined();
    });

    it('throws RateLimiterNotInitializedError when not initialized', async () => {
      const limiter = makeLimiter();
      await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimiterNotInitializedError);
    });

    it('updates metrics after acquire', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      await limiter.acquire();
      const metrics = limiter.getMetrics();
      expect(metrics.totalAcquisitions).toBe(1);
      expect(metrics.lastAcquisitionAt).not.toBeNull();
    });
  });

  describe('tryAcquire()', () => {
    it('returns true when slot is available', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      const result = await limiter.tryAcquire();
      expect(result).toBe(true);
    });

    it('returns false when slot is unavailable (rate limited)', async () => {
      // Use ratePerSecond: 1 so second call immediately fails
      const limiter = makeLimiter({ ratePerSecond: 1 });
      await limiter.initialize();
      await limiter.tryAcquire(); // consume the token
      const result = await limiter.tryAcquire(); // should fail
      expect(result).toBe(false);
    });

    it('returns false on timeout', async () => {
      const limiter = makeLimiter({ ratePerSecond: 1 });
      await limiter.initialize();
      await limiter.tryAcquire();
      // 1ms timeout should not be enough to wait for ~1000ms
      const result = await limiter.tryAcquire(1);
      expect(result).toBe(false);
    });

    it('increments timeouts metric on failure', async () => {
      const limiter = makeLimiter({ ratePerSecond: 1 });
      await limiter.initialize();
      await limiter.tryAcquire();
      await limiter.tryAcquire(); // triggers timeout
      const metrics = limiter.getMetrics();
      expect(metrics.timeouts).toBeGreaterThanOrEqual(1);
    });

    it('throws RateLimiterNotInitializedError when not initialized', async () => {
      const limiter = makeLimiter();
      await expect(limiter.tryAcquire()).rejects.toBeInstanceOf(RateLimiterNotInitializedError);
    });
  });

  describe('release()', () => {
    it('resolves without error', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      await limiter.acquire();
      await expect(limiter.release()).resolves.toBeUndefined();
    });

    it('increments totalReleases metric', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      await limiter.acquire();
      await limiter.release();
      expect(limiter.getMetrics().totalReleases).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // using()
  // --------------------------------------------------------------------------

  describe('using()', () => {
    it('calls fn and resolves', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      let called = false;
      await limiter.using(async () => {
        called = true;
      });
      expect(called).toBe(true);
    });

    it('releases even when fn throws', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      await expect(
        limiter.using(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(limiter.getMetrics().totalReleases).toBe(1);
    });

    it('throws when tryAcquire fails within timeout', async () => {
      const limiter = makeLimiter({ ratePerSecond: 1 });
      await limiter.initialize();
      await limiter.tryAcquire(); // consume token
      await expect(
        limiter.using(async () => {}, 1),
      ).rejects.toThrow(/failed to acquire slot/);
    });
  });

  // --------------------------------------------------------------------------
  // checkLimit()
  // --------------------------------------------------------------------------

  describe('checkLimit()', () => {
    it('returns RateLimitResult with allowed=true on first call', async () => {
      const limiter = makeLimiter({
        algorithm: 'sliding-window',
        limit: 5,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();
      const result = await limiter.checkLimit();
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      expect(result.limiterId).toBe('test-limiter');
      expect(typeof result.resetAt).toBe('number');
      expect(typeof result.retryAfter).toBe('number');
    });

    it('uses namespaced key when identifier is provided', async () => {
      const limiter = makeLimiter({
        id: 'api',
        algorithm: 'sliding-window',
        limit: 2,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();

      // Two calls with same identifier
      await limiter.checkLimit('user-1');
      await limiter.checkLimit('user-1');
      const blocked = await limiter.checkLimit('user-1');
      expect(blocked.allowed).toBe(false);

      // Different identifier should still be allowed
      const other = await limiter.checkLimit('user-2');
      expect(other.allowed).toBe(true);
    });

    it('returns allowed=false when limit is exceeded', async () => {
      const limiter = makeLimiter({
        algorithm: 'sliding-window',
        limit: 1,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();
      await limiter.checkLimit();
      const result = await limiter.checkLimit();
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('throws RateLimiterNotInitializedError when not initialized', async () => {
      const limiter = makeLimiter();
      await expect(limiter.checkLimit()).rejects.toBeInstanceOf(RateLimiterNotInitializedError);
    });
  });

  // --------------------------------------------------------------------------
  // getConfig()
  // --------------------------------------------------------------------------

  describe('getConfig()', () => {
    it('returns LimiterReadOnlyConfig with all fields', () => {
      const limiter = new RateLimiter({
        id: 'cfg-limiter',
        store: makeStore(),
        storeId: 'mystore',
        algorithm: 'sliding-window',
        ratePerSecond: 5,
        maxConcurrent: 2,
        limit: 100,
        windowSeconds: 30,
        timeout: 1000,
        failClosed: true,
      });

      const config = limiter.getConfig();
      expect(config.id).toBe('cfg-limiter');
      expect(config.algorithm).toBe('sliding-window');
      expect(config.storeId).toBe('mystore');
      expect(config.ratePerSecond).toBe(5);
      expect(config.maxConcurrent).toBe(2);
      expect(config.limit).toBe(100);
      expect(config.windowSeconds).toBe(30);
      expect(config.timeout).toBe(1000);
      expect(config.failClosed).toBe(true);
    });

    it('returns null for optional fields not set', () => {
      const limiter = makeLimiter({ ratePerSecond: undefined });
      const config = limiter.getConfig();
      expect(config.ratePerSecond).toBeNull();
      expect(config.maxConcurrent).toBeNull();
      expect(config.limit).toBeNull();
      expect(config.windowSeconds).toBeNull();
      expect(config.timeout).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getState()
  // --------------------------------------------------------------------------

  describe('getState()', () => {
    it('returns LimiterState after initialize', async () => {
      const limiter = makeLimiter({
        algorithm: 'sliding-window',
        limit: 5,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();
      const state = await limiter.getState();
      expect(typeof state.allowed).toBe('boolean');
      expect(typeof state.remaining).toBe('number');
      expect(typeof state.resetAt).toBe('number');
      expect(typeof state.currentUsage).toBe('number');
    });

    it('throws when not initialized', async () => {
      const limiter = makeLimiter();
      await expect(limiter.getState()).rejects.toBeInstanceOf(RateLimiterNotInitializedError);
    });

    it('uses identifier-namespaced key when identifier is provided', async () => {
      const limiter = makeLimiter({
        id: 'api',
        algorithm: 'sliding-window',
        limit: 2,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();

      // Consume one slot for user-1
      await limiter.checkLimit('user-1');

      // getState for user-1 should reflect 1 usage
      const stateUser1 = await limiter.getState('user-1');
      expect(stateUser1.currentUsage).toBe(1);

      // getState for user-2 (no usage) should reflect 0 usage
      const stateUser2 = await limiter.getState('user-2');
      expect(stateUser2.currentUsage).toBe(0);
    });

    it('getState without identifier returns state for the limiter id key', async () => {
      const limiter = makeLimiter({
        id: 'bare',
        algorithm: 'sliding-window',
        limit: 3,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();
      await limiter.checkLimit(); // uses key = 'bare'

      const state = await limiter.getState(); // should also use key = 'bare'
      expect(state.currentUsage).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // getMetrics()
  // --------------------------------------------------------------------------

  describe('getMetrics()', () => {
    it('returns a copy of metrics (not the same reference)', async () => {
      const limiter = makeLimiter({ ratePerSecond: 100 });
      await limiter.initialize();
      const m1 = limiter.getMetrics();
      const m2 = limiter.getMetrics();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });

    it('starts with zero counts', () => {
      const limiter = makeLimiter();
      const metrics = limiter.getMetrics();
      expect(metrics.totalAcquisitions).toBe(0);
      expect(metrics.totalReleases).toBe(0);
      expect(metrics.timeouts).toBe(0);
      expect(metrics.casFailures).toBe(0);
      expect(metrics.lastAcquisitionAt).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // retry / resetState / tryAcquire with constructor timeout
  // --------------------------------------------------------------------------

  describe('acquire() retries', () => {
    it('retries when store returns success:false', async () => {
      const mockStore = {
        initialize: async () => {},
        acquire: vi.fn()
          .mockResolvedValueOnce({ success: false, waitMs: 1 })
          .mockResolvedValueOnce({ success: true, waitMs: 0 }),
        release: async () => {},
        getState: async () => ({ allowed: true, remaining: 1, resetAt: 0, currentUsage: 0 }),
        reset: async () => {},
        close: async () => {},
      };
      const limiter = new RateLimiter({ id: 'retry-test', store: mockStore as any, storeId: 'mock' });
      await limiter.initialize();
      await limiter.acquire();
      expect(mockStore.acquire).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetState()', () => {
    it('clears limiter state so requests are allowed again', async () => {
      const limiter = makeLimiter({
        algorithm: 'sliding-window',
        limit: 1,
        windowSeconds: 60,
        ratePerSecond: undefined,
      });
      await limiter.initialize();

      // Exhaust the limiter
      const first = await limiter.checkLimit();
      expect(first.allowed).toBe(true);
      const blocked = await limiter.checkLimit();
      expect(blocked.allowed).toBe(false);

      // Reset state
      await limiter.resetState();

      // Should be allowed again
      const afterReset = await limiter.checkLimit();
      expect(afterReset.allowed).toBe(true);
    });
  });

  describe('tryAcquire() with constructor timeout', () => {
    it('uses constructor timeout when no arg passed', async () => {
      // Very short timeout (1 ms) — should time out immediately when exhausted
      const limiter = makeLimiter({ ratePerSecond: 1, timeout: 1 });
      await limiter.initialize();
      await limiter.tryAcquire(); // consume the token
      const result = await limiter.tryAcquire(); // no arg — uses constructor timeout of 1ms
      expect(result).toBe(false);
    });
  });
});
