# Next.js Integration

rate-sync provides first-class integration with Next.js via the `rate-sync/next` subpackage.

## Installation

```bash
npm install rate-sync redis          # Redis backend (recommended)
npm install rate-sync                # Memory backend only (development)
```

Peer dependency `next >= 14.0.0` is required.

## Setup

### 1. Create rate-sync.toml

```toml
[stores.redis]
engine = "redis"
url = "${REDIS_URL:-redis://localhost:6379}"

[limiters.api]
store = "redis"
rate_per_second = 100
max_concurrent = 50

[limiters.auth]
store = "redis"
algorithm = "sliding-window"
limit = 5
window_seconds = 300
```

### 2. Initialize on Startup

Add a module-level initializer that runs once before your app handles requests:

```typescript
// lib/rate-limit.ts
import { setupRateSync } from 'rate-sync';
import path from 'node:path';

let initialized = false;

export async function ensureRateSync() {
  if (initialized) return;
  await setupRateSync(path.join(process.cwd(), 'rate-sync.toml'));
  initialized = true;
}
```

Or use Next.js `instrumentation.ts` (Next.js 13.4+):

```typescript
// instrumentation.ts  (place at project root)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setupRateSync } = await import('rate-sync');
    await setupRateSync('./rate-sync.toml');
  }
}
```

---

## API Routes

Use `withRateLimit` to wrap any App Router route handler:

```typescript
// app/api/data/route.ts
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

Rate limit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`) are automatically added to all responses — both allowed and blocked.

### Per-User Rate Limiting

```typescript
// app/api/protected/route.ts
import { withRateLimit } from 'rate-sync/next';
import { getServerSession } from 'next-auth';

export const POST = withRateLimit(
  async (req) => {
    const session = await getServerSession();
    // handler logic
    return Response.json({ ok: true });
  },
  {
    limiterId: 'api',
    keyExtractor: async (req) => {
      const session = await getServerSession();
      return session?.user?.id ?? getClientIp(req);
    },
  },
);
```

### Multiple Limiters (Layered Protection)

```typescript
// Check both IP and user limiters — first denial wins
export const POST = withRateLimit(handler, {
  limiterId: ['auth_ip', 'auth_credential'],
  keyExtractor: async (req) => {
    const body = await req.json();
    return getClientIp(req);   // used for auth_ip
    // Note: with multiple limiters, keyExtractor is called once.
    // For different keys per limiter, use checkMultiLimiters directly.
  },
});
```

### Custom 429 Response

```typescript
export const POST = withRateLimit(handler, {
  limiterId: 'api',
  keyExtractor: (req) => getClientIp(req),
  onLimitExceeded: (req, result) => {
    return Response.json(
      { error: 'Too many requests', retryAfter: result.retryAfter },
      { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
    );
  },
});
```

### Fail-Open Behavior

By default, if the rate limit store is unreachable, requests pass through (`failOpen: true`). To reject requests on store errors:

```typescript
export const POST = withRateLimit(handler, {
  limiterId: 'api',
  keyExtractor: (req) => getClientIp(req),
  failOpen: false,   // throw on store errors
  onError: (req, err) => {
    console.error('Rate limit store error:', err);
  },
});
```

---

## Server Actions

Use `withRateLimitAction` to protect Server Actions. It returns a `RateLimitActionError` value (not a thrown exception) when blocked:

```typescript
// app/actions/submit.ts
'use server';

import { withRateLimitAction } from 'rate-sync/next';
import { headers } from 'next/headers';

export const submitForm = withRateLimitAction(
  async (formData: FormData) => {
    const name = formData.get('name') as string;
    // process the form...
    return { success: true, name };
  },
  {
    limiterId: 'form_submit',
    keyExtractor: async () => {
      const h = await headers();
      return h.get('x-forwarded-for') ?? '127.0.0.1';
    },
  },
);
```

### Handling the Result in a Component

```typescript
// app/components/ContactForm.tsx
'use client';

import { isRateLimitActionError } from 'rate-sync/next';
import { submitForm } from '../actions/submit';

export function ContactForm() {
  async function handleSubmit(formData: FormData) {
    const result = await submitForm(formData);
    if (isRateLimitActionError(result)) {
      alert(`Too many submissions. Try again in ${result.error.retryAfter}s.`);
      return;
    }
    console.log('Submitted:', result.name);
  }

  return (
    <form action={handleSubmit}>
      <input name="name" type="text" />
      <button type="submit">Submit</button>
    </form>
  );
}
```

---

## Middleware

For global rate limiting across all (or selected) routes, use Next.js `middleware.ts`:

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkLimiter, getLimiter, initializeLimiter } from 'rate-sync';
import { getClientIp, setRateLimitHeaders } from 'rate-sync/next';

export async function middleware(req: NextRequest) {
  try {
    const limiter = getLimiter('global');
    if (!limiter.isInitialized) await initializeLimiter('global');

    const ip = getClientIp(req);
    const result = await checkLimiter('global', ip);

    if (!result.allowed) {
      return new NextResponse('Too Many Requests', {
        status: 429,
        headers: {
          'Content-Type': 'text/plain',
          'Retry-After': String(result.retryAfter),
        },
      });
    }

    const response = NextResponse.next();
    setRateLimitHeaders(response.headers, result);
    return response;
  } catch {
    // failOpen: let request through on store errors
    return NextResponse.next();
  }
}

export const config = {
  matcher: ['/api/:path*'],
};
```

> **Note:** The middleware must be initialized separately before it can use the registry. The `instrumentation.ts` approach (see Setup above) is the recommended way to ensure limiters are ready before middleware runs.

---

## Auth Protection Pattern

Protect login and password-reset endpoints against brute force:

```toml
# rate-sync.toml
[limiters.auth_ip]
store = "redis"
algorithm = "sliding-window"
limit = 30
window_seconds = 60

[limiters.auth_credential]
store = "redis"
algorithm = "sliding-window"
limit = 5
window_seconds = 300
```

```typescript
// app/api/auth/login/route.ts
import { checkMultiLimiters } from 'rate-sync';
import { getClientIp, getRateLimitHeaders } from 'rate-sync/next';
import { hashIdentifier, combineIdentifiers } from 'rate-sync';

export async function POST(req: Request) {
  const { email, password } = await req.json();
  const ip = getClientIp(req as any);
  const emailHash = hashIdentifier(email);

  const result = await checkMultiLimiters(
    ['auth_ip', 'auth_credential'],
    [ip, combineIdentifiers(ip, emailHash)],
  );

  if (!result.allowed) {
    const headers = getRateLimitHeaders(
      result.results.find((r) => !r.allowed)!,
    );
    return Response.json(
      { error: 'Too many attempts' },
      { status: 429, headers },
    );
  }

  // proceed with authentication
  return Response.json({ token: '...' });
}
```

---

## Response Headers Reference

`withRateLimit` and `setRateLimitHeaders` add standard IETF draft headers:

| Header | Value | When |
|--------|-------|------|
| `RateLimit-Limit` | Max requests in window | Always |
| `RateLimit-Remaining` | Remaining requests | Always |
| `RateLimit-Reset` | Unix timestamp of reset | Always |
| `Retry-After` | Seconds to wait | Only on 429 |

---

## See Also

- [API Reference](api-reference.md) — Full `withRateLimit`, `withRateLimitAction`, `getClientIp` signatures
- [Configuration Guide](configuration.md) — TOML config and limiter setup
- [Patterns: Authentication Protection](patterns/authentication-protection.md) — Auth endpoint patterns
- [Patterns: API Tiering](patterns/api-tiering.md) — Per-tier rate limits
