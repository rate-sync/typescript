import { configureStore, configureLimiter, initializeAllLimiters } from './registry.js';
import type { RateSyncConfig, SupportedEngineConfig } from './schemas.js';

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

/**
 * Identity function for type-safe programmatic config definition.
 */
export function defineConfig(config: RateSyncConfig): RateSyncConfig {
  return config;
}

// ---------------------------------------------------------------------------
// setupRateSyncFromConfig
// ---------------------------------------------------------------------------

/**
 * Configure rate-sync programmatically from a config object.
 * This is the recommended approach for TypeScript projects.
 *
 * @example
 * ```typescript
 * // rate-sync.config.ts
 * import { defineConfig } from 'rate-sync';
 * export default defineConfig({ stores: {...}, limiters: {...} });
 *
 * // instrumentation.ts
 * import config from './rate-sync.config';
 * import { setupRateSyncFromConfig } from 'rate-sync';
 * await setupRateSyncFromConfig(config);
 * ```
 */
export async function setupRateSyncFromConfig(config: RateSyncConfig): Promise<void> {
  for (const [id, storeConfig] of Object.entries(config.stores)) {
    await configureStore(id, storeConfig as SupportedEngineConfig);
  }
  for (const [id, limiterConfig] of Object.entries(config.limiters)) {
    configureLimiter(id, limiterConfig);
  }
  await initializeAllLimiters();
}
