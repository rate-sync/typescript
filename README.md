<p align="center">
  <img src="https://raw.githubusercontent.com/rate-sync/typescript/main/docs/assets/logo.png" alt="rate-sync" width="200">
</p>

<h1 align="center">rate-sync</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/rate-sync"><img src="https://img.shields.io/npm/v/rate-sync.svg" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18+-blue.svg" alt="Node.js 18+"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
  <a href="https://github.com/rate-sync/typescript/actions"><img src="https://img.shields.io/github/actions/workflow/status/rate-sync/typescript/test.yml?branch=main&label=tests" alt="Tests"></a>
</p>

<p align="center">Distributed rate limiting for TypeScript with Redis or in-memory backends, and first-class Next.js integration.</p>

---

## What It Solves

### Brute force and credential stuffing on your auth endpoints

Attackers try thousands of password combinations. A sliding window limiter on your login endpoint stops them — and composite limiting blocks both single-IP attacks and distributed botnets hitting the same account.

```toml
[limiters.auth_credential]
store = "redis"
algorithm = "sliding-window"
limit = 5                # 5 attempts
window_seconds = 300     # per 5 minutes
```

> **Deep dive:** [Authentication Protection](https://github.com/rate-sync/typescript/blob/main/docs/patterns/authentication-protection.md) &middot; [Abuse Prevention](https://github.com/rate-sync/typescript/blob/main/docs/patterns/abuse-prevention.md)

### Different API quotas for free, pro, and enterprise customers

Your free tier gets 100 requests/hour. Pro gets 1,000. Enterprise gets 10,000. Define each tier as a limiter and clone it per user — rate-sync handles the rest.

```typescript
const limiter = getOrCloneLimiter(`api_${tier}`, apiKey);
```

> **Deep dive:** [API Tiering](https://github.com/rate-sync/typescript/blob/main/docs/patterns/api-tiering.md)

### One tenant consuming all your platform's resources

In multi-tenant systems, a single noisy tenant can starve everyone else. Per-tenant rate limiting enforces fair usage — each tenant gets their share, and no one can monopolize your infrastructure.

```typescript
// Each tenant gets their own enforced limit
cloneLimiter('platform_api', `tenant:${tenantId}`);
await acquire(`tenant:${tenantId}`);
```

> **Deep dive:** [Multi-Tenant Fairness](https://github.com/rate-sync/typescript/blob/main/docs/patterns/multi-tenant-fairness.md)

### Webhook floods taking down your customers' endpoints

Your platform sends webhooks to customer URLs. A bulk import triggers 10,000 events, and suddenly you're DDoS-ing your own customers. Per-endpoint rate limiting with automatic retries keeps delivery smooth without overwhelming anyone.

```typescript
const limiter = getOrCloneLimiter('webhook_endpoint', endpointUrl);
await limiter.using(async () => {
  await fetch(endpointUrl, { method: 'POST', body: JSON.stringify(payload) });
});
```

> **Deep dive:** [Webhook Delivery](https://github.com/rate-sync/typescript/blob/main/docs/patterns/webhook-delivery.md)

### File uploads and heavy operations eating all your resources

Five concurrent 1GB uploads can exhaust server memory. PDF generation can peg every CPU core. Concurrency limiting caps how many heavy operations run simultaneously — completely separate from request rate.

```toml
[limiters.upload]
store = "redis"
max_concurrent = 10     # max 10 uploads at once
timeout = 300000        # 5 minutes in ms
```

> **Deep dive:** [File Uploads & Heavy Resources](https://github.com/rate-sync/typescript/blob/main/docs/patterns/file-uploads.md)

### Background workers overwhelming third-party APIs

You have 20 workers calling the Stripe API, which allows 100 req/s. Without coordination, your workers exceed the limit and get throttled. rate-sync coordinates across all workers through a shared Redis backend.

```toml
[limiters.stripe_api]
store = "redis"
rate_per_second = 90    # stay under Stripe's 100/s limit
max_concurrent = 10     # max 10 in-flight calls
```

> **Deep dive:** [Background Jobs](https://github.com/rate-sync/typescript/blob/main/docs/patterns/background-jobs.md)

### Rate limits that actually work across multiple servers

In-memory counters reset when a process restarts and can't coordinate across instances. rate-sync uses Redis as a shared backend, so limits are enforced consistently across your entire fleet.

```toml
[stores.redis]
engine = "redis"
url = "${REDIS_URL}"

[limiters.api]
store = "redis"        # all instances share this
rate_per_second = 100
```

> **Deep dive:** [Production Deployment](https://github.com/rate-sync/typescript/blob/main/docs/patterns/production-deployment.md)

---

## Features

- **Declarative configuration** - Define limits in TOML, use anywhere
- **Multiple backends** - Redis (recommended) or in-memory
- **Dual limiting** - Rate limiting (req/sec) + concurrency limiting (max parallel)
- **Two algorithms** - Token bucket for throughput, sliding window for quotas
- **Next.js integration** - `withRateLimit` for API routes, `withRateLimitAction` for Server Actions
- **Async-first** - Full async/await with TypeScript generics and strict types

## Installation

```bash
pnpm add rate-sync             # Memory backend only
pnpm add rate-sync redis       # + Redis support
pnpm add rate-sync next        # + Next.js integration
```

Optional peer dependencies — install only what you need:

| Package | When to install |
|---------|----------------|
| `redis` | Redis backend |
| `next`  | Next.js helpers (`withRateLimit`, `withRateLimitAction`) |

## Quick Start

**1. Create `rate-sync.toml`:**

```toml
[stores.main]
engine = "memory"  # or "redis"

[limiters.api]
store = "main"
rate_per_second = 10
```

**2. Use it:**

```typescript
import { setupRateSync, acquire } from 'rate-sync';

await setupRateSync('./rate-sync.toml');

await acquire('api'); // Blocks until rate limit allows
```

## Usage Patterns

### `withRateLimit` for Next.js API Routes

```typescript
// app/api/search/route.ts
import { withRateLimit, setupRateSync } from 'rate-sync/next';
import { getClientIp } from 'rate-sync/next';

await setupRateSync('./rate-sync.toml');

export const GET = withRateLimit(
  async (req) => {
    return Response.json({ results: [] });
  },
  {
    limiterId: 'api',
    keyExtractor: (req) => getClientIp(req),
  },
);
```

### `withRateLimitAction` for Server Actions

```typescript
// app/actions.ts
'use server';
import { withRateLimitAction, isRateLimitActionError } from 'rate-sync/next';
import { headers } from 'next/headers';

export const submitForm = withRateLimitAction(
  async (data: FormData) => {
    // action logic
    return { success: true };
  },
  {
    limiterId: 'api',
    keyExtractor: async () => {
      const h = await headers();
      return h.get('x-forwarded-for') ?? '127.0.0.1';
    },
  },
);

// In a component:
const result = await submitForm(formData);
if (isRateLimitActionError(result)) {
  console.error(`Rate limited. Retry in ${result.error.retryAfter}s`);
}
```

### Programmatic Configuration

Skip the TOML file if you prefer code:

```typescript
import { configureStore, configureLimiter, initializeAllLimiters, acquire } from 'rate-sync';

await configureStore('main', { engine: 'redis', url: 'redis://localhost:6379/0' });
configureLimiter('api', { store: 'main', ratePerSecond: 100 });
await initializeAllLimiters();

await acquire('api');
```

### Per-User / Per-Tenant Limits

```typescript
import { getOrCloneLimiter, checkLimiter } from 'rate-sync';

// Clone the base limiter config for each tenant
const limiter = getOrCloneLimiter('api', `tenant:${tenantId}`);
await limiter.initialize();

const result = await limiter.checkLimit(userId);
if (!result.allowed) {
  throw new Error(`Rate limited. Retry in ${result.retryAfter}s`);
}
```

### Concurrency Limiting

```typescript
import { getLimiter } from 'rate-sync';

const limiter = getLimiter('upload');
await limiter.using(async () => {
  await processUpload(file);
}); // slot is released automatically
```

## Backends

### Memory (development / single-process)

```toml
[stores.local]
engine = "memory"
```

No dependencies required. State is lost on restart and not shared across processes.

### Redis (production / distributed)

```toml
[stores.redis]
engine = "redis"
url = "${REDIS_URL}"
key_prefix = "myapp:"       # optional namespace
socket_timeout = 2000       # ms, optional
```

Requires `redis >= 4.0.0` as a peer dependency.

### PostgreSQL (coming soon)

PostgreSQL backend is planned. The `PostgresEngineConfig` type is exported but not yet wired into the registry.

## Algorithms

### Token Bucket (default)

Controls request throughput with optional concurrency limits. Best for API rate limiting and background job throttling.

```toml
[limiters.external_api]
store = "redis"
rate_per_second = 100     # max 100 req/sec
max_concurrent = 10       # max 10 in-flight requests
timeout = 30000           # wait up to 30s (ms)
```

### Sliding Window

Counts requests in a fixed time window. Best for login protection and quota enforcement.

```toml
[limiters.login]
store = "redis"
algorithm = "sliding-window"
limit = 5                 # max 5 attempts
window_seconds = 300      # per 5 minutes
```

## Next.js Integration

> **Requires:** `pnpm add rate-sync next`

Import from `rate-sync/next`:

```typescript
import {
  withRateLimit,          // wraps App Router handlers
  withRateLimitAction,    // wraps Server Actions
  isRateLimitActionError, // type guard for action errors
  getClientIp,            // extracts IP from x-forwarded-for / x-real-ip
  getRateLimitHeaders,    // returns RateLimit-* response headers
} from 'rate-sync/next';
```

**`withRateLimit` — API Route wrapper**

Wraps a Next.js App Router handler. Returns `429` automatically when the limit is exceeded, and injects `RateLimit-*` headers on every allowed response.

```typescript
export const POST = withRateLimit(handler, {
  limiterId: 'api',                          // single or array of limiter IDs
  keyExtractor: (req) => getClientIp(req),   // required: produces the rate-limit key
  failOpen: true,                            // default: pass through on store errors
  onLimitExceeded: (req, result) =>          // optional: custom 429 response
    Response.json({ error: 'Too many requests' }, { status: 429 }),
  onError: (req, err) =>                     // optional: log store errors
    console.error('Rate limit store error', err),
});
```

**`withRateLimitAction` — Server Action wrapper**

Wraps a Server Action. Returns `{ error: { code: 'RATE_LIMIT_EXCEEDED', ... } }` when the limit is exceeded — use `isRateLimitActionError()` to distinguish it from a successful result.

```typescript
export const myAction = withRateLimitAction(
  async (input: string) => ({ data: input }),
  {
    limiterId: ['global', 'per_user'],       // check multiple limiters in order
    keyExtractor: async () => getUserId(),   // async extractors are supported
    failOpen: true,
  },
);
```

## Configuration

Full TOML reference:

```toml
# rate-sync.toml

# --- Stores ---

[stores.memory]
engine = "memory"

[stores.redis]
engine = "redis"
url = "${REDIS_URL:-redis://localhost:6379/0}"
db = 0                 # optional, default: 0
password = "${REDIS_PASSWORD}"  # optional
key_prefix = "myapp:"  # optional namespace for all keys
socket_timeout = 2000  # ms, optional

# --- Limiters ---

# Token bucket — rate + concurrency
[limiters.api]
store = "redis"
rate_per_second = 100
max_concurrent = 10
timeout = 30000        # ms to wait for a slot before giving up
fail_closed = false    # if true, block requests when store is unavailable

# Sliding window — count in window
[limiters.login]
store = "redis"
algorithm = "sliding-window"
limit = 5
window_seconds = 300
```

**Key rules:**

- `algorithm` must be `"token-bucket"` (default) or `"sliding-window"` — hyphens, not underscores
- TOML keys use `snake_case`; they are automatically converted to `camelCase` for the TypeScript API
- Environment variables expand with `${VAR}` or `${VAR:-default}`; numeric strings are auto-cast to numbers
- At least one of `rate_per_second`, `max_concurrent`, or `limit` must be set per limiter

## Documentation

| Topic | Link |
|-------|------|
| Configuration Reference | [docs/configuration.md](https://github.com/rate-sync/typescript/blob/main/docs/configuration.md) |
| API Reference | [docs/api-reference.md](https://github.com/rate-sync/typescript/blob/main/docs/api-reference.md) |
| Next.js Integration | [docs/nextjs-integration.md](https://github.com/rate-sync/typescript/blob/main/docs/nextjs-integration.md) |
| Redis Setup | [docs/setup/redis-setup.md](https://github.com/rate-sync/typescript/blob/main/docs/setup/redis-setup.md) |
| Observability | [docs/observability.md](https://github.com/rate-sync/typescript/blob/main/docs/observability.md) |

### Patterns

- [Authentication Protection](https://github.com/rate-sync/typescript/blob/main/docs/patterns/authentication-protection.md)
- [Abuse Prevention](https://github.com/rate-sync/typescript/blob/main/docs/patterns/abuse-prevention.md)
- [API Tiering](https://github.com/rate-sync/typescript/blob/main/docs/patterns/api-tiering.md)
- [Multi-Tenant Fairness](https://github.com/rate-sync/typescript/blob/main/docs/patterns/multi-tenant-fairness.md)
- [Webhook Delivery](https://github.com/rate-sync/typescript/blob/main/docs/patterns/webhook-delivery.md)
- [File Uploads & Heavy Resources](https://github.com/rate-sync/typescript/blob/main/docs/patterns/file-uploads.md)
- [Background Jobs](https://github.com/rate-sync/typescript/blob/main/docs/patterns/background-jobs.md)
- [Graceful Degradation](https://github.com/rate-sync/typescript/blob/main/docs/patterns/graceful-degradation.md)
- [Production Deployment](https://github.com/rate-sync/typescript/blob/main/docs/patterns/production-deployment.md)
- [Testing](https://github.com/rate-sync/typescript/blob/main/docs/patterns/testing.md)

## Contributing

```bash
git clone https://github.com/rate-sync/typescript.git
cd typescript
pnpm install
pnpm test
```

See [CONTRIBUTING.md](https://github.com/rate-sync/typescript/blob/main/CONTRIBUTING.md) for guidelines.

## License

MIT
