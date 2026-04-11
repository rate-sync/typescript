# Redis Engine

High-performance distributed rate limiting with atomic Lua scripts. Use for production deployments requiring coordination across multiple processes or containers.

## Compatible Versions

| Version | Status | Notes |
|---------|--------|-------|
| Redis 7.x | Recommended | Current stable, all features |
| Redis 6.x | Supported | LTS version, all features |
| Redis 5.x | Untested | May work, not in CI |

Tested in CI: Redis 6, Redis 7.

## Installation

```bash
npm install rate-sync redis
```

`redis` (node-redis v4+) is a peer dependency. If it is not installed, `configureStore` will throw when creating a Redis store.

## Quick Start

```typescript
import { defineConfig, setupRateSyncFromConfig, checkLimiter } from 'rate-sync';

const config = defineConfig({
  stores: {
    redis: { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    api: { store: 'redis', ratePerSecond: 100 },
  },
});

await setupRateSyncFromConfig(config);

const result = await checkLimiter('api', userId);
if (!result.allowed) {
  throw new Error(`Rate limited. Retry in ${result.retryAfter}s.`);
}
```

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `engine` | `string` | Required | Must be `"redis"` |
| `url` | `string` | Required | Redis connection URL |
| `db` | `number` | `undefined` | Database number (0-15) |
| `password` | `string` | `undefined` | Redis password |
| `keyPrefix` | `string` | `"rate_limit"` | Key prefix for namespacing |
| `socketTimeout` | `number` | `5000` | Socket timeout (ms) |

## Key Layout

The Redis store writes these key patterns (default prefix `rate_limit`):

| Pattern | Algorithm | Purpose |
|---------|-----------|---------|
| `rate_limit:{key}:rate` | Token Bucket | Last-allowed timestamp |
| `rate_limit:{key}:window` | Sliding Window | Sorted set of request timestamps |
| `rate_limit:{key}:concurrent` | Both | Current concurrency counter |

Use `keyPrefix` to namespace multiple applications sharing the same Redis instance:

```typescript
await configureStore('myapp', {
  engine: 'redis',
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  keyPrefix: 'myapp:rl',
});
```

## Advanced Usage

### Token Bucket (Default)

Controls throughput — allows at most `ratePerSecond` requests per second. Optionally limits parallelism with `maxConcurrent`:

```typescript
configureLimiter('api', {
  store: 'redis',
  ratePerSecond: 100,
  maxConcurrent: 50,
});
```

### Sliding Window

Counts requests in a rolling time window. Ideal for auth protection or abuse prevention:

```typescript
configureLimiter('login', {
  store: 'redis',
  algorithm: 'sliding-window',
  limit: 5,
  windowSeconds: 300,
});
```

### Production Configuration

```typescript
await configureStore('redis_prod', {
  engine: 'redis',
  url: `rediss://:${process.env.REDIS_PASSWORD}@redis.internal:6380`,
  socketTimeout: 10000,
  keyPrefix: 'myapp',
});
```

```typescript
import { configureStore, configureLimiter, initializeAllLimiters } from 'rate-sync';

await configureStore('redis', {
  engine: 'redis',
  url: 'redis://localhost:6379',
  keyPrefix: 'myapp',
  socketTimeout: 10000,
});

configureLimiter('api', {
  store: 'redis',
  ratePerSecond: 100,
  maxConcurrent: 50,
});

await initializeAllLimiters();
```

### Monitoring

```typescript
import { getLimiter } from 'rate-sync';

const metrics = getLimiter('api').getMetrics();
console.log(`Avg wait: ${metrics.avgWaitTimeMs.toFixed(2)}ms`);
console.log(`Timeouts: ${metrics.timeouts}`);
```

```bash
# List rate limiter keys
redis-cli --scan --pattern "rate_limit:*"

# Inspect a token-bucket key
redis-cli GET rate_limit:api:rate

# Count sliding-window entries
redis-cli ZCARD rate_limit:login:window
```

## Lua Scripts

The Redis engine uses atomic Lua scripts to ensure correctness under concurrent access. All reads and writes for a single rate-limit decision happen in one round-trip, eliminating TOCTOU races.

### Token Bucket Script

Evaluates on keys `{prefix}:{key}:rate` and `{prefix}:{key}:concurrent`:

```
KEYS[1] = rate key
KEYS[2] = concurrent key
ARGV[1] = now (float seconds)
ARGV[2] = interval (seconds between allowed requests)
ARGV[3] = max_concurrent (0 = disabled)
ARGV[4] = ttl (seconds)

Returns: [success, waitMs, concurrentCount]
```

Logic:
1. If `interval > 0`, check `last_time`. If `now - last_time < interval`, return denied with `waitMs`.
2. If `max_concurrent > 0`, check current counter. If at limit, return denied.
3. Update `rate key` with current timestamp, increment `concurrent key`, return allowed.

### Sliding Window Script

Evaluates on keys `{prefix}:{key}:window` (sorted set) and `{prefix}:{key}:concurrent`:

```
KEYS[1] = window key (sorted set)
KEYS[2] = concurrent key
ARGV[1] = now (float seconds)
ARGV[2] = limit (max requests)
ARGV[3] = window_seconds
ARGV[4] = max_concurrent (0 = disabled)
ARGV[5] = ttl (seconds)

Returns: [success, waitMs, concurrentCount, currentCount]
```

Logic:
1. `ZREMRANGEBYSCORE` prunes entries older than `now - window_seconds`.
2. `ZCARD` counts remaining entries.
3. If count >= limit, return denied with `waitMs` until the oldest entry expires.
4. If `max_concurrent > 0`, check counter.
5. `ZADD` the new entry with a unique member to avoid score collisions. Return allowed.

### Release Script

Decrements the concurrency counter, guarding against going below zero:

```
KEYS[1] = concurrent key
Returns: new counter value, or 0 if already at zero
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `Error: RedisStore not initialized` | `initialize()` not called | Call `initializeLimiter()` or `setupRateSyncFromConfig()` first |
| `connect ECONNREFUSED` | Redis unreachable | Check host/port, network, Redis status |
| Rate limiting too strict | Misconfiguration | Verify `ratePerSecond` and algorithm values |
| Keys never expire | Clock drift or TTL issue | Check `socketTimeout`, verify server clocks |
| High latency | Network distance | Place Redis close to application (same AZ) |

## Security

1. **Authentication**: Use `password` option or Redis ACLs (`requirepass` / `ACL SETUSER`)
2. **TLS**: Use `rediss://` protocol (Redis over TLS): `url = "rediss://:password@host:6380"`
3. **Network**: Keep Redis in a private subnet — never expose to the public internet
4. **Memory policy**: Set `maxmemory` with `allkeys-lru` so Redis evicts old rate-limit keys under memory pressure

## See Also

- [Memory Engine](memory.md) — Development alternative
- [Configuration Guide](../configuration.md) — Config reference
- [API Reference](../api-reference.md) — `configureStore`, `RedisEngineConfig`
