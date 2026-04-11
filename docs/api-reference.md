# API Reference

Complete API documentation for rate-sync.

Import from the `rate-sync` package:

```typescript
import { configureStore, configureLimiter, acquire, checkLimiter } from 'rate-sync';
```

Next.js helpers import from `rate-sync/next`:

```typescript
import { withRateLimit, withRateLimitAction, getClientIp } from 'rate-sync/next';
```

---

## Configuration

### configureStore

Configure a coordination store.

```typescript
async function configureStore(storeId: string, config: SupportedEngineConfig): Promise<void>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `storeId` | `string` | Unique store identifier |
| `config` | `SupportedEngineConfig` | Engine configuration object |

**Throws:** `Error` if engine type is unknown.

```typescript
import { configureStore } from 'rate-sync';

// Memory store (development)
await configureStore('dev', { engine: 'memory' });

// Redis store (production)
await configureStore('prod', {
  engine: 'redis',
  url: 'redis://localhost:6379',
  keyPrefix: 'myapp',
  socketTimeout: 5000,
});
```

---

### configureLimiter

Configure a rate limiter and register it in the global registry.

```typescript
function configureLimiter(limiterId: string, config: LimiterConfig): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `limiterId` | `string` | Unique limiter identifier |
| `config` | `LimiterConfig` | Limiter configuration object |

**Throws:** `RateLimiterAlreadyConfiguredError` if ID already registered. `StoreNotFoundError` if referenced store does not exist.

```typescript
import { configureLimiter } from 'rate-sync';

// Token bucket
configureLimiter('api', {
  store: 'prod',
  ratePerSecond: 100,
  maxConcurrent: 50,
  timeout: 30000,
});

// Sliding window
configureLimiter('login', {
  store: 'prod',
  algorithm: 'sliding-window',
  limit: 5,
  windowSeconds: 300,
});
```

---

### defineConfig

Identity function for type-safe programmatic configuration.

```typescript
function defineConfig(config: RateSyncConfig): RateSyncConfig
```

```typescript
import { defineConfig } from 'rate-sync';

const config = defineConfig({
  stores: {
    redis: { engine: 'redis', url: 'redis://localhost:6379' },
  },
  limiters: {
    api: { store: 'redis', ratePerSecond: 100 },
  },
});
```

---

### setupRateSyncFromConfig

Configure rate-sync programmatically from a config object and initialize all limiters. The recommended one-call startup function for TypeScript projects.

```typescript
async function setupRateSyncFromConfig(config: RateSyncConfig): Promise<void>
```

```typescript
import config from './rate-sync.config';
import { setupRateSyncFromConfig } from 'rate-sync';

// Typically called once at application startup (e.g., instrumentation.ts)
await setupRateSyncFromConfig(config);
```

---

## Registry

### getLimiter

Retrieve a configured limiter instance for direct use.

```typescript
function getLimiter(limiterId: string): RateLimiter
```

**Throws:** `LimiterNotFoundError`

```typescript
import { getLimiter } from 'rate-sync';

const limiter = getLimiter('api');
const metrics = limiter.getMetrics();
```

---

### getStore

Retrieve a configured store instance.

```typescript
function getStore(storeId: string): RateLimitStore
```

**Throws:** `StoreNotFoundError`

---

### cloneLimiter

Clone an existing limiter under a new ID, copying all configuration.

```typescript
function cloneLimiter(baseId: string, newId: string): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `baseId` | `string` | Source limiter ID to clone from |
| `newId` | `string` | New limiter ID |

**Throws:** `LimiterNotFoundError`, `StoreNotFoundError`

```typescript
import { cloneLimiter } from 'rate-sync';

cloneLimiter('api', `api:${userId}`);
```

---

### getOrCloneLimiter

Get an existing limiter or create a clone if it does not yet exist. Returns a limiter with ID `newId`, cloned from `baseId` on first call and reused on subsequent calls.

```typescript
function getOrCloneLimiter(baseId: string, newId: string): RateLimiter
```

**Throws:** `LimiterNotFoundError`

```typescript
import { getOrCloneLimiter } from 'rate-sync';

// Per-user rate limiting — cloned once, reused on subsequent requests
const limiter = getOrCloneLimiter('api', `api:${userId}`);
await limiter.initialize();
const result = await limiter.checkLimit(userId);
```

---

### listStores

Return the IDs of all registered stores.

```typescript
function listStores(): string[]
```

```typescript
import { listStores } from 'rate-sync';

console.log(listStores()); // ["dev", "prod"]
```

---

### listLimiters

Return the IDs of all registered limiters.

```typescript
function listLimiters(): string[]
```

```typescript
import { listLimiters } from 'rate-sync';

console.log(listLimiters()); // ["api", "login"]
```

---

## Initialization

### initializeLimiter

Initialize a specific limiter, connecting its underlying store if not already connected. Initialization is idempotent.

```typescript
async function initializeLimiter(limiterId: string): Promise<void>
```

**Throws:** `LimiterNotFoundError`

```typescript
import { initializeLimiter } from 'rate-sync';

await initializeLimiter('api');
```

---

### initializeAllLimiters

Initialize all registered limiters in parallel.

```typescript
async function initializeAllLimiters(): Promise<void>
```

```typescript
import { initializeAllLimiters } from 'rate-sync';

await initializeAllLimiters();
```

Note: Initialization is automatic on first use via `checkLimiter` wrappers. Explicit initialization catches connection errors at startup.

---

## Usage

### acquire

Acquire a slot on a limiter. Blocks indefinitely until a slot becomes available (polling with back-off).

```typescript
async function acquire(limiterId: string): Promise<void>
```

**Throws:** `LimiterNotFoundError`, `RateLimiterNotInitializedError`

```typescript
import { acquire } from 'rate-sync';

// Blocks until a slot is available
await acquire('api');
await callExternalApi();
```

---

### checkLimiter

Check a rate limit for an optional identifier and consume a slot if allowed. Returns the result without throwing.

```typescript
async function checkLimiter(
  limiterId: string,
  identifier?: string,
): Promise<RateLimitResult>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `limiterId` | `string` | Limiter to check |
| `identifier` | `string?` | Per-identifier key (e.g., user ID, IP address) |

**Throws:** `LimiterNotFoundError`, `RateLimiterNotInitializedError`

```typescript
import { checkLimiter } from 'rate-sync';

const result = await checkLimiter('api', userId);
if (!result.allowed) {
  return new Response('Too Many Requests', {
    status: 429,
    headers: { 'Retry-After': String(result.retryAfter) },
  });
}
```

---

### checkMultiLimiters

Check multiple rate limiters at once (e.g., per-IP and per-user). Returns the most restrictive combined result.

```typescript
async function checkMultiLimiters(
  limiterIds: string[],
  identifiers?: string[],
): Promise<MultiLimiterResult>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `limiterIds` | `string[]` | Ordered list of limiter IDs to check |
| `identifiers` | `string[]?` | Per-limiter identifiers (positionally aligned with `limiterIds`) |

```typescript
import { checkMultiLimiters } from 'rate-sync';

const result = await checkMultiLimiters(
  ['auth_ip', 'auth_credential'],
  [clientIp, emailHash],
);

if (!result.allowed) {
  console.log('Blocked by:', result.blockingLimiterId);
}
```

---

### closeAll

Close all store connections and clear the registry. Useful for graceful shutdown and test teardown.

```typescript
async function closeAll(): Promise<void>
```

```typescript
import { closeAll } from 'rate-sync';

process.on('SIGTERM', async () => {
  await closeAll();
  process.exit(0);
});
```

---

## Utilities

### hashIdentifier

Hash a sensitive identifier (e.g., email, phone) to a fixed 16-character hex string using SHA-256. The hash is deterministic — the same input always produces the same output.

```typescript
function hashIdentifier(identifier: string): string
```

```typescript
import { hashIdentifier } from 'rate-sync';

const key = hashIdentifier('user@example.com');
// → 'a1b2c3d4e5f6g7h8' (16 hex chars)
```

---

### combineIdentifiers

Combine multiple identifier segments into a single colon-separated rate limit key. Empty strings are filtered out.

```typescript
function combineIdentifiers(...parts: string[]): string
```

```typescript
import { combineIdentifiers, hashIdentifier } from 'rate-sync';

const key = combineIdentifiers(clientIp, hashIdentifier(email));
// → "192.168.1.1:a1b2c3d4e5f6g7h8"

combineIdentifiers('a', '', 'b');
// → "a:b"
```

---

## Classes

### RateLimiter

Core rate limiter class. Instances are created via `configureLimiter` / `cloneLimiter` and retrieved via `getLimiter`.

```typescript
class RateLimiter {
  constructor(options: RateLimiterOptions)

  // Lifecycle
  async initialize(): Promise<void>

  // Acquisition
  async acquire(): Promise<void>
  async tryAcquire(timeout?: number): Promise<boolean>
  async release(): Promise<void>
  async using(fn: () => Promise<void>, timeout?: number): Promise<void>

  // Rate limiting by identifier
  async checkLimit(identifier?: string): Promise<RateLimitResult>

  // Introspection
  getMetrics(): RateLimiterMetrics
  getConfig(): LimiterReadOnlyConfig
  async getState(identifier?: string): Promise<LimiterState>
  async resetState(identifier?: string): Promise<void>

  // Properties
  get groupId(): string
  get ratePerSecond(): number | null
  get maxConcurrent(): number | null
  get isInitialized(): boolean
  get defaultTimeout(): number | null
  get failClosed(): boolean
}
```

**Methods:**

| Method | Description |
|--------|-------------|
| `initialize()` | Connect store and mark as ready (idempotent) |
| `acquire()` | Block until a slot is available |
| `tryAcquire(timeout?)` | Try once or retry within timeout; returns `false` if blocked |
| `release()` | Release a held concurrency slot |
| `using(fn, timeout?)` | Acquire, run `fn`, release (finally-safe) |
| `checkLimit(identifier?)` | Consume a slot for a specific identifier; returns `RateLimitResult` |
| `getMetrics()` | Snapshot of acquisition counters and timings |
| `getConfig()` | Read-only configuration snapshot |
| `getState(identifier?)` | Current slot availability without consuming |
| `resetState(identifier?)` | Clear stored state for a key |

```typescript
const limiter = getLimiter('api');
await limiter.initialize();

// Concurrent-safe wrapper
await limiter.using(async () => {
  await callExternalService();
});

// Per-user check
const result = await limiter.checkLimit(userId);
if (!result.allowed) {
  throw new Error(`Rate limited. Retry in ${result.retryAfter}s.`);
}
```

---

## Types

### RateLimiterOptions

Options passed to the `RateLimiter` constructor.

```typescript
interface RateLimiterOptions {
  id: string;
  store: RateLimitStore;
  storeId: string;
  algorithm?: 'token-bucket' | 'sliding-window';
  ratePerSecond?: number;
  maxConcurrent?: number;
  limit?: number;
  windowSeconds?: number;
  timeout?: number;
  failClosed?: boolean;
}
```

---

### LimiterConfig

Configuration object for `configureLimiter`.

```typescript
interface LimiterConfig {
  readonly store: string;
  readonly algorithm?: 'token-bucket' | 'sliding-window';
  readonly ratePerSecond?: number;
  readonly maxConcurrent?: number;
  readonly limit?: number;
  readonly windowSeconds?: number;
  readonly timeout?: number;
  readonly failClosed?: boolean;
}
```

---

### RateSyncConfig

Top-level declarative configuration for stores and limiters.

```typescript
interface RateSyncConfig {
  readonly stores: Record<string, EngineConfig>;
  readonly limiters: Record<string, LimiterConfig>;
}
```

---

### EngineConfig / SupportedEngineConfig

```typescript
interface MemoryEngineConfig {
  readonly engine: 'memory';
}

interface RedisEngineConfig {
  readonly engine: 'redis';
  readonly url: string;
  readonly db?: number;
  readonly password?: string;
  readonly keyPrefix?: string;
  readonly socketTimeout?: number;
}

interface PostgresEngineConfig {
  readonly engine: 'postgres';
  readonly connectionString: string;
  readonly tableName?: string;
  readonly schemaName?: string;
  readonly autoCreate?: boolean;
  readonly poolMin?: number;
  readonly poolMax?: number;
}

type EngineConfig = MemoryEngineConfig | RedisEngineConfig | PostgresEngineConfig;

// Only Memory and Redis are supported in the current registry
type SupportedEngineConfig = MemoryEngineConfig | RedisEngineConfig;
```

---

### RateLimitResult

Result of a single rate limit check (`checkLimiter` / `limiter.checkLimit`).

```typescript
interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetIn: number;       // seconds until the window resets
  readonly limiterId?: string;
  readonly resetAt: number;       // Unix timestamp (seconds) of reset
  readonly retryAfter: number;    // seconds the client should wait before retrying
}
```

| Field | Type | Description |
|-------|------|-------------|
| `allowed` | `boolean` | Request allowed |
| `limit` | `number` | Max requests in the window |
| `remaining` | `number` | Remaining slots |
| `resetIn` | `number` | Seconds until reset |
| `limiterId` | `string?` | Limiter ID |
| `resetAt` | `number` | Unix timestamp of reset |
| `retryAfter` | `number` | `0` if allowed, otherwise seconds to wait |

---

### MultiLimiterResult

Combined result from `checkMultiLimiters`.

```typescript
interface MultiLimiterResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetIn: number;
  readonly blockingLimiterId?: string;   // ID of the first limiter that blocked
  readonly results: readonly RateLimitResult[];
  readonly resetAt: number;
  readonly retryAfter: number;
}
```

---

### LimiterState

Current state snapshot, read without consuming a slot (via `limiter.getState()`).

```typescript
interface LimiterState {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly currentUsage: number;
}
```

---

### RateLimiterMetrics

Observability counters collected by each `RateLimiter` instance.

```typescript
interface RateLimiterMetrics {
  totalAcquisitions: number;
  totalWaitTimeMs: number;
  avgWaitTimeMs: number;
  maxWaitTimeMs: number;
  timeouts: number;
  lastAcquisitionAt: number | null;
  currentConcurrent: number;
  maxConcurrentReached: number;
  totalReleases: number;
}
```

```typescript
const metrics = getLimiter('api').getMetrics();
console.log(`Avg wait: ${metrics.avgWaitTimeMs.toFixed(2)}ms`);
console.log(`Concurrent: ${metrics.currentConcurrent}`);
```

---

### LimiterReadOnlyConfig

Configuration snapshot returned by `limiter.getConfig()`.

```typescript
interface LimiterReadOnlyConfig {
  readonly id: string;
  readonly algorithm: 'token-bucket' | 'sliding-window';
  readonly storeId: string;
  readonly ratePerSecond: number | null;
  readonly maxConcurrent: number | null;
  readonly timeout: number | null;
  readonly limit: number | null;
  readonly windowSeconds: number | null;
  readonly failClosed: boolean;
}
```

---

## Exceptions

| Exception | Description | Properties |
|-----------|-------------|------------|
| `RateLimiterError` | Base class for all library errors | — |
| `RateLimiterNotConfiguredError` | Limiter referenced but not configured | `limiterName` |
| `RateLimiterNotInitializedError` | Used before `initialize()` | `limiterName?` |
| `RateLimiterAcquisitionError` | Failed to acquire a slot | `groupId?`, `attempts?` |
| `RateLimiterAlreadyConfiguredError` | Duplicate `configureLimiter` call | `limiterName` |
| `ConfigValidationError` | Invalid config file | `field?`, `expected?`, `received?` |
| `StoreNotFoundError` | Referenced store not registered | `storeId` |
| `LimiterNotFoundError` | Referenced limiter not registered | `limiterId` |
| `RateLimitExceededError` | Rate limit exceeded (carries 429 context) | `identifier`, `limit`, `remaining`, `resetAt`, `retryAfter`, `limiterId?` |

```typescript
const result = await limiter.checkLimit(userId);
if (!result.allowed) {
  // Rate limited — result contains limit, remaining, retryAfter
  console.log(`Rate limited. Retry in ${result.retryAfter}s`);
  return;
}
// Proceed with operation
```

---

## Next.js Integration (`rate-sync/next`)

### withRateLimit

Higher-order function that wraps a Next.js API route handler with rate limiting.

```typescript
function withRateLimit(
  handler: (req: NextRequest) => Response | Promise<Response>,
  options: WithRateLimitOptions,
): (req: NextRequest) => Promise<Response>

interface WithRateLimitOptions {
  limiterId: string | string[];
  keyExtractor: (req: NextRequest) => string | Promise<string>;
  failOpen?: boolean;                  // default: true
  onLimitExceeded?: (req: NextRequest, result: RateLimitResult) => Response | Promise<Response>;
  onError?: (req: NextRequest, error: unknown) => void;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limiterId` | `string \| string[]` | Required | One or more limiter IDs to check in order |
| `keyExtractor` | `function` | Required | Extracts the rate limit key from the request |
| `failOpen` | `boolean` | `true` | Allow requests when the store is unavailable |
| `onLimitExceeded` | `function?` | Built-in 429 | Custom handler for blocked requests |
| `onError` | `function?` | Silent | Called when the store throws (only when `failOpen: true`) |

```typescript
import { withRateLimit, getClientIp } from 'rate-sync/next';

export const GET = withRateLimit(
  async (req) => {
    return Response.json({ data: 'value' });
  },
  {
    limiterId: 'api',
    keyExtractor: (req) => getClientIp(req),
  },
);
```

Rate limit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`) are automatically added to all responses.

---

### withRateLimitAction

Higher-order function that wraps a Next.js Server Action with rate limiting. Returns a `RateLimitActionError` object (not a thrown error) when the limit is exceeded.

```typescript
function withRateLimitAction<TArgs extends unknown[], TReturn>(
  action: (...args: TArgs) => Promise<TReturn>,
  options: RateLimitActionOptions<TArgs>,
): (...args: TArgs) => Promise<TReturn | RateLimitActionError>

interface RateLimitActionOptions<TArgs extends unknown[]> {
  limiterId: string | string[];
  keyExtractor: (...args: TArgs) => string | Promise<string>;
  failOpen?: boolean;                  // default: true
  onError?: (error: unknown) => void;
}

interface RateLimitActionError {
  error: {
    code: 'RATE_LIMIT_EXCEEDED';
    message: string;
    retryAfter: number;
  };
}
```

```typescript
import { withRateLimitAction, isRateLimitActionError } from 'rate-sync/next';
import { headers } from 'next/headers';

const submitForm = withRateLimitAction(
  async (formData: FormData) => {
    // server action logic
    return { success: true };
  },
  {
    limiterId: 'form_submit',
    keyExtractor: async () => {
      const h = await headers();
      return h.get('x-forwarded-for') ?? '127.0.0.1';
    },
  },
);

// In your component:
const result = await submitForm(formData);
if (isRateLimitActionError(result)) {
  console.error(`Rate limited. Retry in ${result.error.retryAfter}s.`);
}
```

---

### isRateLimitActionError

Type guard for `RateLimitActionError`.

```typescript
function isRateLimitActionError(value: unknown): value is RateLimitActionError
```

---

### getClientIp

Extract the client IP address from a request, checking `x-forwarded-for` then `x-real-ip`, falling back to `127.0.0.1`.

```typescript
function getClientIp(req: { headers: { get(name: string): string | null } }): string
```

```typescript
import { getClientIp } from 'rate-sync/next';

const ip = getClientIp(req);
// → "203.0.113.1" (first IP from x-forwarded-for)
```

> **Note:** In local development without a reverse proxy, this always returns `127.0.0.1`. In production, ensure your proxy sets `x-forwarded-for` or `x-real-ip`.

---

### getRateLimitHeaders

Convert a `RateLimitResult` to IETF draft standard rate limit headers as a plain object.

```typescript
function getRateLimitHeaders(result: RateLimitResult): Record<string, string>
```

Returns:
- `RateLimit-Limit` — maximum requests in the window
- `RateLimit-Remaining` — requests remaining
- `RateLimit-Reset` — Unix timestamp (seconds) of reset
- `Retry-After` — (only when `!result.allowed`) seconds to wait

```typescript
import { getRateLimitHeaders } from 'rate-sync/next';

const headers = getRateLimitHeaders(result);
return new Response(null, { status: 429, headers });
```

---

### setRateLimitHeaders

Set rate limit headers directly on a `Headers` instance (mutates in place).

```typescript
function setRateLimitHeaders(responseHeaders: Headers, result: RateLimitResult): void
```

```typescript
import { setRateLimitHeaders } from 'rate-sync/next';

const response = NextResponse.next();
setRateLimitHeaders(response.headers, result);
return response;
```

---

## See Also

- [Configuration Guide](configuration.md)
- [Next.js Integration](nextjs-integration.md)
- [Engine Documentation](engines/)
