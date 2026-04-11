import { checkLimiter, initializeLimiter, getLimiter } from '../../core/registry.js';
import { getRateLimitHeaders, setRateLimitHeaders } from './headers.js';
import type { RateLimitResult } from '../../core/schemas.js';

type NextRequest = { headers: { get(name: string): string | null }; url: string };

export interface WithRateLimitOptions {
  limiterId: string | string[];
  keyExtractor: (req: NextRequest) => string | Promise<string>;
  /**
   * Whether to allow requests when the rate-limit store is unavailable.
   * When true (default), requests pass through on store errors.
   * When false, store errors are re-thrown to the caller.
   * @defaultValue true
   */
  failOpen?: boolean;
  onLimitExceeded?: (req: NextRequest, result: RateLimitResult) => Response | Promise<Response>;
  /**
   * Called when the rate-limit check throws (e.g., Redis connection lost).
   * Only fires when failOpen is true. Use this to log infrastructure errors.
   * If not provided, errors are silently swallowed when failOpen is true.
   */
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
      const newHeaders = new Headers(response.headers);
      setRateLimitHeaders(newHeaders, lastResult);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
    }
    return response;
  };
}
