/**
 * Cache management for API responses.
 *
 * Three files per account:
 * - {configDir}/auth_usage_cache.json: { raw, cachedTimestamp }
 * - {configDir}/auth_usage_call.timestamp: last API call timestamp
 * - {configDir}/setup_token_meta.json: { registeredAt, checkedAt } (setup-token Keychain date)
 */

import fs from 'fs';
import path from 'path';

const CACHE_FILENAME = 'auth_usage_cache.json';
const CALL_TIMESTAMP_FILENAME = 'auth_usage_call.timestamp';
const SETUP_TOKEN_META_FILENAME = 'setup_token_meta.json';
const SETUP_TOKEN_META_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Get cache interval from environment variable or use default.
 * CLAUDE_AUTH_USAGE_API_CACHE_TTL: seconds (default: 60)
 */
function getCacheIntervalMs() {
  const envValue = process.env.CLAUDE_AUTH_USAGE_API_CACHE_TTL;
  if (!envValue) return 60 * 1000; // 1 minute default

  const seconds = Number(envValue);
  if (isNaN(seconds) || seconds <= 0) {
    console.warn(`[cache] Invalid CLAUDE_AUTH_USAGE_API_CACHE_TTL="${envValue}", using default 60s`);
    return 60 * 1000;
  }

  return seconds * 1000;
}

const CACHE_INTERVAL_MS = getCacheIntervalMs();

/**
 * Read cached response from disk.
 *
 * @param {string} configDir - Account config directory
 * @returns {object|null} { raw, cachedTimestamp } or null if not found
 */
export function readCache(configDir) {
  const cachePath = path.join(configDir, CACHE_FILENAME);
  try {
    if (fs.existsSync(cachePath)) {
      const content = fs.readFileSync(cachePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore read/parse errors
  }
  return null;
}

/**
 * Read the last API call timestamp.
 *
 * @param {string} configDir - Account config directory
 * @returns {number|null} Timestamp in ms or null if not found
 */
export function readLastApiCallTimestamp(configDir) {
  const timestampPath = path.join(configDir, CALL_TIMESTAMP_FILENAME);
  try {
    if (fs.existsSync(timestampPath)) {
      const content = fs.readFileSync(timestampPath, 'utf-8').trim();
      const ts = Number(content);
      return isNaN(ts) ? null : ts;
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Write API call timestamp (called immediately before fetch).
 *
 * @param {string} configDir - Account config directory
 * @param {number} [now] - Timestamp to write (default: Date.now())
 */
export function updateApiCallTimestamp(configDir, now = Date.now()) {
  const timestampPath = path.join(configDir, CALL_TIMESTAMP_FILENAME);
  try {
    const dir = path.dirname(timestampPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(timestampPath, String(now), 'utf-8');
  } catch {
    // Ignore write errors
  }
}

/**
 * Write cached response (called after successful fetch).
 *
 * @param {string} configDir - Account config directory
 * @param {object} raw - Raw API response
 * @param {number} [now] - Timestamp to record (default: Date.now())
 */
export function writeCache(configDir, raw, now = Date.now()) {
  const cachePath = path.join(configDir, CACHE_FILENAME);
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const cache = { raw, cachedTimestamp: now };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Ignore write errors
  }
}

/**
 * Decide whether to make a fresh API call.
 *
 * Returns true if max(cachedTimestamp, lastApiCallTimestamp) + 1min < now.
 *
 * @param {object|null} cache - Cached data from readCache()
 * @param {number|null} lastApiCallTs - From readLastApiCallTimestamp()
 * @param {number} [now] - Current timestamp (default: Date.now())
 * @param {number} [intervalMs] - Freshness window (default: CACHE_INTERVAL_MS)
 * @returns {boolean}
 */
export function shouldRefreshCache(cache, lastApiCallTs, now = Date.now(), intervalMs = CACHE_INTERVAL_MS) {
  const cachedTs = cache?.cachedTimestamp ?? 0;
  const maxTs = Math.max(cachedTs, lastApiCallTs ?? 0);
  return maxTs + intervalMs < now;
}

/**
 * Check if cached value is stale (> 5 minutes old).
 * Used to detect API limit errors during long-running sessions.
 *
 * @param {object|null} cache - Cached data
 * @param {number} [now] - Current timestamp (default: Date.now())
 * @returns {boolean}
 */
export function isCacheStale(cache, now = Date.now()) {
  if (!cache?.cachedTimestamp) return true;
  return now - cache.cachedTimestamp > 5 * 60 * 1000; // > 5 minutes
}

/**
 * Read the cached setup-token registration time, if it was checked within the last day.
 *
 * @param {string} configDir - Account config directory
 * @param {number} [now] - Current timestamp (default: Date.now())
 * @returns {{ registeredAt: string, checkedAt: number }|null}
 */
export function readSetupTokenMeta(configDir, now = Date.now()) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(configDir, SETUP_TOKEN_META_FILENAME), 'utf-8'));
    if (typeof meta.registeredAt === 'string' && now - meta.checkedAt < SETUP_TOKEN_META_TTL_MS) return meta;
  } catch {
    // Missing or unparsable: the caller re-reads the Keychain
  }
  return null;
}

/**
 * @param {string} configDir - Account config directory
 * @param {string} registeredAt - ISO timestamp the setup-token was stored in the Keychain
 * @param {number} [now] - Timestamp to record (default: Date.now())
 */
export function writeSetupTokenMeta(configDir, registeredAt, now = Date.now()) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, SETUP_TOKEN_META_FILENAME),
      JSON.stringify({ registeredAt, checkedAt: now }, null, 2),
      'utf-8',
    );
  } catch {
    // Ignore write errors
  }
}

export function clearSetupTokenMeta(configDir) {
  try {
    fs.rmSync(path.join(configDir, SETUP_TOKEN_META_FILENAME), { force: true });
  } catch {
    // Ignore remove errors
  }
}

export { CACHE_INTERVAL_MS };
