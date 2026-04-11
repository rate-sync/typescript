import type { RateLimitResult } from '../../core/schemas.js';

export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.resetAt),
  };
  if (!result.allowed) {
    headers['Retry-After'] = String(result.retryAfter);
  }
  return headers;
}

export function setRateLimitHeaders(responseHeaders: Headers, result: RateLimitResult): void {
  const headers = getRateLimitHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    responseHeaders.set(key, value);
  }
}
