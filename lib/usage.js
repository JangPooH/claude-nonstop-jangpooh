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

const FETCH_TIMEOUT_MS = 10_000;

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
 * Check usage for a single account token, with caching support.
 *
 * If configDir is provided, uses cache strategy:
 * - Returns cached data if max(cachedTimestamp, lastApiCallTimestamp) + 1min >= now
 * - Otherwise, fetches fresh data and updates cache
 *
 * @param {string} token - OAuth access token
 * @param {string} [configDir] - Account config directory (enables caching if provided)
 * @param {object} [options] - Options object
 * @param {boolean} [options.forceRefresh] - Bypass cache and fetch fresh data
 * @returns {Promise<{sessionPercent: number, weeklyPercent: number, sessionResetsAt: string|null, weeklyResetsAt: string|null, sessionRemainingTimePercent: number|null, weeklyRemainingTimePercent: number|null, raw: object|null, error: string|null}>}
 */
export async function checkUsage(token, configDir, options = {}) {
  const now = Date.now();
  const { forceRefresh = false } = options;

  // If no configDir, skip cache entirely
  if (!configDir) {
    return fetchUsageFromAPI(token);
  }

  // If forceRefresh is set, skip cache check
  if (!forceRefresh) {
    // Try to use cached data
    const cache = readCache(configDir);
    const lastApiCallTs = readLastApiCallTimestamp(configDir);

    if (!shouldRefreshCache(cache, lastApiCallTs, now)) {
      // Cache is fresh enough
      if (cache?.raw) {
        return processRawUsageData(cache.raw);
      }
    }
  }

  // Need to fetch fresh data
  updateApiCallTimestamp(configDir, now);
  const result = await fetchUsageFromAPI(token);

  // Cache successful responses
  if (!result.error && result.raw) {
    writeCache(configDir, result.raw, now);
  } else if (result.error) {
    logUsageError(result.error, configDir);
  }

  return result;
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
