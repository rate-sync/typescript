import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRateLimitResult,
  createMultiLimiterResult,
  createMetrics,
} from '../../src/core/schemas.js';

describe('createRateLimitResult', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should set allowed, limit, remaining, resetIn, and optional limiterId', () => {
    const result = createRateLimitResult({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetIn: 10,
    });
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(99);
    expect(result.resetIn).toBe(10);
    expect(result.limiterId).toBeUndefined();
  });

  it('should include limiterId when provided', () => {
    const result = createRateLimitResult({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetIn: 5,
      limiterId: 'my-limiter',
    });
    expect(result.limiterId).toBe('my-limiter');
  });

  it('should compute resetAt as floor(Date.now()/1000) + ceil(resetIn)', () => {
    // Date.now() = 1704067200000 (2024-01-01T00:00:00.000Z)
    // floor(1704067200000 / 1000) = 1704067200
    // ceil(10.3) = 11
    // resetAt = 1704067200 + 11 = 1704067211
    const result = createRateLimitResult({
      allowed: true,
      limit: 100,
      remaining: 90,
      resetIn: 10.3,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(result.resetAt).toBe(nowSeconds + Math.ceil(10.3));
  });

  it('should compute retryAfter as max(1, ceil(resetIn))', () => {
    const result = createRateLimitResult({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetIn: 3.7,
    });
    expect(result.retryAfter).toBe(4); // ceil(3.7) = 4, max(1,4) = 4
  });

  it('should return retryAfter 0 when allowed is true', () => {
    const resultZero = createRateLimitResult({
      allowed: true,
      limit: 10,
      remaining: 10,
      resetIn: 0,
    });
    expect(resultZero.retryAfter).toBe(0);

    const resultNeg = createRateLimitResult({
      allowed: true,
      limit: 10,
      remaining: 10,
      resetIn: -5,
    });
    expect(resultNeg.retryAfter).toBe(0);
  });

  it('should compute resetAt correctly when resetIn is an integer', () => {
    const result = createRateLimitResult({
      allowed: true,
      limit: 100,
      remaining: 50,
      resetIn: 30,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(result.resetAt).toBe(nowSeconds + 30);
    expect(result.retryAfter).toBe(0); // allowed: true → retryAfter is 0
  });
});

describe('createMultiLimiterResult', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not crash and return allowed:true when called with empty array', () => {
    expect(() => createMultiLimiterResult([])).not.toThrow();
    const multi = createMultiLimiterResult([]);
    expect(multi.allowed).toBe(true);
    expect(multi.limit).toBe(0);
    expect(multi.remaining).toBe(0);
    expect(multi.resetIn).toBe(0);
    expect(multi.blockingLimiterId).toBeUndefined();
    expect(multi.results).toHaveLength(0);
    expect(multi.retryAfter).toBe(0);
    expect(multi.resetAt).toBe(Math.floor(Date.now() / 1000));
  });

  it('should be allowed when all results are allowed', () => {
    const r1 = createRateLimitResult({ allowed: true, limit: 100, remaining: 80, resetIn: 10 });
    const r2 = createRateLimitResult({ allowed: true, limit: 50, remaining: 40, resetIn: 5 });
    const multi = createMultiLimiterResult([r1, r2]);
    expect(multi.allowed).toBe(true);
    expect(multi.blockingLimiterId).toBeUndefined();
  });

  it('should be not allowed when any result is not allowed', () => {
    const r1 = createRateLimitResult({ allowed: true, limit: 100, remaining: 80, resetIn: 10 });
    const r2 = createRateLimitResult({ allowed: false, limit: 50, remaining: 0, resetIn: 5, limiterId: 'blocked-limiter' });
    const multi = createMultiLimiterResult([r1, r2]);
    expect(multi.allowed).toBe(false);
  });

  it('should set blockingLimiterId to the first blocked result limiterId', () => {
    const r1 = createRateLimitResult({ allowed: false, limit: 100, remaining: 0, resetIn: 10, limiterId: 'first-blocked' });
    const r2 = createRateLimitResult({ allowed: false, limit: 50, remaining: 0, resetIn: 5, limiterId: 'second-blocked' });
    const r3 = createRateLimitResult({ allowed: true, limit: 20, remaining: 10, resetIn: 2 });
    const multi = createMultiLimiterResult([r1, r2, r3]);
    expect(multi.blockingLimiterId).toBe('first-blocked');
  });

  it('should pick most restrictive (lowest remaining) for limit, remaining, resetIn', () => {
    const r1 = createRateLimitResult({ allowed: true, limit: 100, remaining: 80, resetIn: 10 });
    const r2 = createRateLimitResult({ allowed: true, limit: 50, remaining: 30, resetIn: 20 });
    const r3 = createRateLimitResult({ allowed: true, limit: 200, remaining: 150, resetIn: 5 });
    const multi = createMultiLimiterResult([r1, r2, r3]);
    // r2 has lowest remaining (30)
    expect(multi.remaining).toBe(30);
    expect(multi.limit).toBe(50);
    expect(multi.resetIn).toBe(20);
  });

  it('should include all results in the results array', () => {
    const r1 = createRateLimitResult({ allowed: true, limit: 100, remaining: 80, resetIn: 10 });
    const r2 = createRateLimitResult({ allowed: true, limit: 50, remaining: 40, resetIn: 5 });
    const multi = createMultiLimiterResult([r1, r2]);
    expect(multi.results).toHaveLength(2);
    expect(multi.results[0]).toBe(r1);
    expect(multi.results[1]).toBe(r2);
  });

  it('should compute resetAt and retryAfter from the most restrictive result', () => {
    const r1 = createRateLimitResult({ allowed: true, limit: 100, remaining: 80, resetIn: 10 });
    const r2 = createRateLimitResult({ allowed: true, limit: 50, remaining: 30, resetIn: 20 });
    const multi = createMultiLimiterResult([r1, r2]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(multi.resetAt).toBe(nowSeconds + 20);
    // Both results are allowed, so retryAfter is 0 on each; multi inherits 0
    expect(multi.retryAfter).toBe(0);
  });
});

describe('createMetrics', () => {
  it('should create metrics with all zeros and null values', () => {
    const metrics = createMetrics();
    expect(metrics.totalAcquisitions).toBe(0);
    expect(metrics.totalWaitTimeMs).toBe(0);
    expect(metrics.avgWaitTimeMs).toBe(0);
    expect(metrics.maxWaitTimeMs).toBe(0);
    expect(metrics.timeouts).toBe(0);
    expect(metrics.lastAcquisitionAt).toBeNull();
    expect(metrics.currentConcurrent).toBe(0);
    expect(metrics.maxConcurrentReached).toBe(0);
    expect(metrics.totalReleases).toBe(0);
  });
});
