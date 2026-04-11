# API Tiering

> **Requires:** `npm install rate-sync redis` for Redis-backed examples.

Apply different rate limits to different user tiers (free, pro, enterprise).

## Configuration

```toml
# rate-sync.toml
[stores.redis]
engine = "redis"
url = "${REDIS_URL}"

[limiters.api_free]
store = "redis"
algorithm = "sliding-window"
limit = 100
window_seconds = 3600

[limiters.api_pro]
store = "redis"
algorithm = "sliding-window"
limit = 1000
window_seconds = 3600

[limiters.api_enterprise]
store = "redis"
algorithm = "sliding-window"
limit = 10000
window_seconds = 3600
```

## Implementation

### Next.js API Route

```typescript
// app/api/data/route.ts
import { getOrCloneLimiter, getLimiter, initializeLimiter } from 'rate-sync';
import { getRateLimitHeaders } from 'rate-sync/next';
import { getUserFromApiKey } from '@/lib/auth';

export async function GET(req: Request) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) {
    return Response.json({ error: 'Missing API key' }, { status: 401 });
  }

  const user = await getUserFromApiKey(apiKey);
  if (!user) {
    return Response.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // Get or create a per-user limiter cloned from the tier template
  const baseId = `api_${user.tier}`;
  const userId = user.id;

  const limiter = getOrCloneLimiter(baseId, `${baseId}:${userId}`);
  if (!limiter.isInitialized) await initializeLimiter(`${baseId}:${userId}`);

  const result = await limiter.checkLimit(userId);

  if (!result.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded', retryAfter: result.retryAfter },
      { status: 429, headers: getRateLimitHeaders(result) },
    );
  }

  const response = Response.json({ data: 'value' });
  const newHeaders = new Headers(response.headers);
  Object.entries(getRateLimitHeaders(result)).forEach(([k, v]) =>
    newHeaders.set(k, v),
  );
  return new Response(response.body, { headers: newHeaders });
}
```

### Using withRateLimit

```typescript
// app/api/data/route.ts
import { withRateLimit, getClientIp } from 'rate-sync/next';
import { getOrCloneLimiter, getLimiter, initializeLimiter } from 'rate-sync';
import { getUserFromApiKey } from '@/lib/auth';

export const GET = withRateLimit(
  async (req) => {
    return Response.json({ data: 'value' });
  },
  {
    limiterId: 'api_free',  // fallback limiter if tier lookup fails
    keyExtractor: async (req) => {
      const apiKey = req.headers.get('x-api-key');
      if (!apiKey) return getClientIp(req);

      const user = await getUserFromApiKey(apiKey);
      if (!user) return getClientIp(req);

      // Dynamically select limiter based on tier
      const baseId = `api_${user.tier}`;
      getOrCloneLimiter(baseId, `${baseId}:${user.id}`);
      return user.id;
    },
  },
);
```

## Per-Endpoint Tiering

```toml
# Generous for reads
[limiters.read_free]
store = "redis"
algorithm = "sliding-window"
limit = 1000
window_seconds = 3600

# Strict for writes
[limiters.write_free]
store = "redis"
algorithm = "sliding-window"
limit = 100
window_seconds = 3600

# Very strict for exports
[limiters.export_free]
store = "redis"
algorithm = "sliding-window"
limit = 10
window_seconds = 86400
```

```typescript
async function checkTieredLimit(
  endpointType: 'read' | 'write' | 'export',
  userId: string,
  tier: string,
) {
  const baseId = `${endpointType}_${tier}`;
  const cloneId = `${baseId}:${userId}`;

  const limiter = getOrCloneLimiter(baseId, cloneId);
  if (!limiter.isInitialized) await initializeLimiter(cloneId);

  return limiter.checkLimit(userId);
}

// GET /api/users
export async function GET(req: Request) {
  const user = await getAuthUser(req);
  const result = await checkTieredLimit('read', user.id, user.tier);
  if (!result.allowed) {
    return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }
  return Response.json({ users: [] });
}

// POST /api/export
export async function POST(req: Request) {
  const user = await getAuthUser(req);
  const result = await checkTieredLimit('export', user.id, user.tier);
  if (!result.allowed) {
    return Response.json({ error: 'Export limit exceeded' }, { status: 429 });
  }
  return Response.json({ exportId: '...' });
}
```

## Response Headers

Include rate limit context in responses so API clients can display quota information:

```typescript
import { getRateLimitHeaders } from 'rate-sync/next';

const result = await limiter.checkLimit(userId);

return Response.json(
  { data: 'value' },
  {
    headers: {
      ...getRateLimitHeaders(result),
      'X-RateLimit-Tier': user.tier,
    },
  },
);
```

Clients receive:
```
RateLimit-Limit: 1000
RateLimit-Remaining: 847
RateLimit-Reset: 1712534400
X-RateLimit-Tier: pro
```

## See Also

- [Authentication Protection](./authentication-protection.md) — Protecting auth endpoints
- [API Reference](../api-reference.md) — `getOrCloneLimiter`, `checkLimiter`, `RateLimitResult`
- [Configuration Guide](../configuration.md) — `algorithm`, `limit`, `windowSeconds`
