/**
 * Token-based usage probe.
 *
 * `claude setup-token` tokens lack the scopes for /api/oauth/usage and
 * /api/oauth/profile, so usage is read from a one-turn Claude Code run instead:
 * its stream-json output carries a `rate_limit_event` with both windows.
 *
 * Tokens live in the macOS Keychain as `cc-token-<account name>`. Accounts
 * without one keep using the /login credentials and the usage API.
 */

import { spawn, execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join, basename } from 'path';
import { isMacOS } from './platform.js';
import { getAccounts } from './config.js';
import { record, redactSecrets } from './timing.js';

const TOKEN_SERVICE_PREFIX = 'cc-token-';
const PROBE_TIMEOUT_MS = 30_000;

// The prompt and flags are fixed on purpose: the prompt cache keys on the whole
// request, so any change turns the ~560 cached tokens back into cache writes.
const PROBE_PROMPT = 'no-op';
const PROBE_ARGS = [
  '--safe-mode', '--tools', '', '--disable-slash-commands', '--system-prompt', '',
  '--no-session-persistence', '--model', 'haiku',
  '-p', PROBE_PROMPT, '--output-format', 'stream-json', '--verbose',
];

/**
 * Read the setup-token for the account that owns configDir.
 *
 * @param {string} configDir
 * @returns {string|null} null when the account has no token (or not on macOS)
 */
export function getSetupToken(configDir) {
  if (!isMacOS()) return null;
  const account = getAccounts().find(a => a.configDir === configDir);
  if (!account) return null;
  const start = Date.now();
  try {
    const token = execFileSync(
      'security',
      ['find-generic-password', '-s', `${TOKEN_SERVICE_PREFIX}${account.name}`, '-w'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return token || null;
  } catch {
    return null;
  } finally {
    record(`setup-token(${account.name})`, Date.now() - start);
  }
}

/**
 * Store (or replace) the setup-token for an account in the Keychain.
 *
 * The token goes to `security -i` via stdin, not argv, so it never shows up in `ps`.
 *
 * @param {string} accountName
 * @param {string} token
 * @throws {Error} on a malformed token or a failed Keychain write
 */
export function setSetupToken(accountName, token) {
  // Also guarantees the token is safe to put in the security command line below
  if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Not a valid setup-token (expected "sk-ant-..." from `claude setup-token`).');
  }
  const service = `${TOKEN_SERVICE_PREFIX}${accountName}`;
  try {
    execFileSync('security', ['-i'], {
      input: `add-generic-password -a ${userInfo().username} -s ${service} -U -w ${token}\n`,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (err) {
    throw new Error(`Keychain write failed: ${String(err.stderr || err.message).trim()}`);
  }
}

/**
 * Run the one-turn probe and capture its output.
 *
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number|null, timedOut: boolean }>}
 */
export function runProbe(token, configDir, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const cwd = join(tmpdir(), 'claude-nonstop-probe');
    mkdirSync(cwd, { recursive: true });

    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_OAUTH_TOKEN: token,
      MAX_THINKING_TOKENS: '0',
      ENABLE_PROMPT_CACHING_1H: '1',
    };
    delete env.CLAUDECODE;
    delete env.FORCE_PROMPT_CACHING_5M;
    delete env.CLAUDE_CODE_EFFORT_LEVEL;

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('claude', PROBE_ARGS, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: null, timedOut });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

/**
 * Pick the last rate_limit_event's info out of stream-json output.
 * The exit code is ignored: an exhausted account may exit non-zero and still emit it.
 *
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseRateLimitEvent(stdout) {
  let info = null;
  for (const line of stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'rate_limit_event' && event.rate_limit_info) info = event.rate_limit_info;
    } catch {
      // Not a JSON line
    }
  }
  return info;
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Not a JSON line
    }
  }
  return events;
}

/**
 * Event types in arrival order, e.g. "system:init,assistant,result:success".
 * A probe that stalled after init shows up as just "system:init".
 */
export function listEventTypes(stdout) {
  return parseEvents(stdout).map(e => (e.subtype ? `${e.type}:${e.subtype}` : e.type)).join(',');
}

/** The final `result` event (tokens, model, error status), or null. */
export function parseResultEvent(stdout) {
  return parseEvents(stdout).findLast(e => e.type === 'result') ?? null;
}

/**
 * Model and token breakdown of the probe's own request.
 * Cache writes are split by TTL (1h / 5m).
 */
export function formatProbeUsage(result) {
  const u = result?.usage;
  if (!u) return '';
  const model = Object.keys(result.modelUsage ?? {}).join(',') || '?';
  const ttl = u.cache_creation ?? {};
  return `model=${model} in=${u.input_tokens ?? 0} ` +
    `write=${u.cache_creation_input_tokens ?? 0}(1h:${ttl.ephemeral_1h_input_tokens ?? 0},5m:${ttl.ephemeral_5m_input_tokens ?? 0}) ` +
    `read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? 0}`;
}

function formatResultError(result) {
  const { subtype, is_error, api_error_status, terminal_reason, stop_reason, result: text } = result;
  return JSON.stringify({ subtype, is_error, api_error_status, terminal_reason, stop_reason, text });
}

function toIso(epochSeconds) {
  return typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : null;
}

function toWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  // Event utilization is a 0-1 fraction (0.45 = 45%), unlike the usage API's 0-100.
  return { utilization: Math.round(w.utilization * 100), resets_at: toIso(w.resetsAt) };
}

/**
 * Convert a rate_limit_event into the usage API's nested shape so the cache,
 * scorer and status display work unchanged. A window the event did not report
 * stays null (unknown), never 0.
 *
 * Blocked state (verified on a real five_hour limit hit): status "rejected", the
 * blocked window at utilization 1.0, the other window still reported. The probe
 * exits 1 with a 429 result but the event still arrives, so the exit code is ignored.
 * Not yet seen: a seven_day block.
 *
 * @param {object} info - rate_limit_info
 * @returns {object}
 */
export function eventToRaw(info) {
  const windows = info.unifiedWindows ?? {};
  let fiveHour = toWindow(windows.five_hour);
  let sevenDay = toWindow(windows.seven_day);

  if (isBlocked(info)) {
    const blocked = { utilization: 100, resets_at: toIso(info.resetsAt) };
    if (String(info.rateLimitType).startsWith('seven_day')) sevenDay = blocked;
    else fiveHour = blocked;
  }

  return {
    source: 'probe',
    five_hour: fiveHour,
    seven_day: sevenDay,
    // TODO: extra-usage amounts (used_credits, monthly_limit) are only in the
    // usage API; the event carries just the state below.
    overage: {
      status: info.overageStatus ?? null,
      disabled_reason: info.overageDisabledReason ?? null,
      is_using_overage: !!info.isUsingOverage,
    },
  };
}

function isBlocked(info) {
  return typeof info.status === 'string' && !info.status.startsWith('allowed');
}

/**
 * Probe an account's usage with its setup-token.
 *
 * @returns {Promise<{ raw: object|null, error: string|null, detail: string|null }>}
 *   detail is a log line for the blocked / no-event cases
 */
export async function probeUsage(token, configDir) {
  const start = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await runProbe(token, configDir);
  const info = parseRateLimitEvent(stdout);
  const result = parseResultEvent(stdout);

  // exit null = spawn error or killed by the probe timeout (timeout=true tells which)
  const parts = [`exit=${exitCode}`, `timeout=${timedOut}`, `events=${listEventTypes(stdout)}`];
  const usageText = formatProbeUsage(result);
  if (usageText) parts.push(usageText);
  // Full text on purpose: finding why a probe failed matters more than log size
  if (!info || result?.is_error) {
    if (stderr.trim()) parts.push(`stderr=${JSON.stringify(stderr.trim())}`);
    if (result) parts.push(`result=${formatResultError(result)}`);
  }
  const summary = redactSecrets(parts.join(' '));
  record(`probe(${basename(configDir)})`, Date.now() - start, summary);

  if (!info) {
    return {
      raw: null,
      error: `probe: no rate_limit_event (exit ${exitCode})`,
      detail: `probe: no rate_limit_event ${summary}`,
    };
  }

  return {
    raw: eventToRaw(info),
    error: null,
    detail: isBlocked(info) ? `probe: blocked ${JSON.stringify(info)}` : null,
  };
}
