import { createHash } from 'node:crypto';

/**
 * Hash an identifier to a fixed-length string for use as a rate limit key.
 *
 * Uses SHA-256, truncated to 16 hex characters. Useful for hashing sensitive
 * identifiers (emails, phone numbers) to avoid storing PII in rate limiter
 * keys or logs. The hash is deterministic — the same input always produces
 * the same output.
 *
 * @param identifier - The raw identifier to hash
 * @returns 16-character lowercase hex string
 *
 * @example
 * ```typescript
 * const key = combineIdentifiers(ip, hashIdentifier(email));
 * // => "192.168.1.1:a1b2c3d4e5f6g7h8"
 * ```
 */
export function hashIdentifier(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 16);
}

/**
 * Combine multiple identifier parts into a single colon-separated rate limit key.
 *
 * Empty strings are filtered out so that optional segments do not produce
 * double colons in the resulting key.
 *
 * @param parts - Variable number of identifier segments to join
 * @returns Non-empty parts joined with ':'
 *
 * @example
 * ```typescript
 * combineIdentifiers('api', userId, endpoint);
 * // => "api:user123:/payments"
 *
 * combineIdentifiers('a', '', 'b');
 * // => "a:b"
 * ```
 */
export function combineIdentifiers(...parts: string[]): string {
  return parts.filter((p) => p !== '').join(':');
}
