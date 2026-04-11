<h1 align="center">rate-sync</h1>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18+-blue.svg" alt="Node.js 18+"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
</p>

<p align="center">Distributed rate limiting for TypeScript with Redis or in-memory backends, and first-class Next.js integration.</p>

---

## What It Solves

### Brute force and credential stuffing on your auth endpoints

Attackers try thousands of password combinations. A sliding window limiter on your login endpoint stops them — and composite limiting blocks both single-IP attacks and distributed botnets hitting the same account.

```typescript
configureLimiter('auth_credential', {
  store: 'auth-store',
  algorithm: 'sliding-window',
  limit: 5,          // 5 attempts
  windowSeconds: 300, // per 5 minutes
});
```

> **Deep dive:** [Authentication Protection](https://github.com/rate-sync/typescript/blob/main/docs/patterns/authentication-protection.md)

### Different API quotas for free, pro, and enterprise customers

Your free tier gets 100 requests/hour. Pro gets 1,000. Enterprise gets 10,000. Define each tier as a limiter and clone it per user — rate-sync handles the rest.

```typescript
const limiter = getOrCloneLimiter(`api_${tier}`, apiKey);
await limiter.initialize();
```

> **Deep dive:** [API Tiering](https://github.com/rate-sync/typescript/blob/main/docs/patterns/api-tiering.md)

### One tenant consuming all your platform's resources

In multi-tenant systems, a single noisy tenant can starve everyone else. Per-tenant rate limiting enforces fair usage — each tenant gets their share, and no one can monopolize your infrastructure.

```typescript
import { getOrCloneLimiter } from 'rate-sync';

const limiter = getOrCloneLimiter('platform_api', `tenant:${tenantId}`);
await limiter.initialize();
await limiter.acquire();
```

### Webhook floods taking down your customers' endpoints

Your platform sends webhooks to customer URLs. A bulk import triggers 10,000 events, and suddenly you're DDoS-ing your own customers. Per-endpoint rate limiting with automatic retries keeps delivery smooth without overwhelming anyone.

```typescript
const limiter = getOrCloneLimiter('webhook_endpoint', endpointUrl);
await limiter.using(async () => {
  await fetch(endpointUrl, { method: 'POST', body: JSON.stringify(payload) });
});
```

### File uploads and heavy operations eating all your resources

Five concurrent 1GB uploads can exhaust server memory. PDF generation can peg every CPU core. Concurrency limiting caps how many heavy operations run simultaneously — completely separate from request rate.

```typescript
configureLimiter('upload', {
  store: 'shared-backend',
  maxConcurrent: 10,  // max 10 uploads at once
  timeout: 300000,    // 5 minutes in ms
});
```

### Background workers overwhelming third-party APIs

You have 20 workers calling the Stripe API, which allows 100 req/s. Without coordination, your workers exceed the limit and get throttled. rate-sync coordinates across all workers through a shared Redis backend.

```typescript
configureLimiter('stripe_api', {
  store: 'shared-backend',
  ratePerSecond: 90, // stay under Stripe's 100/s limit
  maxConcurrent: 10, // max 10 in-flight calls
});
```

### Rate limits that actually work across multiple servers

In-memory counters reset when a process restarts and can't coordinate across instances. rate-sync uses Redis as a shared backend, so limits are enforced consistently across your entire fleet.

```typescript
export default defineConfig({
  stores: {
    'fleet-cache': { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    'global-api': { store: 'fleet-cache', ratePerSecond: 100 }, // all instances share this
  },
});
```

---

## Features

- **TypeScript-native configuration** - `defineConfig()` + `setupRateSyncFromConfig()` like Vite/Drizzle
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

**1. Create `rate-sync.config.ts`:**

```typescript
import { defineConfig } from 'rate-sync';

export default defineConfig({
  stores: {
    main: { engine: 'memory' }, // or "redis"
  },
  limiters: {
    'public-api': { store: 'main', ratePerSecond: 10 }, // public search API — 10 req/sec per client
  },
});
```

**2. Initialize in `instrumentation.ts` (or your app entry):**

```typescript
import config from './rate-sync.config';
import { setupRateSyncFromConfig } from 'rate-sync';

await setupRateSyncFromConfig(config);
// All stores connected and limiters initialized — ready to handle requests
```

## Usage Patterns

### `withRateLimit` for Next.js API Routes

```typescript
// app/api/search/route.ts
import { withRateLimit } from 'rate-sync/next';
import { getClientIp } from 'rate-sync/next';
// Initialize once in instrumentation.ts: await setupRateSyncFromConfig(config)

export const GET = withRateLimit(
  async (req) => {
    return Response.json({ results: [] });
  },
  {
    limiterId: 'search-throttle',
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
    limiterId: 'form-submit',
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

### Low-Level Programmatic Configuration

For dynamic or runtime configuration, use the registry functions directly:

```typescript
import { configureStore, configureLimiter, initializeAllLimiters, acquire } from 'rate-sync';

await configureStore('main', { engine: 'redis', url: 'redis://localhost:6379/0' });
configureLimiter('public-api', { store: 'main', ratePerSecond: 100 });
await initializeAllLimiters();

await acquire('public-api');
```

### Per-User / Per-Tenant Limits

```typescript
import { getOrCloneLimiter } from 'rate-sync';

// Clone the base limiter config for each tenant
const limiter = getOrCloneLimiter('public-api', `tenant:${tenantId}`);
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

```typescript
await configureStore('local', { engine: 'memory' });
```

No dependencies required. State is lost on restart and not shared across processes.

### Redis (production / distributed)

```typescript
await configureStore('app-cache', {
  engine: 'redis',
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  keyPrefix: 'myapp:',    // optional namespace
  socketTimeout: 2000,    // ms, optional
});
```

Requires `redis >= 4.0.0` as a peer dependency.

### PostgreSQL (coming soon)

PostgreSQL backend is planned. The `PostgresEngineConfig` type is exported but not yet wired into the registry.

## Algorithms

### Token Bucket (default)

Controls request throughput with optional concurrency limits. Best for API rate limiting and background job throttling.

```typescript
configureLimiter('external_api', {
  store: 'worker-cache',
  ratePerSecond: 100, // max 100 req/sec
  maxConcurrent: 10,  // max 10 in-flight requests
  timeout: 30000,     // wait up to 30s (ms)
});
```

### Sliding Window

Counts requests in a fixed time window. Best for login protection and quota enforcement.

```typescript
configureLimiter('login', {
  store: 'auth-cache',
  algorithm: 'sliding-window',
  limit: 5,           // max 5 attempts
  windowSeconds: 300, // per 5 minutes
});
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
  limiterId: 'public-api',                   // single or array of limiter IDs
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

### TypeScript Config (recommended)

```typescript
// rate-sync.config.ts
import { defineConfig } from 'rate-sync';

export default defineConfig({
  stores: {
    'dev-local': { engine: 'memory' },
    'primary-store': { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379/0' },
  },
  limiters: {
    'public-api': { store: 'primary-store', ratePerSecond: 100, maxConcurrent: 10, timeout: 30000 },
    login: { store: 'primary-store', algorithm: 'sliding-window', limit: 5, windowSeconds: 300 },
  },
});
```

## Documentation

| Topic | Link |
|-------|------|
| Configuration Reference | [docs/configuration.md](https://github.com/rate-sync/typescript/blob/main/docs/configuration.md) |
| API Reference | [docs/api-reference.md](https://github.com/rate-sync/typescript/blob/main/docs/api-reference.md) |
| Next.js Integration | [docs/nextjs-integration.md](https://github.com/rate-sync/typescript/blob/main/docs/nextjs-integration.md) |
| Memory Engine | [docs/engines/memory.md](https://github.com/rate-sync/typescript/blob/main/docs/engines/memory.md) |
| Redis Engine | [docs/engines/redis.md](https://github.com/rate-sync/typescript/blob/main/docs/engines/redis.md) |

### Patterns

- [Patterns Overview](https://github.com/rate-sync/typescript/blob/main/docs/patterns/README.md)
- [Authentication Protection](https://github.com/rate-sync/typescript/blob/main/docs/patterns/authentication-protection.md)
- [API Tiering](https://github.com/rate-sync/typescript/blob/main/docs/patterns/api-tiering.md)

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
