# Configuration Guide

rate-sync supports TypeScript config files (recommended) or direct programmatic setup.

## Configuration Methods

| Method | TypeScript Config | Programmatic |
|--------|-------------------|--------------|
| Type-safe | Yes | Yes |
| Environment variable expansion | Via `process.env` | Via code |
| Runtime modification | No | Yes |
| Best for | TypeScript projects | Dynamic config |

## TypeScript Configuration (Recommended)

This is the standard approach for TypeScript projects — the same pattern used by Vite, Drizzle ORM, and other modern tools.

### Basic Structure

```typescript
// rate-sync.config.ts
import { defineConfig } from '@rate-sync/rate-sync';

export default defineConfig({
  // Stores define HOW rate limiting is coordinated
  stores: {
    local: { engine: 'memory' },
  },
  // Limiters define WHAT to rate limit
  limiters: {
    'public-api': { store: 'local', ratePerSecond: 10 },
  },
});
```

### Initializing from Config

```typescript
// instrumentation.ts (or your app entry point)
import config from './rate-sync.config';
import { setupRateSyncFromConfig } from '@rate-sync/rate-sync';

await setupRateSyncFromConfig(config);
```

### Production Example

```typescript
// rate-sync.config.ts
import { defineConfig } from '@rate-sync/rate-sync';

export default defineConfig({
  stores: {
    'primary-store': {
      engine: 'redis',
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      keyPrefix: 'myapp:ratelimit',
    },
  },
  limiters: {
    'public-api': { store: 'primary-store', ratePerSecond: 1000, maxConcurrent: 200, timeout: 30000 },
    login: { store: 'primary-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 300 },
  },
});
```

---

## Low-Level Programmatic Configuration

```typescript
import { configureStore, configureLimiter, initializeAllLimiters } from '@rate-sync/rate-sync';

await configureStore('local', { engine: 'memory' });
configureLimiter('public-api', { store: 'local', ratePerSecond: 10 });
await initializeAllLimiters();
```

---

## Stores Configuration

### Memory Engine

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `engine` | `string` | Required | `"memory"` |

```typescript
await configureStore('dev', { engine: 'memory' });
```

### Redis Engine

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `engine` | `string` | Required | `"redis"` |
| `url` | `string` | Required | Connection URL |
| `db` | `number` | `undefined` | Database number (0-15) |
| `password` | `string` | `undefined` | Auth password |
| `keyPrefix` | `string` | `"rate_limit"` | Key namespace |
| `socketTimeout` | `number` | `5000` | Socket timeout (ms) |

```typescript
await configureStore('prod', {
  engine: 'redis',
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  keyPrefix: 'myapp:ratelimit',
  socketTimeout: 10000,
});
```

---

## Limiters Configuration

### Common Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `string` | Required | Store ID to use |
| `algorithm` | `string` | `"token-bucket"` | Algorithm type |
| `timeout` | `number` | `undefined` | Default timeout (ms) |
| `failClosed` | `boolean` | `false` | Block on backend failure |

### Token Bucket Algorithm

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ratePerSecond` | `number` | `undefined` | Max operations/sec |
| `maxConcurrent` | `number` | `undefined` | Max simultaneous ops |

At least one of `ratePerSecond` or `maxConcurrent` required (a positive number): a token bucket with neither is refused with a `ConfigValidationError` when the limiter is created, because it would not limit anything. A limiter with only `maxConcurrent` has no rate gate (same as the Python package): it admits requests up to `maxConcurrent` in flight at once and refuses the next until one is released with `release()` (or use `using()`). Setting `ratePerSecond` adds a throughput limit on top. `checkLimit()` (and so the Next.js helpers) checks the concurrency ceiling but does not hold a slot.

```typescript
configureLimiter('public-api', {
  store: 'prod',
  ratePerSecond: 100,
  maxConcurrent: 50,
  timeout: 30000,
});
```

### Sliding Window Algorithm

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | Required | Max requests in window |
| `windowSeconds` | `number` | Required | Window size (sec) |

Supported by both Memory and Redis engines.

```typescript
configureLimiter('login', {
  store: 'prod',
  algorithm: 'sliding-window',
  limit: 5,
  windowSeconds: 300,
});
```

---

## Configuration Recipes

### Development Setup

```typescript
export default defineConfig({
  stores: { dev: { engine: 'memory' } },
  limiters: { 'public-api': { store: 'dev', ratePerSecond: 100 } },
});
```

### Production Setup

```typescript
export default defineConfig({
  stores: {
    'primary-store': { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    'public-api': { store: 'primary-store', ratePerSecond: 1000, maxConcurrent: 200, timeout: 30000 },
    partner_api: { store: 'primary-store', ratePerSecond: 10, timeout: 60000, failClosed: true },
    login: { store: 'primary-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 300 },
  },
});
```

### Multi-Tenant Setup

```typescript
export default defineConfig({
  stores: {
    'session-store': { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    tenant_base: { store: 'session-store', ratePerSecond: 10 },
    tenant_premium: { store: 'session-store', ratePerSecond: 100 },
  },
});
```

```typescript
import { getOrCloneLimiter } from '@rate-sync/rate-sync';

// Get or create a per-tenant limiter cloned from 'tenant_base'
const limiter = getOrCloneLimiter('tenant_base', `tenant:${tenantId}`);
await limiter.initialize();
const result = await limiter.checkLimit(tenantId);
```

### Environment-Based Switching

```typescript
// rate-sync.config.ts
const isProduction = process.env.NODE_ENV === 'production';

export default defineConfig({
  stores: {
    main: isProduction
      ? { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' }
      : { engine: 'memory' },
  },
  limiters: {
    'public-api': {
      store: 'main',
      ratePerSecond: Number(process.env.API_RATE_LIMIT ?? 10),
    },
  },
});
```

---

## Algorithm Comparison

| Aspect | Token Bucket | Sliding Window |
|--------|--------------|----------------|
| Controls | Throughput, parallelism | Request count |
| Parameters | `ratePerSecond`, `maxConcurrent` | `limit`, `windowSeconds` |
| Engine support | Memory + Redis | Memory + Redis |
| Best for | API rate limiting | Auth protection |
| Burst handling | Allows controlled bursts | Strict count enforcement |

### When to Use Token Bucket

- API throughput control (req/sec)
- External API integration
- Connection pooling
- General rate limiting

### When to Use Sliding Window

- Login attempt limiting
- Password reset protection
- OTP verification
- Abuse prevention with strict counts

---

## See Also

- [API Reference](api-reference.md)
- [Next.js Integration](nextjs-integration.md)
- [Engine Documentation](engines/)
