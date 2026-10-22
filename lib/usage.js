/**
 * Query the Anthropic OAuth usage API.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Returns five_hour and seven_day utilization percentages (0-100).
 */

import fs from 'fs';
import path from 'path';
import { readCache, readLastApiCallTimestamp, updateApiCallTimestamp, writeCache, shouldRefreshCache } from './cache.js';
import { CONFIG_DIR } from './config.js';
import { silentRefresh } from './reauth.js';
import { readCredentials } from './keychain.js';
import { getSetupToken, probeUsage } from './probe.js';
import { record } from './timing.js';

const FETCH_TIMEOUT_MS = 10_000;
// Probe timeout (30s) + margin: past this the fetching call is presumed dead
const IN_FLIGHT_WAIT_MS = 35_000;
const IN_FLIGHT_POLL_MS = 500;

/**
 * Log usage API errors to {configDir}/usage-api.log
 */
function logUsageError(error, configDir) {
  try {
    const logPath = path.join(configDir, 'usage-api.log');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}]`;
    const message = `${timestamp} Usage API error: ${error}\n`;
    fs.appendFileSync(logPath, message, 'utf-8');
  } catch {
    // Silent fail on write error
  }
}

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;   // 5 hours
const WEEKLY_WINDOW_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Estimate a reset timestamp when the API does not provide one.
 * Uses the current hour (minutes/seconds truncated) as the anchor, then adds windowMs.
 *
 * @param {number} windowMs - Total window duration in milliseconds
 * @param {number} [now] - Current timestamp (injectable for testing)
 * @returns {string} ISO timestamp
 */
export function estimateResetsAt(windowMs, now = Date.now()) {
  const hourTruncated = Math.floor(now / 3_600_000) * 3_600_000;
  return new Date(hourTruncated + windowMs).toISOString();
}

/**
 * Compute how much of the window's time is remaining, as a 0-100 percentage.
 * When resets_at is unavailable, estimates based on current hour + windowMs.
 *
 * @param {string|null} resetsAt - ISO timestamp of the next window reset
 * @param {number} windowMs - Total window duration in milliseconds
 * @param {number} [now] - Current timestamp (injectable for testing)
 * @returns {number}
 */
export function computeRemainingTimePercent(resetsAt, windowMs, now = Date.now()) {
  const effectiveResetsAt = resetsAt ?? estimateResetsAt(windowMs, now);
  const remaining = Math.max(0, new Date(effectiveResetsAt).getTime() - now);
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
 * Process raw API response data into normalized usage object.
 *
 * @param {object} data - Raw API response
 * @returns {object} Normalized usage data with percentages and remaining time
 */
function processRawUsageData(data) {
  // New nested format: { five_hour: { utilization: N, resets_at: "..." }, seven_day: { ... } }
  if (data.five_hour !== undefined || data.seven_day !== undefined) {
    const sessionResetsAt = data.five_hour?.resets_at ?? null;
    const weeklyResetsAt  = data.seven_day?.resets_at ?? null;
    // A probe result leaves a window null when the event did not report it → unknown, not 0%
    const sessionKnown = data.source !== 'probe' || data.five_hour != null;
    const weeklyKnown  = data.source !== 'probe' || data.seven_day != null;
    return {
      sessionPercent: sessionKnown ? normalizePercentInt(data.five_hour?.utilization ?? 0) : null,
      weeklyPercent: weeklyKnown ? normalizePercentInt(data.seven_day?.utilization ?? 0) : null,
      sessionResetsAt,
      weeklyResetsAt,
      sessionRemainingTimePercent: sessionKnown ? computeRemainingTimePercent(sessionResetsAt, SESSION_WINDOW_MS) : null,
      weeklyRemainingTimePercent:  weeklyKnown ? computeRemainingTimePercent(weeklyResetsAt, WEEKLY_WINDOW_MS) : null,
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
}

/**
 * Fetch usage from API (no caching).
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{sessionPercent: number, weeklyPercent: number, sessionResetsAt: string|null, weeklyResetsAt: string|null, sessionRemainingTimePercent: number|null, weeklyRemainingTimePercent: number|null, raw: object|null, error: string|null}>}
 */
async function fetchUsageFromAPI(token) {
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
        raw: null,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();
    return processRawUsageData(data);
  } catch (error) {
    return {
      sessionPercent: 0,
      weeklyPercent: 0,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      raw: null,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

/**
 * Fetch fresh usage (no caching): by probe when the account has a setup-token,
 * otherwise from the usage API with its /login token.
 *
 * @param {string} token - OAuth access token (/login)
 * @param {string} [configDir]
 */
async function fetchFreshUsage(token, configDir) {
  const setupToken = configDir ? getSetupToken(configDir) : null;
  if (!setupToken) return fetchUsageFromAPI(token);

  const probe = await probeUsage(setupToken, configDir);
  if (probe.detail) logUsageError(probe.detail, configDir);
  if (probe.error) {
    return {
      sessionPercent: 0,
      weeklyPercent: 0,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      raw: null,
      error: probe.error,
    };
  }
  return processRawUsageData(probe.raw);
}

async function timedFetchFresh(token, configDir, attempt) {
  const start = Date.now();
  const result = await fetchFreshUsage(token, configDir);
  record(`usage-fetch#${attempt}(${path.basename(configDir)})`, Date.now() - start, result.error ? `err=${result.error}` : '');
  return result;
}

/**
 * Wait for another call's in-flight fetch to land in the cache.
 *
 * @param {string} configDir - Account config directory
 * @param {number} startedAt - Timestamp the in-flight fetch recorded before starting
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Give up this long after startedAt
 * @param {number} [opts.pollMs]
 * @returns {Promise<{raw: object, cachedTimestamp: number}|null>} null on timeout
 */
export async function waitForInflightFetch(configDir, startedAt, { timeoutMs = IN_FLIGHT_WAIT_MS, pollMs = IN_FLIGHT_POLL_MS } = {}) {
  const waitStart = Date.now();
  while (Date.now() < startedAt + timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const cache = readCache(configDir);
    if (cache?.raw && (cache.cachedTimestamp ?? 0) >= startedAt) {
      record(`usage-wait(${path.basename(configDir)})`, Date.now() - waitStart, 'ok');
      return cache;
    }
  }
  record(`usage-wait(${path.basename(configDir)})`, Date.now() - waitStart, 'timeout');
  return null;
}

/**
 * Check usage for a single account token, with caching support.
 *
 * If configDir is provided, uses cache strategy:
 * - Returns cached data if max(cachedTimestamp, lastApiCallTimestamp) + 1min >= now
 * - Otherwise, fetches fresh data and updates cache
 *
 * On HTTP 401 (expired token), attempts silent refresh and retries once.
 *
 * @param {string} token - OAuth access token
 * @param {string} [configDir] - Account config directory (enables caching if provided)
 * @param {object} [options] - Options object
 * @param {boolean} [options.forceRefresh] - Bypass cache and fetch fresh data
 * @param {number} [options.maxAgeMs] - Cache freshness window (default: cache interval, 60s)
 * @returns {Promise<{sessionPercent: number, weeklyPercent: number, sessionResetsAt: string|null, weeklyResetsAt: string|null, sessionRemainingTimePercent: number|null, weeklyRemainingTimePercent: number|null, raw: object|null, error: string|null}>}
 */
export async function checkUsage(token, configDir, options = {}) {
  const now = Date.now();
  const { forceRefresh = false, maxAgeMs } = options;

  // If no configDir, skip cache entirely
  if (!configDir) {
    return fetchUsageFromAPI(token);
  }

  // Why the cache didn't serve this call (logged with the fetch that follows)
  let missReason = 'forced';

  // If forceRefresh is set, skip cache check
  if (!forceRefresh) {
    // Try to use cached data
    const cache = readCache(configDir);
    const lastApiCallTs = readLastApiCallTimestamp(configDir);

    if (!shouldRefreshCache(cache, lastApiCallTs, now, maxAgeMs)) {
      // The call timestamp is written before the fetch, so a cache older than maxAge
      // here is stale data from before an in-flight fetch: wait for its result.
      const inFlight = shouldRefreshCache(cache, null, now, maxAgeMs);
      const served = inFlight ? await waitForInflightFetch(configDir, lastApiCallTs) : cache;
      if (served?.raw) {
        record(`usage-cache(${path.basename(configDir)})`, 0, inFlight ? 'hit-after-wait' : 'hit');
        return processRawUsageData(served.raw);
      }
      // A recent call failed (or the in-flight one timed out), so there is nothing to serve
      missReason = inFlight ? 'inflight-timeout' : 'no-raw';
    } else {
      missReason = cache ? `expired(age=${Math.round((now - (cache.cachedTimestamp ?? 0)) / 1000)}s)` : 'no-cache';
    }
  }
  record(`usage-cache(${path.basename(configDir)})`, 0, `miss=${missReason}`);

  // Need to fetch fresh data
  updateApiCallTimestamp(configDir, now);
  let result = await timedFetchFresh(token, configDir, 1);

  // On 401, attempt silent refresh and retry once
  if (result.error === 'HTTP 401') {
    const accountName = path.basename(configDir);
    const account = { name: accountName, configDir };

    const refreshStart = Date.now();
    const refreshed = await silentRefresh(account);
    record(`silent-refresh(${accountName})`, Date.now() - refreshStart, `ok=${refreshed}`);
    if (refreshed) {
      // Token refreshed, read the new token and retry
      const creds = readCredentials(configDir);
      if (creds.token) {
        result = await fetchUsageFromAPI(creds.token);
      }
    }
  } else if (result.error && result.error !== 'HTTP 403') {
    // Transient error (timeout, network, 5xx) — retry once immediately
    // so a single blip doesn't drop the account from selection candidates.
    result = await timedFetchFresh(token, configDir, 2);
  }

  // Cache successful responses
  if (!result.error && result.raw) {
    writeCache(configDir, result.raw, now);
  } else if (result.error) {
    logUsageError(result.error, configDir);
  }

  return result;
}

/**
 * Read the account profile (name, email) Claude Code saved at login.
 *
 * Local read instead of /api/oauth/profile: setup-tokens lack the scope for it.
 *
 * @param {string} configDir - Account config directory
 * @returns {{name: string|null, email: string|null}}
 */
export function readProfile(configDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf-8'));
    const account = data.oauthAccount;
    return {
      name: account?.fullName || account?.displayName || null,
      email: account?.emailAddress || null,
    };
  } catch {
    return { name: null, email: null };
  }
}

/**
 * Check usage for all accounts in parallel, with per-account caching.
 *
 * @param {Array<{name: string, configDir: string, token: string}>} accounts
 * @param {object} [options] - Options object
 * @param {boolean} [options.forceRefresh] - Bypass cache and fetch fresh data for all accounts
 * @returns {Promise<Array<{name: string, configDir: string, token: string, usage: object}>>}
 */
export async function checkAllUsage(accounts, options = {}) {
  const results = await Promise.all(
    accounts.map(async (account) => {
      const usage = await checkUsage(account.token, account.configDir, options);
      return { ...account, usage };
    })
  );
  return results;
}
