# Rate Limiting Patterns

Common patterns for implementing rate limiting with rate-sync.

## Pattern Catalog

### Security
- [Authentication Protection](./authentication-protection.md) — Multi-layer auth endpoint protection
- [API Tiering](./api-tiering.md) — Different limits per user tier

### Application
- [API Tiering](./api-tiering.md) — Different limits for free, pro, and enterprise tiers

## Algorithm Selection

| Algorithm | Best For | Configuration |
|-----------|----------|---------------|
| **Token Bucket** | Throughput control, burst tolerance | `ratePerSecond` |
| **Sliding Window** | Exact quotas, time-based limits | `limit` + `windowSeconds` |

## Backend Selection

| Backend | Use Case |
|---------|----------|
| **Memory** | Development, testing, single process |
| **Redis** | Production, distributed systems |

## Quick Start

```toml
# rate-sync.toml
[stores.redis]
engine = "redis"
url = "${REDIS_URL}"

[limiters.api]
store = "redis"
algorithm = "token-bucket"
rate_per_second = 100
```

```typescript
import { setupRateSync, checkLimiter } from 'rate-sync';
import { getClientIp } from 'rate-sync/next';

await setupRateSync('./rate-sync.toml');

// In your handler:
const result = await checkLimiter('api', getClientIp(req));
if (!result.allowed) {
  return new Response('Too Many Requests', { status: 429 });
}
```
