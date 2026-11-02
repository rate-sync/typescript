/**
 * Public entry for the `ioredis`-backed rate limit store.
 *
 * Use this entry when the host application already depends on `ioredis`.
 * Behaviour is identical to the node-redis variant in `@rate-sync/rate-sync/redis`,
 * since both share the same Lua scripts.
 *
 * @example
 * ```typescript
 * import IORedis from 'ioredis';
 * import { IORedisStore } from '@rate-sync/rate-sync/ioredis';
 * import { RateLimiter } from '@rate-sync/rate-sync';
 *
 * const redis = new IORedis(process.env.REDIS_URL!);
 * const store = new IORedisStore({ client: redis });
 * const limiter = new RateLimiter({
 *   id: 'api',
 *   store,
 *   storeId: 'ioredis',
 *   algorithm: 'sliding-window',
 *   limit: 60,
 *   windowSeconds: 60,
 * });
 * await limiter.initialize();
 * const result = await limiter.checkLimit('user:42');
 * ```
 */
export { IORedisStore } from './engines/redis/ioredis-store.js';
export type { IORedisStoreOptions } from './engines/redis/ioredis-store.js';
