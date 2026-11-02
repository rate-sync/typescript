# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-11-02

### Fixed

- A token-bucket limiter without `ratePerSecond` (only `maxConcurrent`) is no longer capped at 1
  request per second. The memory, node-redis and ioredis stores treated a missing `ratePerSecond`
  as 1, so a concurrency-only limiter admitted one request a second. A missing (or zero or
  negative) rate now means no rate gate, as in the Python package, and `maxConcurrent` is the only
  limit. An explicit `ratePerSecond` limits as before. Documented in `docs/configuration.md`
  ("At least one of `ratePerSecond` or `maxConcurrent` required").
- The memory store now enforces `maxConcurrent` (token bucket and sliding window) and implements
  `release()`; it used to ignore both, so a memory-backed limiter with `maxConcurrent` limited
  nothing. Slots are held until `release()` (or `using()`), exactly like the Redis stores, so code
  that sets `maxConcurrent` on a memory store must release what it acquires.
- `RateLimiter.checkLimit()` (used by the Next.js `withRateLimit` and `withRateLimitAction`) no
  longer leaks a concurrency slot per call. On a Redis store with `maxConcurrent` every check took
  a slot that nothing released, so after `maxConcurrent` calls the key was refused forever. A check
  now gives the slot back right away (it still refuses while all slots are held).
- `getState()` of a token bucket reports the free concurrency slots (`remaining`, `currentUsage`)
  in every store; `checkLimit()` reports `limit` as `maxConcurrent` for a concurrency-only limiter.

## [0.2.2] - 2026-11-02

### Changed

- No code change. First release published without any stored secret, through npm Trusted Publishing
  (OIDC) from `.github/workflows/publish.yml`, with provenance. The temporary token used for
  `0.2.1` was deleted.

## [0.2.1] - 2026-11-02

First release published to npm, as **`@rate-sync/rate-sync`**. The unscoped name `rate-sync` is refused
by npm ("Package name too similar to existing package ratesync"), so the package lives in the
`@rate-sync` organization, which matches the GitHub organization. Install with
`pnpm add @rate-sync/rate-sync` and import from `@rate-sync/rate-sync` (and
`@rate-sync/rate-sync/next`, `/redis`, `/ioredis`, `/memory`, `/testing`). The tag `v0.2.0` was
pushed first but its publish was rejected by npm, nothing was released under it; `0.2.1` carries the
same content under the final name.

### Added

- `getKeyedLimiter(baseId, identifier)` and `RateLimiter.forKey(identifier)`: the limiter for one
  caller-supplied value (user, client address, e-mail, tenant, token hash) with the id
  `"{baseId}:{identifier}"`, sharing the base limiter's store and registering nothing, so the
  registry does not grow with the number of distinct callers. The store key is the one a
  registered clone with that id uses. The base limiter is initialized once and, when the store is
  down, retried at most once per second. Same name and meaning as `ratesync.get_keyed_limiter` in
  the Python package, where the per-identifier clone pattern also leaked one connection pool per
  identifier (the TypeScript stores are shared, so only the registry grew here).
- Tag-triggered publish workflow (`.github/workflows/publish.yml`): tests against a real Redis,
  builds, and publishes with `npm publish --provenance --access public`; `RELEASING.md` documents
  it. This is the first release published to npm.

### Changed

- `cloneLimiter` and `getOrCloneLimiter` keep their contract (they register) and now document that
  they are for a small fixed set of named limiters, not for values supplied by callers.

### Fixed

- `IORedisStore` built with an externally supplied client no longer accepts `acquire()` before
  `initialize()`. The Lua commands are only defined by `initialize()`, so the call used to fail
  with an obscure "is not a function" (or, when another store had already defined them on the
  shared client, silently work); it now throws `IORedisStore not initialized`.
- The Redis store tests that need a server no longer pass silently when none is reachable: they
  are reported as skipped, and CI runs them against a Redis service. One of them asserted a
  concurrency-only refusal while the rate gate (checked first) could still apply; it now waits for
  the rate interval so the assertion exercises `maxConcurrent` alone.
- `failClosed` is now actually enforced by `RateLimiter` itself. Previously the option was
  stored on the instance and exposed via the `failClosed` getter, but `initialize()`,
  `acquire()`, `tryAcquire()`, `release()`, `checkLimit()`, and `getState()` never caught
  backend failures, so a store outage always threw the raw underlying error (or, for
  `initialize()`, silently left the limiter unusable) regardless of `failClosed`. All six
  methods now consistently throw `RateLimiterAcquisitionError` when `failClosed` is `true`,
  or log a warning and return a permissive (allow) result when `failClosed` is `false`
  (default). A failed `initialize()` with `failClosed=false` leaves the limiter in a degraded
  fail-open mode so later calls stay permissive instead of throwing
  `RateLimiterNotInitializedError`, and retries the backend on the next `initialize()` call.
  This corrects the 0.1.0 changelog entry below, which described `fail_closed` as delivered
  when only the field itself — not its enforcement — actually shipped.

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
- `failClosed` option stored on `RateLimiter` and exposed via the `failClosed` getter
  (**not enforced by `RateLimiter` itself yet at this version** — see "Unreleased" above
  for the fix; the `failOpen` option on the Next.js wrappers provided the only actual
  enforcement in 0.1.0)
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
