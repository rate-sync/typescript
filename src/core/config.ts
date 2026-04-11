import { readFileSync } from 'node:fs';
import { configureStore, configureLimiter, initializeAllLimiters } from './registry.js';
import { ConfigValidationError } from './errors.js';
import type { RateSyncConfig, SupportedEngineConfig, LimiterConfig } from './schemas.js';

// ---------------------------------------------------------------------------
// expandEnvVars
// ---------------------------------------------------------------------------

/**
 * Recursively expand environment variable references in a parsed value.
 *
 * - `${VAR:-default}` → process.env[VAR] ?? default
 * - `${VAR}` → process.env[VAR] ?? ''
 * - Numeric strings are auto-converted: "42" → 42, "1.5" → 1.5
 */
export function expandEnvVars(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value);
    }
    return result;
  }

  if (typeof obj === 'string') {
    // Replace ${VAR:-default} first (more specific pattern)
    let expanded = obj.replace(
      /\$\{([^}:]+):-([^}]+)\}/g,
      (_match, varName: string, defaultVal: string) => {
        return process.env[varName] ?? defaultVal;
      },
    );

    // Replace ${VAR} (no default)
    expanded = expanded.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? '';
    });

    // Auto-convert numeric strings
    if (expanded !== '') {
      const asInt = Number(expanded);
      if (!isNaN(asInt) && String(asInt) === expanded) {
        return asInt;
      }
      const asFloat = parseFloat(expanded);
      if (!isNaN(asFloat) && String(asFloat) === expanded) {
        return asFloat;
      }
    }

    return expanded;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// snakeToCamel
// ---------------------------------------------------------------------------

/**
 * Convert a snake_case string to camelCase.
 * Example: rate_per_second → ratePerSecond
 */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

// ---------------------------------------------------------------------------
// snakeToCamelKeys
// ---------------------------------------------------------------------------

/**
 * Recursively convert all object keys from snake_case to camelCase.
 */
export function snakeToCamelKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamelKeys);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamel(key)] = snakeToCamelKeys(value);
    }
    return result;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load and apply a TOML config file.
 *
 * Steps:
 * 1. Read and parse the TOML file
 * 2. Expand environment variable references
 * 3. Convert snake_case keys to camelCase
 * 4. Configure stores and limiters in the registry
 */
export async function loadConfig(configPath: string): Promise<void> {
  let parse: (input: string) => Record<string, unknown>;
  try {
    const toml = await import('smol-toml');
    parse = toml.parse;
  } catch {
    throw new ConfigValidationError(
      'smol-toml is required for TOML config. Install it: pnpm add smol-toml',
      'config_file',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new ConfigValidationError(
      `Failed to read config file "${configPath}": ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new ConfigValidationError(
      `Failed to parse TOML config "${configPath}": ${(err as Error).message}`,
    );
  }

  const expanded = expandEnvVars(parsed) as Record<string, unknown>;

  // Extract stores and limiters sections before key conversion.
  // The section IDs (store names, limiter names) are user-defined identifiers
  // and must be preserved as-is. Only the config properties within each entry
  // should be converted from snake_case to camelCase.
  //
  // NOTE: snakeToCamelKeys only converts object KEYS, not string VALUES.
  // Algorithm names like "token-bucket" / "sliding-window" (hyphens) must be
  // written verbatim in TOML — they are NOT affected by this conversion.
  // Example: algorithm = "token-bucket"  (correct)
  //          algorithm = "token_bucket"  (wrong — will not be recognised)
  const rawStores = (expanded.stores ?? {}) as Record<string, unknown>;
  const rawLimiters = (expanded.limiters ?? {}) as Record<string, unknown>;

  if (Object.keys(rawStores).length === 0 && Object.keys(rawLimiters).length === 0) {
    throw new ConfigValidationError(
      'Configuration file contains no stores or limiters',
      'config_file',
    );
  }

  for (const [id, config] of Object.entries(rawStores)) {
    const converted = snakeToCamelKeys(config) as SupportedEngineConfig;
    await configureStore(id, converted);
  }

  for (const [id, config] of Object.entries(rawLimiters)) {
    const converted = snakeToCamelKeys(config) as LimiterConfig;
    configureLimiter(id, converted);
  }
}

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

// ---------------------------------------------------------------------------
// setupRateSync
// ---------------------------------------------------------------------------

/**
 * Load config from a TOML file and initialize all configured limiters.
 */
export async function setupRateSync(configPath: string): Promise<void> {
  await loadConfig(configPath);
  await initializeAllLimiters();
}
