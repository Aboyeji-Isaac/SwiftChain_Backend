/**
 * Unit tests for the validated environment schema (issues #213 and #214).
 *
 * The env module parses `process.env` once at import time, so each case
 * builds the schema through a fresh module registry with a controlled
 * environment: `isolatedModules`-style re-import via `jest.resetModules`.
 */

describe('config/env schema', () => {
  const ORIGINAL_ENV = process.env;

  /**
   * Import the env module fresh with the given extra variables applied.
   *
   * `process.exit` is mocked for the duration: `env.ts` calls it on parse
   * failure, and an unmocked exit would kill the jest worker instead of
   * surfacing a test failure. Tests that expect an invalid environment
   * assert on the spy instead.
   */
  const loadEnv = async (
    extra: Record<string, string | undefined>,
  ): Promise<(typeof import('../src/config/env'))['default']> => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      ...extra,
    };
    jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called during env parse');
    }) as never);
    const mod = await import('../src/config/env');
    return mod.default;
  };

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // ── Issue #213: INDEXER_LAG_WEBHOOK_URL ──────────────────────────────────

  it('parses with INDEXER_LAG_WEBHOOK_URL unset, defaulting to an empty string (#213)', async () => {
    const env = await loadEnv({ INDEXER_LAG_WEBHOOK_URL: undefined });
    expect(env.INDEXER_LAG_WEBHOOK_URL).toBe('');
  });

  it('parses INDEXER_LAG_WEBHOOK_URL when set, trimming whitespace (#213)', async () => {
    const env = await loadEnv({ INDEXER_LAG_WEBHOOK_URL: '  https://hooks.example.com/lag  ' });
    expect(env.INDEXER_LAG_WEBHOOK_URL).toBe('https://hooks.example.com/lag');
  });

  it('treats a blank INDEXER_LAG_WEBHOOK_URL as unset so alerts disable cleanly (#213)', async () => {
    const env = await loadEnv({ INDEXER_LAG_WEBHOOK_URL: '' });
    expect(env.INDEXER_LAG_WEBHOOK_URL).toBe('');
  });

  // ── Issue #214: ADMIN_DASHBOARD_CACHE_TTL_SECONDS ────────────────────────

  it('defaults ADMIN_DASHBOARD_CACHE_TTL_SECONDS to 60 when unset (#214)', async () => {
    const env = await loadEnv({ ADMIN_DASHBOARD_CACHE_TTL_SECONDS: undefined });
    expect(env.ADMIN_DASHBOARD_CACHE_TTL_SECONDS).toBe(60);
  });

  it('parses a custom positive ADMIN_DASHBOARD_CACHE_TTL_SECONDS as an integer (#214)', async () => {
    const env = await loadEnv({ ADMIN_DASHBOARD_CACHE_TTL_SECONDS: '120' });
    expect(env.ADMIN_DASHBOARD_CACHE_TTL_SECONDS).toBe(120);
  });

  it('aborts startup on a non-positive ADMIN_DASHBOARD_CACHE_TTL_SECONDS (#214)', async () => {
    // The module exits(1) when parsing fails; the mock turns that into a
    // thrown error so the failure surfaces as a test failure, not a dead
    // jest worker.
    await expect(loadEnv({ ADMIN_DASHBOARD_CACHE_TTL_SECONDS: '0' })).rejects.toThrow(
      /process.exit called/i,
    );
  });

  it('falls back to the default when ADMIN_DASHBOARD_CACHE_TTL_SECONDS is blank (#214)', async () => {
    const env = await loadEnv({ ADMIN_DASHBOARD_CACHE_TTL_SECONDS: '' });
    expect(env.ADMIN_DASHBOARD_CACHE_TTL_SECONDS).toBe(60);
  });

  // ── The repaired schema holds together (issue #213/#214 enablement) ──────

  it('exposes exactly one canonical entry for every previously duplicated key', async () => {
    const env = await loadEnv({});
    // These keys were declared twice on main (issue #213 scope): conflicting
    // defaults resolved in favor of .env.example, single declaration now.
    expect(env.AWS_S3_SIGNED_URL_EXPIRES_SECONDS).toBe(3600);
    expect(env.CB_SOROBAN_ROLLING_WINDOW_MS).toBe(30000);
    expect(env.CB_SOROBAN_RESET_TIMEOUT_MS).toBe(60000);
    expect(env.ETA_CACHE_TTL_SECONDS).toBe(600);
    expect(env.ETA_GEOHASH_PRECISION).toBe(7);
  });

  it('still validates the rest of the schema alongside the new keys', async () => {
    const env = await loadEnv({});
    expect(env.NODE_ENV).toBe('test');
    expect(typeof env.PORT).toBe('number');
    expect(typeof env.JWT_SECRET).toBe('string');
  });
});
