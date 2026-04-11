// --- Result Types ---

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetIn: number;
  readonly limiterId?: string;
  readonly resetAt: number;
  readonly retryAfter: number;
}

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

export interface LimiterState {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly currentUsage: number;
}

// --- Metrics ---

export interface RateLimiterMetrics {
  totalAcquisitions: number;
  totalWaitTimeMs: number;
  avgWaitTimeMs: number;
  maxWaitTimeMs: number;
  casFailures: number;
  timeouts: number;
  lastAcquisitionAt: number | null;
  currentConcurrent: number;
  maxConcurrentReached: number;
  totalReleases: number;
}

export function createMetrics(): RateLimiterMetrics {
  return {
    totalAcquisitions: 0,
    totalWaitTimeMs: 0,
    avgWaitTimeMs: 0,
    maxWaitTimeMs: 0,
    casFailures: 0,
    timeouts: 0,
    lastAcquisitionAt: null,
    currentConcurrent: 0,
    maxConcurrentReached: 0,
    totalReleases: 0,
  };
}

// --- Config ---

export interface LimiterReadOnlyConfig {
  readonly id: string;
  readonly algorithm: string;
  readonly storeId: string;
  readonly ratePerSecond: number | null;
  readonly maxConcurrent: number | null;
  readonly timeout: number | null;
  readonly limit: number | null;
  readonly windowSeconds: number | null;
  readonly failClosed: boolean;
}

export interface MemoryEngineConfig {
  readonly engine: 'memory';
}

export interface RedisEngineConfig {
  readonly engine: 'redis';
  readonly url: string;
  readonly db?: number;
  readonly password?: string;
  readonly keyPrefix?: string;
  readonly socketTimeout?: number;
}

export interface PostgresEngineConfig {
  readonly engine: 'postgres';
  readonly connectionString: string;
  readonly tableName?: string;
  readonly schemaName?: string;
  readonly autoCreate?: boolean;
  readonly poolMin?: number;
  readonly poolMax?: number;
}

export type EngineConfig = MemoryEngineConfig | RedisEngineConfig | PostgresEngineConfig;

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

export interface RateSyncConfig {
  readonly stores: Record<string, EngineConfig>;
  readonly limiters: Record<string, LimiterConfig>;
}

// --- Factory Functions ---

export function createRateLimitResult(input: {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetIn: number;
  limiterId?: string;
}): RateLimitResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetAt = nowSeconds + Math.ceil(input.resetIn);
  const retryAfter = Math.max(1, Math.ceil(input.resetIn));

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

export function createMultiLimiterResult(results: RateLimitResult[]): MultiLimiterResult {
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
