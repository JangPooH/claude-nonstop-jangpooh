import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldRefreshCache, writeCache, CACHE_INTERVAL_MS } from '../../../lib/cache.js';
import { checkUsage } from '../../../lib/usage.js';

describe('shouldRefreshCache intervalMs', () => {
  const now = 1_000_000;

  it('defaults to CACHE_INTERVAL_MS', () => {
    const fresh = { cachedTimestamp: now - (CACHE_INTERVAL_MS - 1) };
    const stale = { cachedTimestamp: now - (CACHE_INTERVAL_MS + 1) };
    assert.equal(shouldRefreshCache(fresh, null, now), false);
    assert.equal(shouldRefreshCache(stale, null, now), true);
  });

  it('honors a shorter window', () => {
    const cache = { cachedTimestamp: now - 40_000 };
    assert.equal(shouldRefreshCache(cache, null, now), false); // within 60s default
    assert.equal(shouldRefreshCache(cache, null, now, 30_000), true); // beyond 30s
  });

  it('counts the last API call as warm even when the cache is old', () => {
    const cache = { cachedTimestamp: now - 600_000 };
    assert.equal(shouldRefreshCache(cache, now - 5_000, now, 30_000), false);
  });
});

describe('checkUsage maxAgeMs', () => {
  it('serves a cache younger than maxAgeMs without calling the API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonstop-cache-'));
    try {
      const raw = { five_hour: { utilization: 42, resets_at: null }, seven_day: { utilization: 7, resets_at: null } };
      writeCache(dir, raw, Date.now() - 20_000);
      const usage = await checkUsage('unused-token', dir, { maxAgeMs: 30_000 });
      assert.equal(usage.error, null);
      assert.equal(usage.sessionPercent, 42);
      assert.equal(usage.weeklyPercent, 7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
