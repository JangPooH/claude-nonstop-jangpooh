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
 */

const PRIORITY_THRESHOLD = 98;

// Empirical weight: how much more a 1% weekly capacity loss matters vs 1% session loss.
// Based on observation that ~8-10 full sessions exhaust the weekly quota (~9x capacity ratio).
// Tune this value based on experience: increase to prioritize weekly more, decrease for session.
const WEEKLY_WEIGHT = 5;

/**
 * Pick the best account from a list of accounts with usage data.
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
    return true;
  });

  if (candidates.length === 0) return null;

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

  const sessionRemaining = usage.sessionRemainingTimePercent ?? 50;
  const weeklyRemaining  = usage.weeklyRemainingTimePercent  ?? 50;

  const sessionUrgency = (100 - sessionPercent) / (sessionRemaining + 1);
  const weeklyUrgency  = (100 - weeklyPercent)  / (weeklyRemaining  + 1);

  return weeklyUrgency * WEEKLY_WEIGHT + sessionUrgency;
}

export { PRIORITY_THRESHOLD };
