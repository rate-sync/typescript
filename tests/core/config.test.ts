import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandEnvVars,
  snakeToCamel,
  snakeToCamelKeys,
  loadConfig,
  defineConfig,
  setupRateSync,
} from '../../src/core/config.js';
import { listStores, listLimiters, closeAll } from '../../src/core/registry.js';
import { ConfigValidationError } from '../../src/core/errors.js';

beforeEach(async () => {
  await closeAll();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await closeAll();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// expandEnvVars
// ---------------------------------------------------------------------------

describe('expandEnvVars', () => {
  it('replaces ${VAR} with env var value', () => {
    vi.stubEnv('MY_VAR', 'hello');
    expect(expandEnvVars('${MY_VAR}')).toBe('hello');
  });

  it('replaces ${VAR} with empty string when env var is not set', () => {
    expect(expandEnvVars('${UNSET_VAR_XYZ}')).toBe('');
  });

  it('replaces ${VAR:-default} with default when env var not set', () => {
    expect(expandEnvVars('${UNSET_VAR_XYZ:-mydefault}')).toBe('mydefault');
  });

  it('replaces ${VAR:-default} with env var value when set', () => {
    vi.stubEnv('MY_VAR', 'actual');
    expect(expandEnvVars('${MY_VAR:-fallback}')).toBe('actual');
  });

  it('auto-converts integer string to number', () => {
    vi.stubEnv('PORT', '8080');
    expect(expandEnvVars('${PORT}')).toBe(8080);
  });

  it('auto-converts float string to number', () => {
    vi.stubEnv('RATE', '1.5');
    expect(expandEnvVars('${RATE}')).toBe(1.5);
  });

  it('keeps plain string as string', () => {
    expect(expandEnvVars('hello')).toBe('hello');
  });

  it('auto-converts integer default to number', () => {
    expect(expandEnvVars('${UNSET_VAR_XYZ:-42}')).toBe(42);
  });

  it('auto-converts float default to number', () => {
    expect(expandEnvVars('${UNSET_VAR_XYZ:-3.14}')).toBe(3.14);
  });

  it('recurses into objects', () => {
    vi.stubEnv('DB_HOST', 'localhost');
    const result = expandEnvVars({ host: '${DB_HOST}', port: '5432' });
    expect(result).toEqual({ host: 'localhost', port: 5432 });
  });

  it('recurses into arrays', () => {
    vi.stubEnv('HOST', 'redis.local');
    const result = expandEnvVars(['${HOST}', '6379']);
    expect(result).toEqual(['redis.local', 6379]);
  });

  it('returns non-string primitives as-is', () => {
    expect(expandEnvVars(42)).toBe(42);
    expect(expandEnvVars(true)).toBe(true);
    expect(expandEnvVars(null)).toBe(null);
  });

  it('handles nested object with array', () => {
    vi.stubEnv('VAL', 'test');
    const result = expandEnvVars({ list: ['${VAL}', 'plain'] });
    expect(result).toEqual({ list: ['test', 'plain'] });
  });
});

// ---------------------------------------------------------------------------
// snakeToCamel
// ---------------------------------------------------------------------------

describe('snakeToCamel', () => {
  it('converts rate_per_second to ratePerSecond', () => {
    expect(snakeToCamel('rate_per_second')).toBe('ratePerSecond');
  });

  it('converts window_seconds to windowSeconds', () => {
    expect(snakeToCamel('window_seconds')).toBe('windowSeconds');
  });

  it('leaves already camelCase strings unchanged', () => {
    expect(snakeToCamel('ratePerSecond')).toBe('ratePerSecond');
  });

  it('leaves plain words unchanged', () => {
    expect(snakeToCamel('url')).toBe('url');
    expect(snakeToCamel('store')).toBe('store');
  });

  it('converts single underscore prefix correctly', () => {
    expect(snakeToCamel('fail_closed')).toBe('failClosed');
  });

  it('handles multiple underscores', () => {
    expect(snakeToCamel('a_b_c')).toBe('aBC');
  });
});

// ---------------------------------------------------------------------------
// snakeToCamelKeys
// ---------------------------------------------------------------------------

describe('snakeToCamelKeys', () => {
  it('converts top-level keys', () => {
    const result = snakeToCamelKeys({ rate_per_second: 10, window_seconds: 60 });
    expect(result).toEqual({ ratePerSecond: 10, windowSeconds: 60 });
  });

  it('recurses into nested objects', () => {
    const result = snakeToCamelKeys({ outer_key: { inner_key: 'value' } });
    expect(result).toEqual({ outerKey: { innerKey: 'value' } });
  });

  it('recurses into arrays of objects', () => {
    const result = snakeToCamelKeys([{ some_key: 1 }, { other_key: 2 }]);
    expect(result).toEqual([{ someKey: 1 }, { otherKey: 2 }]);
  });

  it('leaves non-object values as-is', () => {
    expect(snakeToCamelKeys('hello')).toBe('hello');
    expect(snakeToCamelKeys(42)).toBe(42);
    expect(snakeToCamelKeys(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  function writeTempToml(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'rate-sync-test-'));
    const filePath = join(dir, 'config.toml');
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('configures a memory store from TOML', () => {
    const toml = `
[stores.main]
engine = "memory"

[limiters.api]
store = "main"
algorithm = "token-bucket"
rate_per_second = 10
`;
    const path = writeTempToml(toml);
    loadConfig(path);

    expect(listStores()).toContain('main');
    expect(listLimiters()).toContain('api');
  });

  it('converts snake_case keys to camelCase for limiters', () => {
    const toml = `
[stores.mem]
engine = "memory"

[limiters.sliding]
store = "mem"
algorithm = "sliding-window"
limit = 100
window_seconds = 60
`;
    const path = writeTempToml(toml);
    loadConfig(path);

    expect(listLimiters()).toContain('sliding');
  });

  it('expands env vars in TOML values', () => {
    vi.stubEnv('TEST_ENGINE', 'memory');
    const toml = `
[stores.env_store]
engine = "\${TEST_ENGINE}"
`;
    const path = writeTempToml(toml);
    loadConfig(path);

    expect(listStores()).toContain('env_store');
  });

  it('expands env vars with defaults', () => {
    const toml = `
[stores.default_store]
engine = "\${NONEXISTENT_ENGINE:-memory}"
`;
    const path = writeTempToml(toml);
    loadConfig(path);

    expect(listStores()).toContain('default_store');
  });

  it('configures multiple stores and limiters', () => {
    const toml = `
[stores.store_a]
engine = "memory"

[stores.store_b]
engine = "memory"

[limiters.lim_a]
store = "store_a"
algorithm = "token-bucket"
rate_per_second = 5

[limiters.lim_b]
store = "store_b"
algorithm = "sliding-window"
limit = 20
window_seconds = 30
`;
    const path = writeTempToml(toml);
    loadConfig(path);

    const stores = listStores();
    const limiters = listLimiters();

    expect(stores).toContain('store_a');
    expect(stores).toContain('store_b');
    expect(limiters).toContain('lim_a');
    expect(limiters).toContain('lim_b');
  });

  it('throws ConfigValidationError when file not found', () => {
    expect(() => loadConfig('/nonexistent/path/config.toml')).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError on invalid TOML', () => {
    const path = writeTempToml('this is not valid toml ===');
    expect(() => loadConfig(path)).toThrow(ConfigValidationError);
  });

  it('handles TOML with no limiters section gracefully', () => {
    const toml = `
[stores.only_store]
engine = "memory"
`;
    const path = writeTempToml(toml);
    expect(() => loadConfig(path)).not.toThrow();
    expect(listStores()).toContain('only_store');
    expect(listLimiters()).toHaveLength(0);
  });

  it('handles TOML with no stores section gracefully', () => {
    const toml = `
# empty config
`;
    const path = writeTempToml(toml);
    expect(() => loadConfig(path)).not.toThrow();
    expect(listStores()).toHaveLength(0);
    expect(listLimiters()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

describe('defineConfig', () => {
  it('returns the same config object (identity function)', () => {
    const config = {
      stores: { main: { engine: 'memory' as const } },
      limiters: { api: { store: 'main', algorithm: 'token-bucket' as const, ratePerSecond: 10 } },
    };
    expect(defineConfig(config)).toBe(config);
  });
});

// ---------------------------------------------------------------------------
// setupRateSync
// ---------------------------------------------------------------------------

describe('setupRateSync', () => {
  it('loads config and initializes all limiters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rate-sync-test-'));
    const filePath = join(dir, 'setup.toml');
    writeFileSync(filePath, `
[stores.mem]
engine = "memory"

[limiters.api]
store = "mem"
algorithm = "token-bucket"
rate_per_second = 10
`, 'utf-8');

    await setupRateSync(filePath);

    expect(listStores()).toContain('mem');
    expect(listLimiters()).toContain('api');
  });

  it('rejects with ConfigValidationError when file not found', async () => {
    await expect(setupRateSync('/no/such/file.toml')).rejects.toThrow(ConfigValidationError);
  });
});
