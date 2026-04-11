import { MemoryStore } from '../engines/memory/index.js';
import { configureStore, configureLimiter, initializeLimiter, checkLimiter, closeAll } from '../core/registry.js';
import type { LimiterConfig } from '../core/schemas.js';
import type { RateLimitStore } from '../engines/base.js';

export function createTestStore(): RateLimitStore {
  return new MemoryStore();
}

export function setupTestRateSync(limiters: Record<string, Partial<LimiterConfig>>): void {
  configureStore('__test_memory', { engine: 'memory' });
  for (const [id, config] of Object.entries(limiters)) {
    configureLimiter(id, { store: '__test_memory', ...config } as LimiterConfig);
  }
}

export async function resetAllLimiters(): Promise<void> {
  await closeAll();
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
