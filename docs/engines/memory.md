# Memory Engine

In-memory rate limiting for single-process applications. Use for development, testing, or simple single-instance deployments.

## Installation

```bash
npm install @rate-sync/rate-sync
```

No additional dependencies required.

## Quick Start

```typescript
import { defineConfig, setupRateSyncFromConfig, acquire } from '@rate-sync/rate-sync';

const config = defineConfig({
  stores: { local: { engine: 'memory' } },
  limiters: { 'public-api': { store: 'local', ratePerSecond: 10 } },
});

await setupRateSyncFromConfig(config);
await acquire('public-api');
```

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `engine` | `string` | Required | Must be `"memory"` |

No additional configuration options. The Memory engine stores state in process memory using JavaScript `Map` objects. On-demand cleanup removes expired sliding-window entries without a background `setInterval`.

## Advanced Usage

### Programmatic Configuration

```typescript
import { configureStore, configureLimiter, initializeAllLimiters } from '@rate-sync/rate-sync';

await configureStore('local', { engine: 'memory' });
configureLimiter('public-api', { store: 'local', ratePerSecond: 10 });
await initializeAllLimiters();
```

### Development Setup with Relaxed Limits

```typescript
export default defineConfig({
  stores: { dev: { engine: 'memory' } },
  limiters: {
    'public-api': { store: 'dev', ratePerSecond: 100 },
    auth: { store: 'dev', algorithm: 'sliding-window', limit: 100, windowSeconds: 60 },
  },
});
```

### Token Bucket (Default)

Controls throughput — allows one request every `1 / ratePerSecond` seconds:

```typescript
configureLimiter('public-api', {
  store: 'local',
  ratePerSecond: 10, // 10 req/sec — 1 request every 100ms
});
```

With `maxConcurrent` the memory store also caps in-flight requests per key (free a slot with `release()`, or use `using()`). A limiter with `maxConcurrent` and no `ratePerSecond` has no rate gate:

```typescript
configureLimiter('uploads', { store: 'local', maxConcurrent: 3 }); // up to 3 at once
```

### Sliding Window

Counts requests in a time window:

```typescript
configureLimiter('login', {
  store: 'local',
  algorithm: 'sliding-window',
  limit: 5,
  windowSeconds: 300, // 5 attempts per 5 minutes
});
```

### Migration to Distributed

When ready for production, switch to Redis — only the store config changes:

```typescript
// Change this:
stores: { dev: { engine: 'memory' } }

// To this:
stores: { prod: { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' } }

// Limiters stay the same — just update the store reference:
limiters: { 'public-api': { store: 'prod', ratePerSecond: 10 } }
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Rate limits not shared across workers | Memory engine is per-process | Use Redis for multi-process deployments |
| Limits reset on restart | State is not persisted | Expected; use Redis if persistence is needed |
| High memory usage | Too many unique limiter keys | Review key strategy; consider cleanup with `resetState()` |

## Limitations

- Single process only — no coordination across workers or containers
- State lost on process restart
- Not suitable for distributed or serverless deployments

## See Also

- [Redis Engine](redis.md) — Recommended for production
- [Configuration Guide](../configuration.md) — Config reference
