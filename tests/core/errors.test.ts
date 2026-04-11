import { describe, it, expect } from 'vitest';
import {
  RateLimiterError,
  RateLimiterNotConfiguredError,
  RateLimiterNotInitializedError,
  RateLimiterAcquisitionError,
  RateLimiterAlreadyConfiguredError,
  ConfigValidationError,
  StoreNotFoundError,
  LimiterNotFoundError,
  RateLimitExceededError,
} from '../../src/core/errors';

describe('Error Hierarchy', () => {
  describe('RateLimiterError (base)', () => {
    it('should be an instance of Error', () => {
      const err = new RateLimiterError('base error');
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('base error');
      expect(err.name).toBe('RateLimiterError');
    });
  });

  describe('RateLimiterNotConfiguredError', () => {
    it('should extend RateLimiterError', () => {
      const err = new RateLimiterNotConfiguredError('my-limiter');
      expect(err).toBeInstanceOf(RateLimiterError);
      expect(err).toBeInstanceOf(Error);
    });

    it('should store limiterName and set proper error name', () => {
      const err = new RateLimiterNotConfiguredError('my-limiter');
      expect(err.name).toBe('RateLimiterNotConfiguredError');
      expect(err.limiterName).toBe('my-limiter');
    });
  });

  describe('RateLimiterNotInitializedError', () => {
    it('should extend RateLimiterError', () => {
      const err = new RateLimiterNotInitializedError();
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should work without limiterName', () => {
      const err = new RateLimiterNotInitializedError();
      expect(err.limiterName).toBeUndefined();
      expect(err.name).toBe('RateLimiterNotInitializedError');
    });

    it('should store optional limiterName', () => {
      const err = new RateLimiterNotInitializedError('my-limiter');
      expect(err.limiterName).toBe('my-limiter');
    });
  });

  describe('RateLimiterAcquisitionError', () => {
    it('should extend RateLimiterError', () => {
      const err = new RateLimiterAcquisitionError('failed to acquire');
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should store message, optional groupId and attempts', () => {
      const err = new RateLimiterAcquisitionError('timed out', 'group-1', 3);
      expect(err.message).toBe('timed out');
      expect(err.groupId).toBe('group-1');
      expect(err.attempts).toBe(3);
      expect(err.name).toBe('RateLimiterAcquisitionError');
    });

    it('should work without optional params', () => {
      const err = new RateLimiterAcquisitionError('error message');
      expect(err.groupId).toBeUndefined();
      expect(err.attempts).toBeUndefined();
    });
  });

  describe('RateLimiterAlreadyConfiguredError', () => {
    it('should extend RateLimiterError', () => {
      const err = new RateLimiterAlreadyConfiguredError('limiter-x');
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should store limiterName', () => {
      const err = new RateLimiterAlreadyConfiguredError('limiter-x');
      expect(err.limiterName).toBe('limiter-x');
      expect(err.name).toBe('RateLimiterAlreadyConfiguredError');
    });
  });

  describe('ConfigValidationError', () => {
    it('should extend RateLimiterError', () => {
      const err = new ConfigValidationError('invalid config');
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should store message and optional fields', () => {
      const err = new ConfigValidationError('bad value', 'ratePerSecond', 'number', 'string');
      expect(err.message).toBe('bad value');
      expect(err.field).toBe('ratePerSecond');
      expect(err.expected).toBe('number');
      expect(err.received).toBe('string');
      expect(err.name).toBe('ConfigValidationError');
    });

    it('should work without optional params', () => {
      const err = new ConfigValidationError('bad config');
      expect(err.field).toBeUndefined();
      expect(err.expected).toBeUndefined();
      expect(err.received).toBeUndefined();
    });
  });

  describe('StoreNotFoundError', () => {
    it('should extend RateLimiterError', () => {
      const err = new StoreNotFoundError('redis-store');
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should store storeId', () => {
      const err = new StoreNotFoundError('redis-store');
      expect(err.storeId).toBe('redis-store');
      expect(err.name).toBe('StoreNotFoundError');
    });
  });

  describe('LimiterNotFoundError', () => {
    it('should extend RateLimiterError', () => {
      const err = new LimiterNotFoundError('api-limiter');
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should store limiterId', () => {
      const err = new LimiterNotFoundError('api-limiter');
      expect(err.limiterId).toBe('api-limiter');
      expect(err.name).toBe('LimiterNotFoundError');
    });
  });

  describe('RateLimitExceededError', () => {
    it('should extend RateLimiterError', () => {
      const err = new RateLimitExceededError('user:123', 100, 0, 1704067210, 5);
      expect(err).toBeInstanceOf(RateLimiterError);
    });

    it('should store all constructor params', () => {
      const err = new RateLimitExceededError('user:123', 100, 0, 1704067210, 5, 'api-limiter');
      expect(err.identifier).toBe('user:123');
      expect(err.limit).toBe(100);
      expect(err.remaining).toBe(0);
      expect(err.resetAt).toBe(1704067210);
      expect(err.retryAfter).toBe(5);
      expect(err.limiterId).toBe('api-limiter');
      expect(err.name).toBe('RateLimitExceededError');
    });

    it('should work without optional limiterId', () => {
      const err = new RateLimitExceededError('user:123', 100, 0, 1704067210, 5);
      expect(err.limiterId).toBeUndefined();
    });

    it('toResult() should return a valid RateLimitResult with allowed: false', () => {
      const err = new RateLimitExceededError('user:123', 100, 0, 1704067210, 5, 'api-limiter');
      const result = err.toResult();
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(100);
      expect(result.remaining).toBe(0);
      expect(result.resetIn).toBe(5);  // retryAfter
      expect(result.resetAt).toBe(1704067210);
      expect(result.retryAfter).toBe(5);
      expect(result.limiterId).toBe('api-limiter');
    });

    it('toResult() should work without limiterId', () => {
      const err = new RateLimitExceededError('user:123', 10, 0, 1704067210, 3);
      const result = err.toResult();
      expect(result.allowed).toBe(false);
      expect(result.limiterId).toBeUndefined();
    });
  });
});
