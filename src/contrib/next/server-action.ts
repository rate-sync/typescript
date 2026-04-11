import { checkLimiter, initializeLimiter, getLimiter } from '../../core/registry.js';

export interface RateLimitActionError {
  error: { code: 'RATE_LIMIT_EXCEEDED'; message: string; retryAfter: number; };
}

export interface RateLimitActionOptions<TArgs extends unknown[]> {
  limiterId: string | string[];
  keyExtractor: (...args: TArgs) => string | Promise<string>;
  failOpen?: boolean;  // default: true
}

export function withRateLimitAction<TArgs extends unknown[], TReturn>(
  action: (...args: TArgs) => Promise<TReturn>,
  options: RateLimitActionOptions<TArgs>,
): (...args: TArgs) => Promise<TReturn | RateLimitActionError> {
  const { failOpen = true } = options;

  return async (...args) => {
    let blockedResult: { retryAfter: number } | null = null;

    // Only the rate-limiting logic is wrapped in try/catch.
    // Action errors must propagate normally (not be swallowed by failOpen).
    try {
      const key = await options.keyExtractor(...args);
      const ids = Array.isArray(options.limiterId) ? options.limiterId : [options.limiterId];

      for (const id of ids) {
        const limiter = getLimiter(id);
        if (!limiter.isInitialized) await initializeLimiter(id);
        const result = await checkLimiter(id, key);
        if (!result.allowed) {
          blockedResult = result;
          break;
        }
      }
    } catch (error) {
      if (!failOpen) throw error;
      return action(...args);  // failOpen: skip rate limiting, call action once
    }

    if (blockedResult) {
      return { error: { code: 'RATE_LIMIT_EXCEEDED', message: `Too many requests. Try again in ${blockedResult.retryAfter}s.`, retryAfter: blockedResult.retryAfter } };
    }

    // Action call is OUTSIDE try/catch — errors propagate normally
    return action(...args);
  };
}
