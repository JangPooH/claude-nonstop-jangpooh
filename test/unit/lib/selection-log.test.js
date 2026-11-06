import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSelectionEntry } from '../../../lib/selection-log.js';
import { excludeReason } from '../../../lib/scorer.js';
import { writeCache } from '../../../lib/cache.js';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir.js';

const cacheRoot = createTempDir('cn-selection-log-');
after(() => removeTempDir(cacheRoot));

const makeAccount = (name, usage, opts = {}) => {
  const configDir = path.join(cacheRoot, name);
  writeCache(configDir, {}, opts.cachedAt ?? Date.now());
  return { name, configDir, token: 'token' in opts ? opts.token : 'tok', usage };
};

const ok = { sessionPercent: 10, weeklyPercent: 20, sessionRemainingTimePercent: 50, weeklyRemainingTimePercent: 50 };

describe('excludeReason', () => {
  it('returns null for a usable account', () => {
    assert.equal(excludeReason(makeAccount('a', ok)), null);
  });

  it('names each exclusion cause', () => {
    assert.equal(excludeReason(makeAccount('a', ok), 'a'), 'excluded-name');
    assert.equal(excludeReason(makeAccount('b', ok, { token: null })), 'no-token');
    assert.equal(excludeReason(makeAccount('c', { error: 'HTTP 500' })), 'usage-error: HTTP 500');
    assert.equal(excludeReason(makeAccount('d', { ...ok, sessionPercent: 100 })), 'exhausted');
    assert.equal(excludeReason(makeAccount('e', ok, { cachedAt: Date.now() - 10 * 60_000 })), 'stale-cache');
  });
});

describe('buildSelectionEntry', () => {
  it('records usage, exclusion reason and drain score per account', () => {
    const accounts = [makeAccount('a', ok), makeAccount('b', { error: 'timeout' })];
    const entry = buildSelectionEntry({ command: 'run', via: 'scored', accounts, selected: 'a', reason: 'drain selection' });
    assert.equal(entry.selected, 'a');
    assert.equal(entry.accounts[0].excluded, null);
    assert.equal(entry.accounts[0].sessionPercent, 10);
    assert.ok(Number.isFinite(entry.accounts[0].drainScore));
    assert.equal(entry.accounts[1].usageError, 'timeout');
    assert.equal(entry.accounts[1].excluded, 'usage-error: timeout');
    assert.equal(entry.accounts[1].drainScore, null);
  });

  it('truncates long args so prompt text does not fill the log', () => {
    const entry = buildSelectionEntry({ command: 'run', args: ['x'.repeat(500)], via: 'single', selected: 'a' });
    assert.equal(entry.args[0].length, 201);
  });

  it('does not store the account token', () => {
    const entry = buildSelectionEntry({ command: 'run', via: 'scored', accounts: [makeAccount('a', ok)], selected: 'a' });
    assert.ok(!JSON.stringify(entry).includes('"tok"'));
  });
});
