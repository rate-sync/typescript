# rate-sync Documentation

Distributed rate limiting for TypeScript with declarative configuration.

## Quick Links

| Category | Documentation |
|----------|---------------|
| **Getting Started** | [Main README](../README.md) |
| **Configuration** | [Configuration Guide](configuration.md) |
| **API** | [API Reference](api-reference.md) |
| **Next.js** | [Next.js Integration](nextjs-integration.md) |

## Engine Selection

| Engine | Use Case | Coordination | Documentation |
|--------|----------|--------------|---------------|
| Memory | Development, single-process | Local | [Memory Engine](engines/memory.md) |
| Redis | Production (recommended) | Distributed | [Redis Engine](engines/redis.md) |

## Algorithm Selection

| Algorithm | Parameters | Best For |
|-----------|------------|----------|
| Token Bucket | `ratePerSecond`, `maxConcurrent` | API throughput control |
| Sliding Window | `limit`, `windowSeconds` | Auth protection, abuse prevention |

## 5-Minute Quick Start

### 1. Install

```bash
npm install rate-sync                # Development (memory only)
npm install rate-sync redis          # Production (Redis backend)
```

### 2. Configure

Create `rate-sync.config.ts`:

```typescript
import { defineConfig } from 'rate-sync';

export default defineConfig({
  stores: {
    main: { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    'public-api': { store: 'main', ratePerSecond: 100, maxConcurrent: 50, timeout: 30000 },
  },
});
```

### 3. Use

```typescript
import config from './rate-sync.config';
import { setupRateSyncFromConfig, acquire } from 'rate-sync';

// Load config and initialize all limiters on startup
await setupRateSyncFromConfig(config);

// Acquire a slot (blocks until available)
await acquire('public-api');
```

## Architecture

```
Application Instances          Coordination Store
+------------------+          +------------------+
|   rate-sync      |--------->|                  |
+------------------+          |  Redis           |
+------------------+          |                  |
|   rate-sync      |--------->|                  |
+------------------+          +------------------+
+------------------+
|   rate-sync      |---------------^
+------------------+
```

**Key concepts:**

- **Stores** define the coordination mechanism (Memory, Redis)
- **Limiters** define rate limiting rules and reference a store
- Multiple limiters can share one store connection

## Common Patterns

### Rate Limiting (Throughput)

```typescript
configureLimiter('external_api', { store: 'primary-store', ratePerSecond: 10 });
```

### Concurrency Limiting (Parallelism)

```typescript
configureLimiter('db_pool', { store: 'primary-store', maxConcurrent: 20 });
```

### Combined (Production)

```typescript
configureLimiter('production', { store: 'primary-store', ratePerSecond: 100, maxConcurrent: 50, timeout: 30000 });
```

### Auth Protection (Sliding Window)

```typescript
configureLimiter('login', { store: 'primary-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 300 });
```

## Support

- [GitHub Issues](https://github.com/rate-sync/typescript/issues)
- [GitHub Discussions](https://github.com/rate-sync/typescript/discussions)
