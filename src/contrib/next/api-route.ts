import { checkLimiter, initializeLimiter, getLimiter } from '../../core/registry.js';
import { getRateLimitHeaders } from './headers.js';
import type { RateLimitResult } from '../../core/schemas.js';

type NextRequest = { headers: { get(name: string): string | null }; url: string };

export interface WithRateLimitOptions {
  limiterId: string | string[];
  keyExtractor: (req: NextRequest) => string | Promise<string>;
  failOpen?: boolean;  // default: true
  onLimitExceeded?: (req: NextRequest, result: RateLimitResult) => Response | Promise<Response>;
  onError?: (req: NextRequest, error: unknown) => void;
}

export function withRateLimit(
  handler: (req: NextRequest) => Response | Promise<Response>,
  options: WithRateLimitOptions,
): (req: NextRequest) => Promise<Response> {
  const { failOpen = true } = options;

  return async (req) => {
    let lastResult: RateLimitResult | null = null;
    let blockedResult: RateLimitResult | null = null;

    // Only the rate-limiting logic is wrapped in try/catch.
    // Handler errors must propagate normally (not be swallowed by failOpen).
    try {
      const key = await options.keyExtractor(req);
      const ids = Array.isArray(options.limiterId) ? options.limiterId : [options.limiterId];

      for (const id of ids) {
        const limiter = getLimiter(id);
        if (!limiter.isInitialized) await initializeLimiter(id);
        const result = await checkLimiter(id, key);
        lastResult = result;
        if (!result.allowed) { blockedResult = result; break; }
      }
    } catch (error) {
      if (!failOpen) throw error;
      options.onError?.(req, error);
      return handler(req);  // failOpen: skip rate limiting, call handler once
    }

    if (blockedResult) {
      if (options.onLimitExceeded) return options.onLimitExceeded(req, blockedResult);
      const headers = getRateLimitHeaders(blockedResult);
      return new Response(
        JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: `Rate limit exceeded. Retry in ${blockedResult.retryAfter}s.`, retryAfter: blockedResult.retryAfter } }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...headers } },
      );
    }

    // Handler call is OUTSIDE try/catch — errors propagate normally
    const response = await handler(req);
    if (lastResult) {
      const headers = getRateLimitHeaders(lastResult);
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(headers)) newHeaders.set(k, v);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
    }
    return response;
  };
}
