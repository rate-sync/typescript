// --- Result Types ---

/**
 * Result of a rate limit check.
 *
 * Contains whether the request was allowed and the current state
 * of the rate limiter for the client.
 */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetIn: number;
  readonly limiterId?: string;
  readonly resetAt: number;
  readonly retryAfter: number;
}

/**
 * Result of checking multiple rate limiters.
 *
 * When checking multiple limiters (e.g., per-IP and per-user), this result
 * contains the most restrictive outcome along with details from all limiters.
 */
export interface MultiLimiterResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetIn: number;
  readonly blockingLimiterId?: string;
  readonly results: readonly RateLimitResult[];
  readonly resetAt: number;
  readonly retryAfter: number;
}

/**
 * Current state snapshot of a rate limiter.
 *
 * Provides the current state without consuming any slots.
 * Useful for client-side UX (e.g., showing "3 attempts remaining")
 * and observability.
 */
export interface LimiterState {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly currentUsage: number;
}

// --- Metrics ---

/**
 * Observability metrics collected by a rate limiter.
 *
 * Tracks acquisition counts, wait times, and concurrency statistics
 * for monitoring and alerting.
 */
export interface RateLimiterMetrics {
  totalAcquisitions: number;
  totalWaitTimeMs: number;
  avgWaitTimeMs: number;
  maxWaitTimeMs: number;
  timeouts: number;
  lastAcquisitionAt: number | null;
  currentConcurrent: number;
  maxConcurrentReached: number;
  totalReleases: number;
}

/**
 * Create a zeroed-out metrics object.
 *
 * @returns Fresh RateLimiterMetrics with all counters initialised to zero.
 */
export function createMetrics(): RateLimiterMetrics {
  return {
    totalAcquisitions: 0,
    totalWaitTimeMs: 0,
    avgWaitTimeMs: 0,
    maxWaitTimeMs: 0,
    timeouts: 0,
    lastAcquisitionAt: null,
    currentConcurrent: 0,
    maxConcurrentReached: 0,
    totalReleases: 0,
  };
}

// --- Config ---

/**
 * Read-only configuration snapshot of a rate limiter.
 *
 * Provides a read-only view of a limiter's configuration, useful for
 * introspection and debugging. Obtain via RateLimiter.getConfig().
 */
export interface LimiterReadOnlyConfig {
  readonly id: string;
  readonly algorithm: 'token-bucket' | 'sliding-window';
  readonly storeId: string;
  readonly ratePerSecond: number | null;
  readonly maxConcurrent: number | null;
  readonly timeout: number | null;
  readonly limit: number | null;
  readonly windowSeconds: number | null;
  readonly failClosed: boolean;
}

/**
 * Configuration for the in-memory rate limiting engine.
 *
 * This engine uses local process memory and does not coordinate across
 * processes. Suitable for development, testing, or single-process deployments.
 */
export interface MemoryEngineConfig {
  readonly engine: 'memory';
}

/**
 * Configuration for the Redis-backed rate limiting engine.
 *
 * Uses Redis for distributed coordination across processes and containers.
 * Requires Redis 5.0+ for Lua script support.
 */
export interface RedisEngineConfig {
  readonly engine: 'redis';
  readonly url: string;
  readonly db?: number;
  readonly password?: string;
  readonly keyPrefix?: string;
  readonly socketTimeout?: number;
}

/**
 * Configuration for the PostgreSQL-backed rate limiting engine.
 *
 * Uses PostgreSQL for distributed coordination. Requires PostgreSQL 12+
 * for proper advisory lock support.
 */
export interface PostgresEngineConfig {
  readonly engine: 'postgres';
  readonly connectionString: string;
  readonly tableName?: string;
  readonly schemaName?: string;
  readonly autoCreate?: boolean;
  readonly poolMin?: number;
  readonly poolMax?: number;
}

/** Union of all supported engine configuration types. */
export type EngineConfig = MemoryEngineConfig | RedisEngineConfig | PostgresEngineConfig;

/** Union of engine configurations supported in the current release. */
export type SupportedEngineConfig = MemoryEngineConfig | RedisEngineConfig;

/**
 * Configuration for a single rate limiter.
 *
 * Supports two algorithms:
 * - **token-bucket** (default): Controls throughput using ratePerSecond.
 * - **sliding-window**: Counts requests in a time window using limit/windowSeconds.
 *
 * At least one limiting strategy must be specified for the chosen algorithm.
 */
export interface LimiterConfig {
  readonly store: string;
  readonly algorithm?: 'token-bucket' | 'sliding-window';
  readonly ratePerSecond?: number;
  readonly maxConcurrent?: number;
  readonly limit?: number;
  readonly windowSeconds?: number;
  readonly timeout?: number;
  readonly failClosed?: boolean;
}

/**
 * Top-level declarative configuration for the rate-sync library.
 *
 * Defines all stores and limiters in a single object that can be loaded
 * from a YAML/JSON config file or constructed programmatically.
 *
 * @example
 * ```typescript
 * const config: RateSyncConfig = {
 *   stores: { redis: { engine: 'redis', url: 'redis://localhost:6379' } },
 *   limiters: { api: { store: 'redis', ratePerSecond: 100 } },
 * };
 * ```
 */
export interface RateSyncConfig {
  readonly stores: Record<string, EngineConfig>;
  readonly limiters: Record<string, LimiterConfig>;
}

// --- Factory Functions ---

/**
 * Create a RateLimitResult with computed resetAt and retryAfter.
 *
 * Calculates resetAt as the current Unix timestamp plus resetIn (rounded up),
 * and retryAfter as zero when the request was allowed or at least one second
 * when it was blocked.
 *
 * @param input - Result input with allowed, limit, remaining, resetIn, and optional limiterId
 * @returns Immutable RateLimitResult with all computed fields populated
 */
export function createRateLimitResult(input: {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetIn: number;
  limiterId?: string;
}): RateLimitResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetAt = nowSeconds + Math.ceil(input.resetIn);
  const retryAfter = input.allowed ? 0 : Math.max(1, Math.ceil(input.resetIn));

  return {
    allowed: input.allowed,
    limit: input.limit,
    remaining: input.remaining,
    resetIn: input.resetIn,
    limiterId: input.limiterId,
    resetAt,
    retryAfter,
  };
}

/**
 * Create a MultiLimiterResult from a list of individual RateLimitResults.
 *
 * Determines the most restrictive outcome:
 * - allowed: true only if ALL limiters allow the request
 * - limit/remaining/resetIn: values from the limiter with the lowest remaining count
 * - blockingLimiterId: ID of the first limiter that blocked (if any)
 *
 * @param results - Array of RateLimitResult from each limiter checked
 * @returns Combined MultiLimiterResult reflecting the most restrictive limiter
 */
export function createMultiLimiterResult(results: RateLimitResult[]): MultiLimiterResult {
  if (results.length === 0) {
    return {
      allowed: true,
      limit: 0,
      remaining: 0,
      resetIn: 0,
      blockingLimiterId: undefined,
      results: [],
      resetAt: Math.floor(Date.now() / 1000),
      retryAfter: 0,
    };
  }

  const allowed = results.every((r) => r.allowed);

  // Find most restrictive: the result with lowest remaining
  const mostRestrictive = results.reduce((prev, curr) =>
    curr.remaining < prev.remaining ? curr : prev,
  );

  const blockingLimiterId = results.find((r) => !r.allowed)?.limiterId;

  return {
    allowed,
    limit: mostRestrictive.limit,
    remaining: mostRestrictive.remaining,
    resetIn: mostRestrictive.resetIn,
    blockingLimiterId,
    results,
    resetAt: mostRestrictive.resetAt,
    retryAfter: mostRestrictive.retryAfter,
  };
}
