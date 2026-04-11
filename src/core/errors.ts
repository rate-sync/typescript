import type { RateLimitResult } from './schemas.js';

/**
 * Base error for all rate-sync errors.
 *
 * All error classes in this library extend this base, allowing callers
 * to catch any library error with a single `instanceof RateLimiterError` check.
 */
export class RateLimiterError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = this.constructor.name;
    // Fix prototype chain for instanceof checks in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error indicating a limiter was referenced but never configured.
 *
 * This class is provided for consumers to use in their own validation logic.
 * The library itself throws LimiterNotFoundError from the registry.
 */
export class RateLimiterNotConfiguredError extends RateLimiterError {
  constructor(public readonly limiterName: string) {
    super(`Rate limiter "${limiterName}" is not configured`);
  }
}

/**
 * Thrown when a rate limiter is used before initialize() has been called.
 */
export class RateLimiterNotInitializedError extends RateLimiterError {
  constructor(public readonly limiterName?: string) {
    super(
      limiterName
        ? `Rate limiter "${limiterName}" is not initialized`
        : 'Rate limiter is not initialized',
    );
  }
}

/**
 * Thrown when the rate limiter fails to acquire a slot.
 *
 * Carries optional context about which group was attempting the acquisition
 * and how many attempts were made before giving up.
 */
export class RateLimiterAcquisitionError extends RateLimiterError {
  constructor(
    msg: string,
    public readonly groupId?: string,
    public readonly attempts?: number,
  ) {
    super(msg);
  }
}

/**
 * Thrown when attempting to configure a rate limiter that is already configured.
 *
 * Remove the existing configuration before reconfiguring.
 */
export class RateLimiterAlreadyConfiguredError extends RateLimiterError {
  constructor(public readonly limiterName: string) {
    super(`Rate limiter "${limiterName}" is already configured`);
  }
}

/**
 * Thrown when configuration validation fails.
 *
 * Provides structured context about which field failed validation,
 * what was expected, and what was actually received.
 */
export class ConfigValidationError extends RateLimiterError {
  constructor(
    msg: string,
    public readonly field?: string,
    public readonly expected?: string,
    public readonly received?: string,
  ) {
    super(msg);
  }
}

/**
 * Thrown when a store ID is referenced but no matching store has been registered.
 */
export class StoreNotFoundError extends RateLimiterError {
  constructor(public readonly storeId: string) {
    super(`Store "${storeId}" not found`);
  }
}

/**
 * Thrown when a limiter ID is referenced but no matching limiter has been registered.
 */
export class LimiterNotFoundError extends RateLimiterError {
  constructor(public readonly limiterId: string) {
    super(`Limiter "${limiterId}" not found`);
  }
}

/**
 * Error representing a rate limit violation.
 *
 * Provided as a convenience for consumers who prefer a throw-based API.
 * The library's built-in wrappers (withRateLimit, withRateLimitAction) use
 * return-based signaling instead. Use toResult() to convert to a RateLimitResult.
 *
 * @example
 * ```typescript
 * if (!result.allowed) {
 *   throw new RateLimitExceededError(userId, result.limit, result.remaining, result.resetAt, result.retryAfter);
 * }
 * ```
 */
export class RateLimitExceededError extends RateLimiterError {
  constructor(
    public readonly identifier: string,
    public readonly limit: number,
    public readonly remaining: number,
    public readonly resetAt: number,
    public readonly retryAfter: number,
    public readonly limiterId?: string,
  ) {
    super(
      `Rate limit exceeded for "${identifier}": limit ${limit}, retry after ${retryAfter}s`,
    );
  }

  /**
   * Convert this error to a RateLimitResult with allowed set to false.
   *
   * Useful for middleware that needs to return a structured result even when
   * a rate limit error was thrown rather than returned.
   *
   * @returns RateLimitResult representing the blocked request
   */
  toResult(): RateLimitResult {
    return {
      allowed: false,
      limit: this.limit,
      remaining: this.remaining,
      resetIn: this.retryAfter,
      resetAt: this.resetAt,
      retryAfter: this.retryAfter,
      limiterId: this.limiterId,
    };
  }
}
