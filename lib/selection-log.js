/**
 * Account selection log: one JSON line per selection, with the usage data every
 * account had at that moment and why each was kept or dropped, so a surprising
 * pick can be traced after the fact.
 *
 * Written to {CONFIG_DIR}/logs/account-selection.log.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './config.js';
import { readCache } from './cache.js';
import { excludeReason, drainScore } from './scorer.js';
import { redactSecrets } from './timing.js';

const LOG_PATH = path.join(CONFIG_DIR, 'logs', 'account-selection.log');
// Args can carry prompt text; keep each short
const MAX_ARG_LEN = 200;

/**
 * @param {object} p
 * @param {string} p.command - run | resume | rate-limit-switch
 * @param {string[]} [p.args] - Arguments passed on to claude
 * @param {string|null} [p.requested] - --account value, if any
 * @param {string} p.via - requested | single | scored | fallback-first | rate-limit-switch
 * @param {Array} [p.accounts] - Accounts with usage, as given to the scorer
 * @param {string} [p.excludeName] - Account name the scorer was told to skip
 * @param {string|null} p.selected - Chosen account name (null if none)
 * @param {string|null} [p.reason] - Scorer's reason string
 * @param {number} [p.now]
 */
export function buildSelectionEntry({ command, args = [], requested = null, via, accounts = [], excludeName, selected, reason = null, now = Date.now() }) {
  return {
    ts: new Date(now).toISOString(),
    command,
    args: args.map(a => {
      const s = String(a);
      return s.length > MAX_ARG_LEN ? `${s.slice(0, MAX_ARG_LEN)}…` : s;
    }),
    requested,
    via,
    excludeName: excludeName ?? null,
    accounts: accounts.map(a => {
      const cachedAt = readCache(a.configDir)?.cachedTimestamp;
      const score = drainScore(a.usage ?? null);
      return {
        name: a.name,
        priority: a.priority ?? null,
        hasToken: Boolean(a.token),
        sessionPercent: a.usage?.sessionPercent ?? null,
        weeklyPercent: a.usage?.weeklyPercent ?? null,
        sessionRemainingTimePercent: a.usage?.sessionRemainingTimePercent ?? null,
        weeklyRemainingTimePercent: a.usage?.weeklyRemainingTimePercent ?? null,
        sessionResetsAt: a.usage?.sessionResetsAt ?? null,
        weeklyResetsAt: a.usage?.weeklyResetsAt ?? null,
        usageError: a.usage?.error ?? null,
        cacheAgeSec: cachedAt ? Math.round((now - cachedAt) / 1000) : null,
        drainScore: Number.isFinite(score) ? Math.round(score * 1000) / 1000 : null,
        excluded: excludeReason(a, excludeName),
      };
    }),
    selected,
    reason,
  };
}

export function logSelection(params) {
  try {
    const line = redactSecrets(JSON.stringify(buildSelectionEntry(params))) + '\n';
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
  } catch {
    // Silent fail on write error
  }
}
