/**
 * Account scoring and selection.
 *
 * Picks the account whose remaining capacity is most at risk of being wasted —
 * i.e., the account with the highest "drain urgency":
 *
 *   urgency = availableCapacity / remainingTimePercent
 *
 * An account with lots of capacity left but an imminent reset scores high and
 * is selected first so those credits are not lost.  Weekly urgency is weighted
 * 34× more than session urgency because a 7-day window is ~33.6× longer than a
 * 5-hour window (7 × 24 / 5 ≈ 33.6).
 *
 * When usePriority is true, accounts with lower priority numbers are preferred.
 * Accounts at or above 98% utilization are considered "near-exhausted" and
 * skipped in favor of the next priority level.
 *
 * Accounts with stale cache (> 5 minutes old) are treated as having an API limit error
 * and excluded from selection.
 */

import { isCacheStale, readCache } from './cache.js';

const PRIORITY_THRESHOLD = 98;

// Empirical weight: how much more a 1% weekly capacity loss matters vs 1% session loss.
// Based on observation that ~8-10 full sessions exhaust the weekly quota (~9x capacity ratio).
// Tune this value based on experience: increase to prioritize weekly more, decrease for session.
const WEEKLY_WEIGHT = 5;

/**
 * Pick the best account from a list of accounts with usage data.
 *
 * Selection logic:
 * 1. Filter to accounts under 100% utilization (not exhausted)
 * 2. If any remain: sort by drain score (or priority if enabled)
 * 3. If all exhausted: fall back to extra credit selection
 *
 * @param {Array<{name: string, configDir: string, token: string, usage: object, priority?: number}>} accounts
 * @param {string} [excludeName] - Account name to exclude (e.g., the one that just hit a limit)
 * @param {object} [options]
 * @param {boolean} [options.usePriority=false] - When true, prefer accounts by priority number
 * @returns {{ account: object, reason: string } | null}
 */
export function pickBestAccount(accounts, excludeName, options = {}) {
  const candidates = accounts.filter(a => {
    if (a.name === excludeName) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    // Exclude 100% exhausted accounts
    if (effectiveUtilization(a.usage) >= 100) return false;
    // Exclude accounts with stale cache (> 5 minutes old, indicates API limit issue)
    const cache = readCache(a.configDir);
    if (isCacheStale(cache)) return false;
    return true;
  });

  if (candidates.length === 0) {
    // All regular accounts exhausted — try extra credit fallback
    return pickByExtraCredit(accounts, excludeName);
  }

  if (options.usePriority) {
    // Priority-aware sorting:
    // 1. Non-exhausted (< 98%) before exhausted (>= 98%)
    // 2. Within each group: lower priority number first (nulls last)
    // 3. Tiebreaker: higher drain score first
    candidates.sort((a, b) => {
      const aUtil = effectiveUtilization(a.usage);
      const bUtil = effectiveUtilization(b.usage);
      const aExhausted = aUtil >= PRIORITY_THRESHOLD;
      const bExhausted = bUtil >= PRIORITY_THRESHOLD;

      // Non-exhausted accounts always come first
      if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;

      // Within same exhaustion group: sort by priority (lower = better, null = last)
      const aPri = a.priority ?? Infinity;
      const bPri = b.priority ?? Infinity;
      if (aPri !== bPri) return aPri - bPri;

      // Same priority: higher drain score first
      return drainScore(b.usage) - drainScore(a.usage);
    });

    const best = candidates[0];
    const pri = best.priority != null ? `, priority: ${best.priority}` : '';

    return {
      account: best,
      reason: `priority selection (session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%${pri})`,
    };
  }

  // Default: sort by drain score (descending — most urgent to use first)
  candidates.sort((a, b) => drainScore(b.usage) - drainScore(a.usage));

  const best = candidates[0];

  return {
    account: best,
    reason: `drain selection (session: ${best.usage?.sessionPercent ?? 0}%, weekly: ${best.usage?.weeklyPercent ?? 0}%)`,
  };
}

/**
 * Pick the best account using priority hierarchy.
 * Convenience wrapper for `use --priority`.
 *
 * @param {Array} accounts - Accounts with usage data
 * @returns {{ account: object, reason: string } | null}
 */
export function pickByPriority(accounts) {
  return pickBestAccount(accounts, undefined, { usePriority: true });
}

/**
 * Calculate effective utilization — the higher of session or weekly.
 * Used for exhaustion detection in priority mode.
 */
export function effectiveUtilization(usage) {
  if (!usage) return 100;
  return Math.max(usage.sessionPercent || 0, usage.weeklyPercent || 0);
}

/**
 * Compute a drain urgency score for an account's usage.
 *
 * Score = weeklyUrgency * WEEKLY_WEIGHT + sessionUrgency
 *   where urgency = availableCapacity / (remainingTimePercent + 1)
 *
 * Higher score = more important to use this account now before its window resets.
 * Returns -Infinity for null usage or accounts blocked in either window (>= 98%).
 *
 * @param {object|null} usage
 * @returns {number}
 */
export function drainScore(usage) {
  if (!usage) return -Infinity;
  const { sessionPercent = 0, weeklyPercent = 0 } = usage;
  if (sessionPercent >= PRIORITY_THRESHOLD || weeklyPercent >= PRIORITY_THRESHOLD) return -Infinity;

  const sessionRemaining = usage.sessionRemainingTimePercent;
  const weeklyRemaining  = usage.weeklyRemainingTimePercent;

  const sessionUrgency = (100 - sessionPercent) / (sessionRemaining + 1);
  const weeklyUrgency  = (100 - weeklyPercent)  / (weeklyRemaining  + 1);

  return weeklyUrgency * WEEKLY_WEIGHT + sessionUrgency;
}

/**
 * Compute credit usage score for an account's extra_usage.
 *
 * Score = remaining credit / (remaining time % + 1)
 *
 * Higher score = more credit at risk of being wasted (urgent to use).
 * Returns -Infinity if extra_usage disabled, no data, or no remaining credit.
 *
 * @param {object|null} usage
 * @returns {number}
 */
function creditScore(usage) {
  if (!usage || !usage.raw) return -Infinity;
  const extra = usage.raw.extra_usage;
  if (!extra || !extra.is_enabled) return -Infinity;

  const utilized = Number(extra.utilization) || 0;
  const remaining = 100 - utilized;

  if (remaining <= 0) return -Infinity;

  // Estimate remaining time in 30-day monthly window (50% default)
  const monthlyRemaining = 50;

  return remaining / (monthlyRemaining + 1);
}

/**
 * Pick best account using extra credit scoring (fallback when all regular accounts exhausted).
 *
 * Filters to accounts with enabled extra_usage and remaining credit > 0.
 * Sorts by credit urgency score (most at risk first).
 *
 * @param {Array} accounts - Accounts with usage data
 * @param {string} [excludeName] - Account name to exclude
 * @returns {{ account: object, reason: string } | null}
 */
function pickByExtraCredit(accounts, excludeName) {
  const candidates = accounts.filter(a => {
    if (a.name === excludeName) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    const extra = a.usage?.raw?.extra_usage;
    if (!extra || !extra.is_enabled) return false;
    const remaining = 100 - (Number(extra.utilization) || 0);
    if (remaining <= 0) return false;
    // Exclude accounts with stale cache
    const cache = readCache(a.configDir);
    if (isCacheStale(cache)) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort by credit score (descending)
  candidates.sort((a, b) => creditScore(b.usage) - creditScore(a.usage));

  const best = candidates[0];
  const extra = best.usage?.raw?.extra_usage;
  const utilized = Math.round(Number(extra.utilization) || 0);

  return {
    account: best,
    reason: `extra credit selection (${utilized}% used, regular limits exhausted)`,
  };
}

export { PRIORITY_THRESHOLD };
