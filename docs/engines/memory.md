# Memory Engine

In-memory rate limiting for single-process applications. Use for development, testing, or simple single-instance deployments.

## Installation

```bash
npm install rate-sync
```

No additional dependencies required.

## Quick Start

```toml
# rate-sync.toml
[stores.local]
engine = "memory"

[limiters.api]
store = "local"
rate_per_second = 10
```

```typescript
import { setupRateSync, acquire } from 'rate-sync';

await setupRateSync('./rate-sync.toml');
await acquire('api');
```

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `engine` | `string` | Required | Must be `"memory"` |

No additional configuration options. The Memory engine stores state in process memory using JavaScript `Map` objects. On-demand cleanup removes expired sliding-window entries without a background `setInterval`.

## Advanced Usage

### Programmatic Configuration

```typescript
import { configureStore, configureLimiter, initializeAllLimiters } from 'rate-sync';

await configureStore('local', { engine: 'memory' });
configureLimiter('api', { store: 'local', ratePerSecond: 10 });
await initializeAllLimiters();
```

### Development Setup with Relaxed Limits

```toml
[stores.dev]
engine = "memory"

[limiters.api]
store = "dev"
rate_per_second = 100

[limiters.auth]
store = "dev"
algorithm = "sliding-window"
limit = 100
window_seconds = 60
```

### Token Bucket (Default)

Controls throughput — allows one request every `1 / ratePerSecond` seconds:

```toml
[limiters.api]
store = "local"
rate_per_second = 10         # 10 req/sec — 1 request every 100ms
```

### Sliding Window

Counts requests in a time window:

```toml
[limiters.login]
store = "local"
algorithm = "sliding-window"
limit = 5
window_seconds = 300          # 5 attempts per 5 minutes
```

### Migration to Distributed

When ready for production, switch to Redis — only the store config changes:

```toml
# Change this:
[stores.dev]
engine = "memory"

# To this:
[stores.prod]
engine = "redis"
url = "${REDIS_URL}"

# Limiters stay the same:
[limiters.api]
store = "prod"   # ← just update the store reference
rate_per_second = 10
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
- [Configuration Guide](../configuration.md) — Full config reference
