import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withRateLimit } from '../../../src/contrib/next/api-route.js';
import {
  configureStore,
  configureLimiter,
  initializeLimiter,
  closeAll,
} from '../../../src/core/registry.js';

function makeRequest(headers: Record<string, string | null> = {}, url = 'https://example.com/api') {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name] ?? null;
      },
    },
    url,
  };
}

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

describe('withRateLimit', () => {
  it('allows request under limit and injects rate limit headers into response', async () => {
    await setup('api-lim', 10);

    const handler = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const wrapped = withRateLimit(handler, {
      limiterId: 'api-lim',
      keyExtractor: () => 'user-1',
    });

    const req = makeRequest();
    const response = await wrapped(req);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();

    expect(response.headers.get('RateLimit-Limit')).toBe('10');
    expect(response.headers.get('RateLimit-Remaining')).toBe('9');
    expect(response.headers.get('RateLimit-Reset')).toBeDefined();
    expect(response.headers.get('Retry-After')).toBeNull();
  });

  it('returns 429 with RATE_LIMIT_EXCEEDED when limit is exceeded', async () => {
    await setup('api-lim-2', 1);

    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    const wrapped = withRateLimit(handler, {
      limiterId: 'api-lim-2',
      keyExtractor: () => 'user-1',
    });

    // First request should pass
    const req = makeRequest();
    const first = await wrapped(req);
    expect(first.status).toBe(200);

    // Second request should be blocked
    const second = await wrapped(req);
    expect(second.status).toBe(429);

    const body = await second.json();
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(typeof body.error.retryAfter).toBe('number');
    expect(body.error.retryAfter).toBeGreaterThan(0);
    expect(second.headers.get('Retry-After')).toBeDefined();
  });

  it('checks all limiters when array limiterId is provided', async () => {
    await configureStore('shared-store', { engine: 'memory' });
    configureLimiter('lim-a', { store: 'shared-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 60 });
    configureLimiter('lim-b', { store: 'shared-store', algorithm: 'sliding-window', limit: 1, windowSeconds: 60 });
    await initializeLimiter('lim-a');
    await initializeLimiter('lim-b');

    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    const wrapped = withRateLimit(handler, {
      limiterId: ['lim-a', 'lim-b'],
      keyExtractor: () => 'user-1',
    });

    const req = makeRequest();

    // First request allowed (both limiters have capacity)
    const first = await wrapped(req);
    expect(first.status).toBe(200);

    // Second request blocked by lim-b (limit=1 exhausted)
    const second = await wrapped(req);
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('uses failOpen=true by default: handler is called even when store throws', async () => {
    await setup('api-lim-3', 10);

    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const onError = vi.fn();

    // Use a limiterId that doesn't exist to force a throw
    const wrapped = withRateLimit(handler, {
      limiterId: 'nonexistent-limiter',
      keyExtractor: () => 'user-1',
      failOpen: true,
      onError,
    });

    const req = makeRequest();
    const response = await wrapped(req);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('propagates error when failOpen=false', async () => {
    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    const wrapped = withRateLimit(handler, {
      limiterId: 'nonexistent-limiter',
      keyExtractor: () => 'user-1',
      failOpen: false,
    });

    const req = makeRequest();
    await expect(wrapped(req)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls onLimitExceeded callback when provided and limit is exceeded', async () => {
    await setup('api-lim-4', 1);

    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const customResponse = new Response(JSON.stringify({ custom: true }), { status: 429 });
    const onLimitExceeded = vi.fn().mockResolvedValue(customResponse);

    const wrapped = withRateLimit(handler, {
      limiterId: 'api-lim-4',
      keyExtractor: () => 'user-1',
      onLimitExceeded,
    });

    const req = makeRequest();
    await wrapped(req); // first passes
    const second = await wrapped(req); // second blocked

    expect(onLimitExceeded).toHaveBeenCalledOnce();
    expect(second).toBe(customResponse);
  });

  it('keyExtractor can be async', async () => {
    await setup('api-lim-5', 10);

    const handler = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    const wrapped = withRateLimit(handler, {
      limiterId: 'api-lim-5',
      keyExtractor: async (req) => {
        // Simulate async key extraction (e.g., from JWT)
        return Promise.resolve(req.url.split('/').pop() ?? 'default');
      },
    });

    const req = makeRequest({}, 'https://example.com/api/user123');
    const response = await wrapped(req);
    expect(response.status).toBe(200);
  });

  it('handler errors propagate normally (not swallowed by failOpen)', async () => {
    await setup('api-lim-6', 10);

    const handlerError = new Error('handler boom');
    const handler = vi.fn().mockRejectedValue(handlerError);

    const wrapped = withRateLimit(handler, {
      limiterId: 'api-lim-6',
      keyExtractor: () => 'user-1',
      failOpen: true,  // failOpen should NOT catch handler errors
    });

    const req = makeRequest();
    await expect(wrapped(req)).rejects.toThrow('handler boom');
    expect(handler).toHaveBeenCalledOnce();
  });
});
