import { MemoryStore } from '../engines/memory/index.js';
import { configureStore, configureLimiter, initializeLimiter, checkLimiter, listLimiters, getLimiter } from '../core/registry.js';
import type { LimiterConfig } from '../core/schemas.js';
import type { RateLimitStore } from '../engines/base.js';

export function createTestStore(): RateLimitStore {
  return new MemoryStore();
}

export async function setupTestRateSync(limiters: Record<string, Partial<LimiterConfig>>): Promise<void> {
  await configureStore('__test_memory', { engine: 'memory' });
  for (const [id, config] of Object.entries(limiters)) {
    configureLimiter(id, { store: '__test_memory', ...config } as LimiterConfig);
  }
}

/**
 * Resets all limiter state without destroying the registry.
 * This is safer than closeAll() for test isolation — it preserves configured
 * stores and limiters while clearing accumulated rate-limit counters.
 */
export async function resetAllLimiters(): Promise<void> {
  const ids = listLimiters();
  for (const id of ids) {
    const limiter = getLimiter(id);
    if (limiter.isInitialized) {
      await limiter.resetState();
    }
  }
}

export async function expectAllowed(limiterId: string, identifier?: string): Promise<void> {
  await initializeLimiter(limiterId);
  const result = await checkLimiter(limiterId, identifier);
  if (!result.allowed) throw new Error(`Expected "${limiterId}" to allow, but it blocked`);
}

export async function expectBlocked(limiterId: string, identifier?: string): Promise<void> {
  await initializeLimiter(limiterId);
  const result = await checkLimiter(limiterId, identifier);
  if (result.allowed) throw new Error(`Expected "${limiterId}" to block, but it allowed`);
}
