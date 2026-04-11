import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestStore,
  setupTestRateSync,
  resetAllLimiters,
  resetLimiter,
  resetBackendStore,
  expectAllowed,
  expectBlocked,
} from '../../src/testing/index.js';
import {
  configureStore,
  configureLimiter,
  getLimiter,
  initializeLimiter,
  checkLimiter,
  closeAll,
  getStore,
} from '../../src/core/registry.js';
import { StoreNotFoundError } from '../../src/core/errors.js';

beforeEach(async () => {
  await closeAll();
});

afterEach(async () => {
  await closeAll();
});

// ---------------------------------------------------------------------------
// createTestStore
// ---------------------------------------------------------------------------

describe('createTestStore', () => {
  it('returns a RateLimitStore that can be initialized', async () => {
    const store = createTestStore();
    await expect(store.initialize()).resolves.toBeUndefined();
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// resetLimiter
// ---------------------------------------------------------------------------

describe('resetLimiter', () => {
  it('clears accumulated state for an initialized limiter', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('single-lim', {
      store: 'mem',
      algorithm: 'sliding-window',
      limit: 1,
      windowSeconds: 60,
    });
    await initializeLimiter('single-lim');

    // Exhaust the limiter
    const first = await checkLimiter('single-lim');
    expect(first.allowed).toBe(true);

    const blocked = await checkLimiter('single-lim');
    expect(blocked.allowed).toBe(false);

    // Reset via resetLimiter
    const limiter = getLimiter('single-lim');
    await resetLimiter(limiter);

    // Should be allowed again after reset
    const afterReset = await checkLimiter('single-lim');
    expect(afterReset.allowed).toBe(true);
  });

  it('does not throw when limiter is not initialized', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('uninit-lim', {
      store: 'mem',
      algorithm: 'sliding-window',
      limit: 5,
      windowSeconds: 60,
    });
    const limiter = getLimiter('uninit-lim');
    expect(limiter.isInitialized).toBe(false);
    // Should not throw
    await expect(resetLimiter(limiter)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resetBackendStore
// ---------------------------------------------------------------------------

describe('resetBackendStore', () => {
  it('clears all state in the store so previously blocked keys are allowed again', async () => {
    await configureStore('test-store', { engine: 'memory' });
    configureLimiter('st-lim', {
      store: 'test-store',
      algorithm: 'sliding-window',
      limit: 1,
      windowSeconds: 60,
    });
    await initializeLimiter('st-lim');

    // Use up the limit
    await checkLimiter('st-lim');
    const blocked = await checkLimiter('st-lim');
    expect(blocked.allowed).toBe(false);

    // Reset the whole backend store
    await resetBackendStore('test-store');

    // After store reset + reinitialize, limiter should allow again
    await initializeLimiter('st-lim');
    const afterReset = await checkLimiter('st-lim');
    expect(afterReset.allowed).toBe(true);
  });

  it('throws StoreNotFoundError for unknown storeId', async () => {
    await expect(resetBackendStore('nonexistent')).rejects.toThrow(StoreNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// resetAllLimiters
// ---------------------------------------------------------------------------

describe('resetAllLimiters', () => {
  it('resets all initialized limiters', async () => {
    await setupTestRateSync({
      'lim-a': { algorithm: 'sliding-window', limit: 1, windowSeconds: 60 },
      'lim-b': { algorithm: 'sliding-window', limit: 1, windowSeconds: 60 },
    });

    await initializeLimiter('lim-a');
    await initializeLimiter('lim-b');

    // Exhaust both limiters
    await checkLimiter('lim-a');
    await checkLimiter('lim-b');

    const blockedA = await checkLimiter('lim-a');
    const blockedB = await checkLimiter('lim-b');
    expect(blockedA.allowed).toBe(false);
    expect(blockedB.allowed).toBe(false);

    await resetAllLimiters();

    const afterA = await checkLimiter('lim-a');
    const afterB = await checkLimiter('lim-b');
    expect(afterA.allowed).toBe(true);
    expect(afterB.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token bucket: timestamp refresh on retry (issue 3 verification)
// ---------------------------------------------------------------------------

describe('Token bucket timestamp refresh on retry', () => {
  it('succeeds after waiting the full interval and retrying', async () => {
    await configureStore('mem', { engine: 'memory' });
    configureLimiter('tb-retry', {
      store: 'mem',
      algorithm: 'token-bucket',
      ratePerSecond: 2, // interval = 500ms
    });
    await initializeLimiter('tb-retry');

    // First request succeeds
    const first = await checkLimiter('tb-retry');
    expect(first.allowed).toBe(true);

    // Immediate second request should be blocked
    const blocked = await checkLimiter('tb-retry');
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetIn).toBeGreaterThan(0);

    // Wait for the full interval (500ms) + small buffer
    await new Promise((resolve) => setTimeout(resolve, 550));

    // Should succeed now — confirms timestamp is refreshed on each attempt
    const afterWait = await checkLimiter('tb-retry');
    expect(afterWait.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expectAllowed / expectBlocked
// ---------------------------------------------------------------------------

describe('expectAllowed', () => {
  it('resolves when the limiter allows the request', async () => {
    await setupTestRateSync({ 'ea-lim': { algorithm: 'sliding-window', limit: 5, windowSeconds: 60 } });
    await expect(expectAllowed('ea-lim')).resolves.toBeUndefined();
  });

  it('rejects when the limiter blocks the request', async () => {
    await setupTestRateSync({ 'ea-blocked': { algorithm: 'sliding-window', limit: 1, windowSeconds: 60 } });
    await initializeLimiter('ea-blocked');
    await checkLimiter('ea-blocked'); // exhaust
    await expect(expectAllowed('ea-blocked')).rejects.toThrow(/allow/);
  });
});

describe('expectBlocked', () => {
  it('resolves when the limiter blocks the request', async () => {
    await setupTestRateSync({ 'eb-lim': { algorithm: 'sliding-window', limit: 1, windowSeconds: 60 } });
    await initializeLimiter('eb-lim');
    await checkLimiter('eb-lim'); // exhaust
    await expect(expectBlocked('eb-lim')).resolves.toBeUndefined();
  });

  it('rejects when the limiter allows the request', async () => {
    await setupTestRateSync({ 'eb-open': { algorithm: 'sliding-window', limit: 5, windowSeconds: 60 } });
    await expect(expectBlocked('eb-open')).rejects.toThrow(/block/);
  });
});
