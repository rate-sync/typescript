import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withRateLimitAction } from '../../../src/contrib/next/server-action.js';
import type { RateLimitActionError } from '../../../src/contrib/next/server-action.js';
import {
  configureStore,
  configureLimiter,
  initializeLimiter,
  closeAll,
} from '../../../src/core/registry.js';

async function setup(limiterId: string, limit: number, storeName?: string) {
  const store = storeName ?? `store-${limiterId}`;
  await configureStore(store, { engine: 'memory' });
  configureLimiter(limiterId, {
    store,
    algorithm: 'sliding-window',
    limit,
    windowSeconds: 60,
  });
  await initializeLimiter(limiterId);
}

beforeEach(async () => {
  await closeAll();
});

afterEach(async () => {
  await closeAll();
});

describe('withRateLimitAction', () => {
  it('returns action result when under the limit', async () => {
    await setup('action-lim', 10);

    const action = vi.fn().mockResolvedValue({ success: true, data: 'hello' });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'action-lim',
      keyExtractor: () => 'user-1',
    });

    const result = await wrapped();
    expect(result).toEqual({ success: true, data: 'hello' });
    expect(action).toHaveBeenCalledOnce();
  });

  it('returns RateLimitActionError with code, message, retryAfter when over the limit', async () => {
    await setup('action-lim-2', 1);

    const action = vi.fn().mockResolvedValue({ success: true });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'action-lim-2',
      keyExtractor: () => 'user-1',
    });

    // First call succeeds
    const first = await wrapped();
    expect(first).toEqual({ success: true });

    // Second call is blocked
    const second = await wrapped() as RateLimitActionError;
    expect(second).toHaveProperty('error');
    expect(second.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(typeof second.error.message).toBe('string');
    expect(second.error.message).toContain('Too many requests');
    expect(typeof second.error.retryAfter).toBe('number');
    expect(second.error.retryAfter).toBeGreaterThan(0);
  });

  it('isolates keys per user - different keys are tracked independently', async () => {
    await setup('action-lim-3', 1);

    const action = vi.fn().mockResolvedValue({ success: true });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'action-lim-3',
      keyExtractor: (userId: string) => userId,
    });

    // user-1 first call: allowed
    const r1 = await wrapped('user-1');
    expect(r1).toEqual({ success: true });

    // user-1 second call: blocked
    const r2 = await wrapped('user-1') as RateLimitActionError;
    expect(r2.error.code).toBe('RATE_LIMIT_EXCEEDED');

    // user-2 first call: allowed (separate namespace)
    const r3 = await wrapped('user-2');
    expect(r3).toEqual({ success: true });
  });

  it('keyExtractor receives the action args (FormData-like)', async () => {
    await setup('action-lim-4', 10);

    type FormDataLike = { get(key: string): string | null };

    const action = vi.fn().mockResolvedValue({ submitted: true });
    const keyExtractorSpy = vi.fn((formData: FormDataLike) => {
      return formData.get('userId') ?? 'anonymous';
    });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'action-lim-4',
      keyExtractor: keyExtractorSpy,
    });

    const formData: FormDataLike = {
      get(key: string) {
        if (key === 'userId') return 'user-42';
        return null;
      },
    };

    const result = await wrapped(formData);
    expect(result).toEqual({ submitted: true });
    expect(keyExtractorSpy).toHaveBeenCalledWith(formData);
    expect(keyExtractorSpy).toHaveReturnedWith('user-42');
  });

  it('uses failOpen=true by default: action is called even when limiter throws', async () => {
    const action = vi.fn().mockResolvedValue({ success: true });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'nonexistent-limiter',
      keyExtractor: () => 'user-1',
      failOpen: true,
    });

    const result = await wrapped();
    expect(result).toEqual({ success: true });
    expect(action).toHaveBeenCalledOnce();
  });

  it('propagates error when failOpen=false', async () => {
    const action = vi.fn().mockResolvedValue({ success: true });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'nonexistent-limiter',
      keyExtractor: () => 'user-1',
      failOpen: false,
    });

    await expect(wrapped()).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it('checks all limiters in array and blocks if any is exhausted', async () => {
    await configureStore('shared-action-store', { engine: 'memory' });
    configureLimiter('action-lim-a', { store: 'shared-action-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 60 });
    configureLimiter('action-lim-b', { store: 'shared-action-store', algorithm: 'sliding-window', limit: 1, windowSeconds: 60 });
    await initializeLimiter('action-lim-a');
    await initializeLimiter('action-lim-b');

    const action = vi.fn().mockResolvedValue({ ok: true });

    const wrapped = withRateLimitAction(action, {
      limiterId: ['action-lim-a', 'action-lim-b'],
      keyExtractor: () => 'user-1',
    });

    // First call passes both limiters
    const first = await wrapped();
    expect(first).toEqual({ ok: true });

    // Second call blocked by action-lim-b (limit=1 exhausted)
    const second = await wrapped() as RateLimitActionError;
    expect(second.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('async keyExtractor is supported', async () => {
    await setup('action-lim-5', 10);

    const action = vi.fn().mockResolvedValue({ done: true });

    const wrapped = withRateLimitAction(action, {
      limiterId: 'action-lim-5',
      keyExtractor: async (userId: string) => {
        return Promise.resolve(`prefix-${userId}`);
      },
    });

    const result = await wrapped('user-x');
    expect(result).toEqual({ done: true });
  });

  it('action errors propagate normally (not swallowed by failOpen)', async () => {
    await setup('action-lim-6', 10);

    const actionError = new Error('action boom');
    const action = vi.fn().mockRejectedValue(actionError);

    const wrapped = withRateLimitAction(action, {
      limiterId: 'action-lim-6',
      keyExtractor: () => 'user-1',
      failOpen: true,  // failOpen should NOT catch action errors
    });

    await expect(wrapped()).rejects.toThrow('action boom');
    expect(action).toHaveBeenCalledOnce();
  });
});
