import { checkLimiter, initializeLimiter, getLimiter } from '../../core/registry.js';

export interface RateLimitActionError {
  error: { code: 'RATE_LIMIT_EXCEEDED'; message: string; retryAfter: number; };
}

interface RateLimitActionOptions<TArgs extends any[]> {
  limiterId: string | string[];
  keyExtractor: (...args: TArgs) => string | Promise<string>;
  failOpen?: boolean;  // default: true
}

export function withRateLimitAction<TArgs extends any[], TReturn>(
  action: (...args: TArgs) => Promise<TReturn>,
  options: RateLimitActionOptions<TArgs>,
): (...args: TArgs) => Promise<TReturn | RateLimitActionError> {
  const { failOpen = true } = options;

  return async (...args) => {
    try {
      const key = await options.keyExtractor(...args);
      const ids = Array.isArray(options.limiterId) ? options.limiterId : [options.limiterId];

      for (const id of ids) {
        const limiter = getLimiter(id);
        if (!limiter.isInitialized) await initializeLimiter(id);
        const result = await checkLimiter(id, key);
        if (!result.allowed) {
          return { error: { code: 'RATE_LIMIT_EXCEEDED', message: `Too many requests. Try again in ${result.retryAfter}s.`, retryAfter: result.retryAfter } };
        }
      }
      return action(...args);
    } catch (error) {
      if (failOpen) return action(...args);
      throw error;
    }
  };
}
