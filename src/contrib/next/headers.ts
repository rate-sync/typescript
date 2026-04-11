import type { RateLimitResult } from '../../core/schemas.js';

/**
 * Get rate limit headers as a plain object.
 *
 * Returns IETF draft standard headers:
 * - `RateLimit-Limit`: maximum requests allowed in the window
 * - `RateLimit-Remaining`: requests remaining in the current window
 * - `RateLimit-Reset`: Unix timestamp (seconds) when the window resets
 *
 * When the request was blocked (`result.allowed === false`), also adds:
 * - `Retry-After`: seconds the client should wait before retrying
 *
 * @param result - The RateLimitResult from a rate limit check
 * @returns Plain object mapping header names to string values
 *
 * @example
 * ```typescript
 * const headers = getRateLimitHeaders(result);
 * return new Response(null, { status: 429, headers });
 * ```
 */
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

/**
 * Set rate limit headers directly on a Headers object.
 *
 * Convenience wrapper around getRateLimitHeaders() for use with the Web
 * Fetch API (Next.js, Cloudflare Workers, etc.) where headers are mutated
 * via the Headers interface rather than returned as a plain object.
 *
 * @param responseHeaders - The Headers instance to mutate
 * @param result - The RateLimitResult from a rate limit check
 *
 * @example
 * ```typescript
 * const response = NextResponse.next();
 * setRateLimitHeaders(response.headers, result);
 * return response;
 * ```
 */
export function setRateLimitHeaders(responseHeaders: Headers, result: RateLimitResult): void {
  const headers = getRateLimitHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    responseHeaders.set(key, value);
  }
}
