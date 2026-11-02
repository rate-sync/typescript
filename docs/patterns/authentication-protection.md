# Authentication Protection

> **Requires:** `npm install @rate-sync/rate-sync redis` for the Redis-backed examples below.

Protect auth endpoints against brute force, credential stuffing, and account enumeration using composite rate limiting.

## Configuration

```typescript
// rate-sync.config.ts
import { defineConfig } from '@rate-sync/rate-sync';

export default defineConfig({
  stores: {
    'security-cache': { engine: 'redis', url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
  },
  limiters: {
    // Layer 1: IP-based (stops scanning)
    auth_ip: { store: 'security-cache', algorithm: 'sliding-window', limit: 30, windowSeconds: 60 },
    // Layer 2: Credential-based (stops brute force)
    auth_credential: { store: 'security-cache', algorithm: 'sliding-window', limit: 5, windowSeconds: 300 },
  },
});
```

## Implementation

### Next.js API Route

```typescript
// app/api/auth/login/route.ts
import { checkMultiLimiters } from '@rate-sync/rate-sync';
import { getClientIp, getRateLimitHeaders } from '@rate-sync/rate-sync/next';
import { hashIdentifier, combineIdentifiers } from '@rate-sync/rate-sync';

export async function POST(req: Request) {
  const { email, password } = await req.json();

  const ip = getClientIp(req as any);
  const emailHash = hashIdentifier(email);
  const credentialKey = combineIdentifiers(ip, emailHash);

  const result = await checkMultiLimiters(
    ['auth_ip', 'auth_credential'],
    [ip, credentialKey],
  );

  if (!result.allowed) {
    const blockingResult = result.results.find((r) => !r.allowed)!;
    return Response.json(
      { error: 'Too many attempts. Try again later.' },
      { status: 429, headers: getRateLimitHeaders(blockingResult) },
    );
  }

  // Authentication logic
  const user = await verifyCredentials(email, password);
  if (!user) {
    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  return Response.json({ token: await createToken(user) });
}
```

### Server Action

```typescript
// app/actions/auth.ts
'use server';

import { withRateLimitAction, isRateLimitActionError } from '@rate-sync/rate-sync/next';
import { hashIdentifier, combineIdentifiers } from '@rate-sync/rate-sync';
import { headers } from 'next/headers';

export const loginAction = withRateLimitAction(
  async (email: string, password: string) => {
    const user = await verifyCredentials(email, password);
    if (!user) return { error: 'Invalid credentials' };
    return { token: await createToken(user) };
  },
  {
    limiterId: ['auth_ip', 'auth_credential'],
    keyExtractor: async (email: string) => {
      const h = await headers();
      const ip = h.get('x-forwarded-for') ?? '127.0.0.1';
      return ip;  // used for both limiters in sequence
    },
  },
);
```

## Variations

### Password Reset (Stricter)

```typescript
// In your defineConfig limiters:
reset_ip: { store: 'security-cache', algorithm: 'sliding-window', limit: 5, windowSeconds: 600 },
reset_email: { store: 'security-cache', algorithm: 'sliding-window', limit: 3, windowSeconds: 3600 },
```

```typescript
// app/api/auth/reset/route.ts
export async function POST(req: Request) {
  const { email } = await req.json();
  const ip = getClientIp(req as any);
  const emailHash = hashIdentifier(email);

  const result = await checkMultiLimiters(
    ['reset_ip', 'reset_email'],
    [ip, emailHash],
  );

  if (!result.allowed) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }

  await sendPasswordResetEmail(email);
  return Response.json({ ok: true });
}
```

### Registration (Anti-Spam)

```typescript
// In your defineConfig limiters:
register_ip: { store: 'security-cache', algorithm: 'sliding-window', limit: 3, windowSeconds: 3600 },
```

```typescript
export async function POST(req: Request) {
  const ip = getClientIp(req as any);
  const result = await checkLimiter('register_ip', ip);

  if (!result.allowed) {
    return Response.json({ error: 'Too many registrations from this IP' }, { status: 429 });
  }

  // create user account...
}
```

## How It Works

| Layer | Protects Against | Limit |
|-------|------------------|-------|
| IP | Scanning, enumeration | 30/min |
| Credential | Brute force on specific account | 5/5min |

Attacker using many IPs? Blocked by the credential layer.
Attacker using one IP? Blocked by the IP layer.

Using `hashIdentifier` ensures that email addresses are never stored in plaintext in Redis keys or logs.

## See Also

- [API Tiering](./api-tiering.md) — Different limits per user tier
- [API Reference](../api-reference.md) — `checkMultiLimiters`, `hashIdentifier`, `combineIdentifiers`
- [Next.js Integration](../nextjs-integration.md) — `withRateLimit`, `withRateLimitAction`
