# Configuration Guide

rate-sync supports TOML file configuration, programmatic setup, or both.

## Configuration Methods

| Method | TOML | Programmatic |
|--------|------|--------------|
| Environment variable expansion | Yes | No |
| Runtime modification | No | Yes |
| Best for | Static config | Dynamic config |

## TOML Configuration

### Basic Structure

```toml
# Stores define HOW rate limiting is coordinated
[stores.local]
engine = "memory"

# Limiters define WHAT to rate limit
[limiters.api]
store = "local"
rate_per_second = 10
```

### Loading the Config

```typescript
import { loadConfig, setupRateSync } from 'rate-sync';

// Option 1: Load config only (does not initialize limiters)
await loadConfig('./rate-sync.toml');

// Option 2: Load and initialize all limiters (recommended)
await setupRateSync('./rate-sync.toml');
```

### Environment Variable Expansion

TOML values support `${VAR}` and `${VAR:-default}` syntax:

```toml
[stores.prod]
engine = "redis"
url = "${REDIS_URL}"                           # Required env var
url = "${REDIS_URL:-redis://localhost:6379}"   # With default
```

Numeric strings are automatically coerced:

```toml
[limiters.api]
store = "prod"
rate_per_second = "${API_RATE_LIMIT:-100}"     # Becomes number 100
```

> **Note:** Algorithm names use hyphens (`token-bucket`, `sliding-window`) and are NOT converted by key normalisation. Write them verbatim.

---

## Programmatic Configuration

```typescript
import { configureStore, configureLimiter, initializeAllLimiters } from 'rate-sync';

// Option 1: Programmatic
await configureStore('local', { engine: 'memory' });
configureLimiter('api', { store: 'local', ratePerSecond: 10 });
await initializeAllLimiters();

// Option 2: Load TOML
await setupRateSync('rate-sync.toml');

// Option 3: Type-safe config object
import { defineConfig } from 'rate-sync';

const config = defineConfig({
  stores: { redis: { engine: 'redis', url: 'redis://localhost:6379' } },
  limiters: { api: { store: 'redis', ratePerSecond: 100 } },
});
```

---

## Stores Configuration

### Memory Engine

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `engine` | `string` | Required | `"memory"` |

```toml
[stores.dev]
engine = "memory"
```

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

```toml
[stores.prod]
engine = "redis"
url = "${REDIS_URL:-redis://localhost:6379}"
key_prefix = "myapp:ratelimit"
socket_timeout = 10000
```

```typescript
await configureStore('prod', {
  engine: 'redis',
  url: 'redis://localhost:6379',
  keyPrefix: 'myapp:ratelimit',
  socketTimeout: 10000,
});
```

> **TOML note:** TOML keys use `snake_case` (e.g., `key_prefix`). They are automatically converted to `camelCase` when loaded. TypeScript programmatic config uses `camelCase` directly.

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

At least one of `ratePerSecond` or `maxConcurrent` required.

```toml
# TOML
[limiters.api]
store = "prod"
rate_per_second = 100
max_concurrent = 50
timeout = 30000
```

```typescript
// Programmatic
configureLimiter('api', {
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

```toml
# TOML
[limiters.login]
store = "prod"
algorithm = "sliding-window"
limit = 5
window_seconds = 300
```

```typescript
// Programmatic
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

```toml
[stores.dev]
engine = "memory"

[limiters.api]
store = "dev"
rate_per_second = 100
```

### Production Setup

```toml
[stores.prod]
engine = "redis"
url = "${REDIS_URL}"

[limiters.api]
store = "prod"
rate_per_second = 1000
max_concurrent = 200
timeout = 30000

[limiters.partner_api]
store = "prod"
rate_per_second = 10
timeout = 60000
fail_closed = true

[limiters.login]
store = "prod"
algorithm = "sliding-window"
limit = 5
window_seconds = 300
```

### Multi-Tenant Setup

```toml
[stores.shared]
engine = "redis"
url = "${REDIS_URL}"

[limiters.tenant_base]
store = "shared"
rate_per_second = 10

[limiters.tenant_premium]
store = "shared"
rate_per_second = 100
```

```typescript
import { getOrCloneLimiter, acquire } from 'rate-sync';

// Get or create a per-tenant limiter cloned from 'tenant_base'
getOrCloneLimiter('tenant_base', `tenant:${tenantId}`);

// Use it
const limiter = getLimiter(`tenant:${tenantId}`);
await limiter.initialize();
const result = await limiter.checkLimit(tenantId);
```

### Environment-Based Switching

```toml
[stores.main]
engine = "${RATE_LIMIT_ENGINE:-memory}"
url = "${REDIS_URL:-}"

[limiters.api]
store = "main"
rate_per_second = "${API_RATE_LIMIT:-10}"
```

```bash
# Development
export RATE_LIMIT_ENGINE=memory

# Production
export RATE_LIMIT_ENGINE=redis
export REDIS_URL=redis://prod-redis:6379
export API_RATE_LIMIT=1000
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
