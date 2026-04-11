# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-11

### Added

- Initial release
- Memory engine for single-process and development use
- Redis engine for distributed rate limiting across multiple instances
- Token bucket algorithm (default) for throughput and concurrency control
- Sliding window algorithm for fixed-window request quotas
- `RateLimiter` class with `acquire()`, `tryAcquire()`, `release()`, `using()`, and `checkLimit()` methods
- Registry API: `configureStore`, `configureLimiter`, `getLimiter`, `getStore`, `cloneLimiter`, `getOrCloneLimiter`, `listStores`, `listLimiters`, `acquire`, `checkLimiter`, `checkMultiLimiters`, `closeAll`
- `setupRateSync(configPath)` — load TOML config and initialize all limiters in one call
- `loadConfig(configPath)` — load and apply a TOML config file
- `defineConfig(config)` — type-safe programmatic config helper
- TOML configuration with `snake_case` keys auto-converted to `camelCase`
- Environment variable expansion in TOML values: `${VAR}` and `${VAR:-default}`; numeric strings auto-cast
- `hashIdentifier()` and `combineIdentifiers()` for key derivation
- Per-request rate limiting via `checkLimit(identifier?)` with per-identifier keys
- Concurrency limiting via `maxConcurrent` with `acquire()` / `release()` / `using()`
- `fail_closed` option to block requests when the store is unavailable
- `timeout` option to bound how long `tryAcquire()` waits for a slot
- `RateLimiterMetrics` with acquisition counts, wait times, concurrency high-water marks
- `RateLimitResult` and `MultiLimiterResult` with `allowed`, `limit`, `remaining`, `resetIn`, `resetAt`, `retryAfter`
- Next.js integration (`rate-sync/next`): `withRateLimit`, `withRateLimitAction`, `isRateLimitActionError`, `getClientIp`, `getRateLimitHeaders`, `setRateLimitHeaders`
- Automatic `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` headers on API route responses
- `failOpen` option on Next.js wrappers — pass requests through on store errors (default: `true`)
- `onError` callback on Next.js wrappers for logging infrastructure errors without crashing
- Testing utilities (`rate-sync/testing`): `createTestStore`, `setupTestRateSync`, `resetAllLimiters`, `resetLimiter`, `resetBackendStore`, `expectAllowed`, `expectBlocked`
- Hot-reload-safe singleton registry via `globalThis` (safe for Next.js development server)
- Dual CJS + ESM build via `tsup`; fully typed with `.d.ts` exports for all entry points
- `PostgresEngineConfig` type exported (implementation planned)
