import type { RateLimitResult } from './schemas.js';

export class RateLimiterError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = this.constructor.name;
    // Fix prototype chain for instanceof checks in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RateLimiterNotConfiguredError extends RateLimiterError {
  constructor(public readonly limiterName: string) {
    super(`Rate limiter "${limiterName}" is not configured`);
  }
}

export class RateLimiterNotInitializedError extends RateLimiterError {
  constructor(public readonly limiterName?: string) {
    super(
      limiterName
        ? `Rate limiter "${limiterName}" is not initialized`
        : 'Rate limiter is not initialized',
    );
  }
}

export class RateLimiterAcquisitionError extends RateLimiterError {
  constructor(
    msg: string,
    public readonly groupId?: string,
    public readonly attempts?: number,
  ) {
    super(msg);
  }
}

export class RateLimiterAlreadyConfiguredError extends RateLimiterError {
  constructor(public readonly limiterName: string) {
    super(`Rate limiter "${limiterName}" is already configured`);
  }
}

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

export class StoreNotFoundError extends RateLimiterError {
  constructor(public readonly storeId: string) {
    super(`Store "${storeId}" not found`);
  }
}

export class LimiterNotFoundError extends RateLimiterError {
  constructor(public readonly limiterId: string) {
    super(`Limiter "${limiterId}" not found`);
  }
}

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
