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

```typescript
// rate-sync.config.ts
import { defineConfig } from '@rate-sync/rate-sync';

export default defineConfig({
  stores: {
    'main-store': { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    'public-api': { store: 'main-store', algorithm: 'token-bucket', ratePerSecond: 100 },
  },
});
```

```typescript
import { setupRateSyncFromConfig, checkLimiter } from '@rate-sync/rate-sync';
import { getClientIp } from '@rate-sync/rate-sync/next';
import config from './rate-sync.config';

await setupRateSyncFromConfig(config);

// In your handler:
const result = await checkLimiter('public-api', getClientIp(req));
if (!result.allowed) {
  return new Response('Too Many Requests', { status: 429 });
}
```
