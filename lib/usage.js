/**
 * Query the Anthropic OAuth usage API.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Returns five_hour and seven_day utilization percentages (0-100).
 */

const FETCH_TIMEOUT_MS = 10_000;

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;   // 5 hours
const WEEKLY_WINDOW_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Compute how much of the window's time is remaining, as a 0-100 percentage.
 * Returns null when resets_at is unavailable.
 *
 * @param {string|null} resetsAt - ISO timestamp of the next window reset
 * @param {number} windowMs - Total window duration in milliseconds
 * @param {number} [now] - Current timestamp (injectable for testing)
 * @returns {number|null}
 */
export function computeRemainingTimePercent(resetsAt, windowMs, now = Date.now()) {
  if (!resetsAt) return null;
  const remaining = Math.max(0, new Date(resetsAt).getTime() - now);
  return Math.min(100, (remaining / windowMs) * 100);
}

/**
 * Normalize a utilization value to a 0-100 percentage.
 * Handles both 0.0-1.0 (fraction) and 0-100 (percentage) formats.
 */
// nested format용: utilization이 이미 0-100 정수
export function normalizePercentInt(value) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

// legacy flat format용: utilization이 0.0-1.0 소수
export function normalizePercent(value) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  if (value >= 0 && value <= 1.0) {
    return Math.round(value * 100);
  }
  return Math.round(value);
}

/**
 * Check usage for a single account token.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{sessionPercent: number, weeklyPercent: number, sessionResetsAt: string|null, weeklyResetsAt: string|null, sessionRemainingTimePercent: number|null, weeklyRemainingTimePercent: number|null, error: string|null}>}
 */
export async function checkUsage(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        sessionPercent: 0,
        weeklyPercent: 0,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();

    // New nested format: { five_hour: { utilization: N, resets_at: "..." }, seven_day: { ... } }
    if (data.five_hour !== undefined || data.seven_day !== undefined) {
      const sessionResetsAt = data.five_hour?.resets_at ?? null;
      const weeklyResetsAt  = data.seven_day?.resets_at ?? null;
      return {
        sessionPercent: normalizePercentInt(data.five_hour?.utilization ?? 0),
        weeklyPercent: normalizePercentInt(data.seven_day?.utilization ?? 0),
        sessionResetsAt,
        weeklyResetsAt,
        sessionRemainingTimePercent: computeRemainingTimePercent(sessionResetsAt, SESSION_WINDOW_MS),
        weeklyRemainingTimePercent:  computeRemainingTimePercent(weeklyResetsAt, WEEKLY_WINDOW_MS),
        raw: data,
        error: null,
      };
    }

    // Legacy flat format: { five_hour_utilization: 0.72, ... }
    const sessionResetsAt = data.five_hour_reset_at ?? null;
    const weeklyResetsAt  = data.seven_day_reset_at ?? null;
    return {
      sessionPercent: normalizePercent(data.five_hour_utilization ?? 0),
      weeklyPercent: normalizePercent(data.seven_day_utilization ?? 0),
      sessionResetsAt,
      weeklyResetsAt,
      sessionRemainingTimePercent: computeRemainingTimePercent(sessionResetsAt, SESSION_WINDOW_MS),
      weeklyRemainingTimePercent:  computeRemainingTimePercent(weeklyResetsAt, WEEKLY_WINDOW_MS),
      raw: data,
      error: null,
    };
  } catch (error) {
    return {
      sessionPercent: 0,
      weeklyPercent: 0,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

/**
 * Fetch the account profile (name, email) from the OAuth profile API.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{name: string|null, email: string|null}>}
 */
export async function fetchProfile(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) return { name: null, email: null };

    const data = await res.json();
    return {
      name: data.account?.full_name || data.account?.display_name || null,
      email: data.account?.email || null,
    };
  } catch {
    return { name: null, email: null };
  }
}

/**
 * Check usage for all accounts in parallel.
 *
 * @param {Array<{name: string, configDir: string, token: string}>} accounts
 * @returns {Promise<Array<{name: string, configDir: string, token: string, usage: object}>>}
 */
export async function checkAllUsage(accounts) {
  const results = await Promise.all(
    accounts.map(async (account) => {
      const usage = await checkUsage(account.token);
      return { ...account, usage };
    })
  );
  return results;
}
