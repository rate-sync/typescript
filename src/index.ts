// Core
export { RateLimiter } from './core/rate-limiter.js';
export type { RateLimiterOptions } from './core/rate-limiter.js';

// Registry functions
export {
  configureStore, configureLimiter, getLimiter, getStore, cloneLimiter, getOrCloneLimiter,
  listStores, listLimiters, acquire, initializeLimiter, initializeAllLimiters,
  checkLimiter, checkMultiLimiters, closeAll,
} from './core/registry.js';

// Config
export { defineConfig, setupRateSyncFromConfig } from './core/config.js';

// Identifiers
export { hashIdentifier, combineIdentifiers } from './core/identifiers.js';

// Types (re-export all)
export type {
  RateLimitResult, MultiLimiterResult, LimiterState, RateLimiterMetrics, LimiterReadOnlyConfig,
  EngineConfig, MemoryEngineConfig, RedisEngineConfig, PostgresEngineConfig, SupportedEngineConfig,
  LimiterConfig, RateSyncConfig,
} from './core/schemas.js';

// Errors
export {
  RateLimiterError, RateLimiterNotConfiguredError, RateLimiterNotInitializedError,
  RateLimiterAcquisitionError, RateLimiterAlreadyConfiguredError,
  ConfigValidationError, StoreNotFoundError, LimiterNotFoundError, RateLimitExceededError,
} from './core/errors.js';

export const version = '0.1.0';
