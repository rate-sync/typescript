import { describe, it, expect } from 'vitest';
import { getRateLimitHeaders, setRateLimitHeaders } from '../../../src/contrib/next/headers.js';
import type { RateLimitResult } from '../../../src/core/schemas.js';

function makeResult(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return {
    allowed: true,
    limit: 100,
    remaining: 99,
    resetIn: 60,
    resetAt: Math.floor(Date.now() / 1000) + 60,
    retryAfter: 60,
    limiterId: 'test',
    ...overrides,
  };
}

describe('getRateLimitHeaders', () => {
  it('returns RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset for allowed request', () => {
    const result = makeResult({ allowed: true, limit: 100, remaining: 99 });
    const headers = getRateLimitHeaders(result);

    expect(headers['RateLimit-Limit']).toBe('100');
    expect(headers['RateLimit-Remaining']).toBe('99');
    expect(headers['RateLimit-Reset']).toBe(String(result.resetAt));
  });

  it('does NOT include Retry-After when allowed', () => {
    const result = makeResult({ allowed: true });
    const headers = getRateLimitHeaders(result);
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('adds Retry-After when request is blocked (allowed=false)', () => {
    const result = makeResult({ allowed: false, remaining: 0, retryAfter: 42 });
    const headers = getRateLimitHeaders(result);

    expect(headers['Retry-After']).toBe('42');
  });

  it('includes all standard headers when blocked', () => {
    const result = makeResult({ allowed: false, limit: 10, remaining: 0, retryAfter: 30 });
    const headers = getRateLimitHeaders(result);

    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['RateLimit-Remaining']).toBe('0');
    expect(headers['RateLimit-Reset']).toBeDefined();
    expect(headers['Retry-After']).toBe('30');
  });

  it('returns string values for all header fields', () => {
    const result = makeResult({ allowed: true, limit: 50, remaining: 25 });
    const headers = getRateLimitHeaders(result);

    for (const value of Object.values(headers)) {
      expect(typeof value).toBe('string');
    }
  });
});

describe('setRateLimitHeaders', () => {
  it('sets all rate limit headers on a Headers object for allowed request', () => {
    const result = makeResult({ allowed: true, limit: 100, remaining: 99 });
    const responseHeaders = new Headers();
    setRateLimitHeaders(responseHeaders, result);

    expect(responseHeaders.get('RateLimit-Limit')).toBe('100');
    expect(responseHeaders.get('RateLimit-Remaining')).toBe('99');
    expect(responseHeaders.get('RateLimit-Reset')).toBe(String(result.resetAt));
  });

  it('sets Retry-After on Headers object when blocked', () => {
    const result = makeResult({ allowed: false, remaining: 0, retryAfter: 15 });
    const responseHeaders = new Headers();
    setRateLimitHeaders(responseHeaders, result);

    expect(responseHeaders.get('Retry-After')).toBe('15');
  });

  it('does not set Retry-After on Headers object when allowed', () => {
    const result = makeResult({ allowed: true });
    const responseHeaders = new Headers();
    setRateLimitHeaders(responseHeaders, result);

    expect(responseHeaders.get('Retry-After')).toBeNull();
  });
});
