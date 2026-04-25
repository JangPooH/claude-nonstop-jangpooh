/**
 * Process runner — spawns Claude Code, monitors output for rate limits,
 * and automatically switches accounts with session migration.
 *
 * Flow:
 * 1. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to selected account
 * 2. Pipe stdout/stderr through to the user's terminal (real-time pass-through)
 * 3. Simultaneously scan output for rate limit patterns
 * 4. On rate limit detection:
 *    a. Kill the paused Claude process
 *    b. Find the active session file
 *    c. Migrate session to the next best account's config dir
 *    d. Resume with `claude --resume <sessionId>` using the new account
 */

import * as pty from 'node-pty';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readCredentials } from './keychain.js';
import { checkAllUsage, fetchProfile } from './usage.js';
import { pickBestAccount, effectiveUtilization } from './scorer.js';
import { makeBar, formatResetTime, formatUserInfo } from './format.js';
import { findLatestSession, migrateSession } from './session.js';
import { reauthExpiredAccounts } from './reauth.js';
import { CONFIG_DIR } from './config.js';
import { getCurrentTmuxSession } from './tmux.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_NOTIFY_PATH = path.resolve(__dirname, '..', 'remote', 'hook-notify.cjs');

process.on('SIGTSTP', () => {
  process.kill(process.pid, 'SIGSTOP');
});

// Prefer claude-patched (cc-cache-fix) if available in PATH, fall back to claude
function resolveClaudioBin() {
  try {
    execFileSync('which', ['claude-patched'], { stdio: 'ignore' });
    return 'claude-patched';
  } catch {
    return 'claude';
  }
}
const CLAUDE_BIN = resolveClaudioBin();

/**
 * Rate limit detection pattern.
 * Claude Code outputs either:
 *   "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 *   "You've hit your limit · resets 8am (America/Los_Angeles)"
 */
const RATE_LIMIT_PATTERN = /(?:Limit reached|You've hit your limit)\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/** Maximum output buffer size before trimming (bytes). */
const OUTPUT_BUFFER_MAX = 8000;
/** Buffer trim target (bytes). */
const OUTPUT_BUFFER_TRIM = 4000;
/** Pattern to filter out user input lines (background color 55,55,55). */
const INPUT_LINE_PATTERN = /\x1b\[48;2;55;55;55m.*?\x1b\[(?:39|49)m/g;
/** Maximum number of account swaps before giving up. */
const MAX_SWAPS_DEFAULT = 5;
/** Message sent to auto-continue after rate-limit account switch. */
const RATE_LIMIT_CONTINUE_MSG = 'Continue.';
/** Time to wait before SIGKILL after SIGTERM (ms). */
const KILL_ESCALATION_DELAY = 3000;
/** Utilization threshold (%) at which all accounts are considered near-exhausted. */
const EXHAUSTION_THRESHOLD = 99;
/** Maximum sleep duration when waiting for a rate limit reset (6 hours). */
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;

// ─── ANSI Stripping ────────────────────────────────────────────────────────

/** Strip ANSI escape codes (colors, cursor, etc.) from PTY output. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Spawn hook-notify.cjs fire-and-forget with data on stdin.
 */
function spawnHookNotify(type, data) {
  const child = execFile('node', [HOOK_NOTIFY_PATH, type], {
    timeout: 15_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  }, () => {});
  child.stdin.write(JSON.stringify(data));
  child.stdin.end();
  child.unref();
}

/**
 * Find the earliest reset time across all non-excluded accounts.
 *
 * @param {Array<{name: string, usage: object}>} accounts
 * @param {string} [excludeName] - Account name to skip
 * @returns {number} Milliseconds until earliest reset (0 if no reset info available)
 */
function findEarliestReset(accounts, excludeName) {
  const now = Date.now();
  let earliest = Infinity;

  for (const a of accounts) {
    if (a.name === excludeName) continue;
    if (!a.usage) continue;

    for (const ts of [a.usage.sessionResetsAt, a.usage.weeklyResetsAt]) {
      if (!ts) continue;
      const resetMs = new Date(ts).getTime();
      if (isNaN(resetMs)) continue;
      if (resetMs > now && resetMs < earliest) {
        earliest = resetMs;
      }
    }
  }

  if (earliest === Infinity) return 0;
  return earliest - now;
}

/**
 * Format a duration in ms to a human-readable string like "2h 15m".
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Sleep for the given number of milliseconds.
 * Interruptible: SIGINT or SIGTERM will resolve the sleep early.
 *
 * @param {number} ms
 * @returns {Promise<{ interrupted: boolean }>}
 */
function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ interrupted: false });
    }, ms);

    function onSignal() {
      cleanup();
      resolve({ interrupted: true });
    }

    function cleanup() {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/**
 * Deactivate stale channel-map entries for a tmux session.
 * Called at startup so that reuseChannelForTmuxSession only matches
 * entries created during the current invocation (e.g., /clear or rate-limit restart),
 * not leftover entries from a previous run.
 *
 * @param {string} tmuxSessionName - The tmux session name to match
 * @param {string} [channelMapPath] - Path to channel-map.json (default: CONFIG_DIR/data/channel-map.json)
 */
function deactivateStaleChannels(tmuxSessionName, channelMapPath) {
  if (!channelMapPath) {
    channelMapPath = path.join(CONFIG_DIR, 'data', 'channel-map.json');
  }
  try {
    if (!fs.existsSync(channelMapPath)) return;
    const raw = fs.readFileSync(channelMapPath, 'utf8');
    if (!raw.trim()) return;
    const map = JSON.parse(raw);

    let changed = false;
    for (const entry of Object.values(map)) {
      if (entry.tmuxSession === tmuxSessionName && entry.active) {
        entry.active = false;
        changed = true;
      }
    }

    if (changed) {
      const dir = path.dirname(channelMapPath);
      const tmpFile = path.join(dir, `.channel-map.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmpFile, JSON.stringify(map, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, channelMapPath);
    }
  } catch {
    // Non-fatal — channel reuse is a convenience, not critical
  }
}

/**
 * Render a single account's usage status block to stderr with [claude-nonstop] prefix.
 *
 * @param {{ name: string, usage: object }} accountEntry
 * @param {{ name: string|null, email: string|null }} profile
 * @param {string} tag - label shown after the account name (e.g. '<- HIT RATE LIMIT')
 */
function printAccountStatus(accountEntry, profile, tag, labelCol = 0) {
  const userInfo = formatUserInfo(profile || {});
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  const visibleLen = accountEntry.name.length + userInfo.length;
  const padding = ' '.repeat(Math.max(2, labelCol - visibleLen + 2));
  process.stderr.write(`[claude-nonstop] ${BOLD}${accountEntry.name}${RESET}${userInfo}${padding}${tag}\n`);

  const usage = accountEntry.usage;
  if (!usage || usage.error) {
    process.stderr.write(`[claude-nonstop]     Usage: error (${usage?.error ?? 'unknown'})\n`);
    return;
  }

  const sessionBar = makeBar(usage.sessionPercent, usage.sessionRemainingTimePercent);
  const weeklyBar = makeBar(usage.weeklyPercent, usage.weeklyRemainingTimePercent);
  const sessionReset = usage.sessionResetsAt ? formatResetTime(usage.sessionResetsAt) : 'unknown';
  const weeklyReset = usage.weeklyResetsAt ? formatResetTime(usage.weeklyResetsAt) : 'unknown';

  process.stderr.write(
    `[claude-nonstop]     5-hour:  ${sessionBar} ${String(usage.sessionPercent).padStart(3)}% / resets: ${sessionReset}\n` +
    `[claude-nonstop]     7-day :  ${weeklyBar} ${String(usage.weeklyPercent).padStart(3)}% / resets: ${weeklyReset}\n`
  );
}

/**
 * Show a rich rate-limit prompt and wait for explicit user input.
 *
 * Displays the current (rate-limited) account and the candidate next account
 * with full usage bars, then waits for the user to press [s] or [w].
 * No timeout — explicit input is required.
 *
 * @param {{ name: string, usage: object }} currentEntry
 * @param {{ name: string|null, email: string|null }} currentProfile
 * @param {{ name: string, usage: object }|null} nextEntry
 * @param {{ name: string|null, email: string|null }|null} nextProfile
 * @returns {Promise<'switch'|'wait'>}
 */
async function promptRateLimitAction(currentEntry, currentProfile, nextEntry, nextProfile) {
  // Determine which limit was hit
  const usage = currentEntry.usage;
  let limitLabel = '5-hour';
  if (usage && !usage.error) {
    if (usage.weeklyPercent >= 98 && usage.sessionPercent < 98) limitLabel = '7-day';
    else if (usage.weeklyPercent >= 98 && usage.sessionPercent >= 98) limitLabel = '5-hour and 7-day';
  }

  // Move cursor below the statusline area Claude Code left on screen.
  // Claude Code renders a multi-line statusline at the bottom of the terminal;
  // writing directly would overwrite it. Instead, jump to the last terminal row
  // and emit newlines so the statusline scrolls up and our output appears below.
  const termRows = process.stderr.rows || 24;
  process.stderr.write(`\x1b[${termRows};0H\n\n`);

  process.stderr.write(`[claude-nonstop] "${currentEntry.name}" hit ${limitLabel} rate limit\n`);

  // Calculate label column so the '<-' arrows align vertically
  const currentUserInfo = formatUserInfo(currentProfile || {});
  const nextUserInfo = nextEntry ? formatUserInfo(nextProfile || {}) : '';
  const labelCol = Math.max(
    currentEntry.name.length + currentUserInfo.length,
    nextEntry ? nextEntry.name.length + nextUserInfo.length : 0
  );

  printAccountStatus(currentEntry, currentProfile, '<- HIT RATE LIMIT', labelCol);

  if (nextEntry) {
    printAccountStatus(nextEntry, nextProfile, '<- SWITCH TARGET', labelCol);
  } else {
    process.stderr.write('[claude-nonstop] (no alternative account available)\n');
  }

  const prompt = nextEntry
    ? '[claude-nonstop] [s] Switch account  [w] Wait for reset  [q] Quit : '
    : '[claude-nonstop] [w] Wait for reset  [q] Quit : ';

  process.stderr.write('[claude-nonstop]\n');
  process.stderr.write(prompt);

  return new Promise(resolve => {
    let resolved = false;

    function done(action) {
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener('data', onData);
      try { process.stdin.pause(); } catch {}
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stderr.write('\n');
      resolve(action);
    }

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function onData(chunk) {
      const key = chunk.toString().toLowerCase();
      if (key === '\x03' || key === 'q') {
        done('quit');
      } else if (key === 'w') {
        done('wait');
      } else if (key === 's' && nextEntry) {
        done('switch');
      } else {
        const valid = nextEntry ? 's / w / q' : 'w / q';
        process.stderr.write(`\n[claude-nonstop] Invalid input. Use ${valid}.\n${prompt}`);
      }
    }

    process.stdin.on('data', onData);
  });
}

/**
 * Run Claude Code with automatic account switching.
 *
 * @param {string[]} claudeArgs - Arguments to pass to `claude`
 * @param {{ name: string, configDir: string }} selectedAccount - Account to use
 * @param {Array<{ name: string, configDir: string }>} allAccounts - All registered accounts
 * @param {{ maxSwaps?: number, remoteAccess?: boolean }} options - Runner options
 */
export async function run(claudeArgs, selectedAccount, allAccounts, options = {}) {
  // Scale swap budget with account count — with N accounts, you may need
  // N-1 swaps to try them all before exhaustion triggers the sleep mechanism.
  // The * 2 multiplier allows for accounts recovering mid-session (5-hour resets).
  const maxSwaps = options.maxSwaps ?? Math.max(MAX_SWAPS_DEFAULT, allAccounts.length * 2);
  const remoteAccess = options.remoteAccess ?? false;
  let currentAccount = selectedAccount;
  let swapCount = 0;
  let sessionId = extractResumeSessionId(claudeArgs);

  // Deactivate stale channel entries from previous invocations so that
  // reuseChannelForTmuxSession only matches entries from this run
  // (i.e., /clear or rate-limit restarts within the same tmux session).
  if (remoteAccess) {
    deactivateStaleChannels(getCurrentTmuxSession());
  }

  while (swapCount <= maxSwaps) {
    const result = await runOnce(claudeArgs, currentAccount, sessionId, { remoteAccess });

    if (result.exitCode !== null && !result.rateLimitDetected) {
      // Normal exit — propagate the exit code
      process.exitCode = result.exitCode;
      return;
    }

    if (!result.rateLimitDetected) {
      // Process ended without rate limit (e.g., signal)
      process.exitCode = result.exitCode ?? 1;
      return;
    }

    // Rate limit detected — fetch usage for all accounts and prompt user
    swapCount++;

    if (swapCount > maxSwaps) {
      console.error('\n[claude-nonstop] Maximum swap attempts reached. All accounts may be rate-limited.');
      process.exitCode = 1;
      return;
    }

    // Find the session to migrate/resume
    const cwd = process.cwd();
    const session = result.sessionId
      ? { sessionId: result.sessionId }
      : findLatestSession(currentAccount.configDir, cwd);

    if (!session) {
      console.error('[claude-nonstop] Could not find session to migrate. Starting fresh on new account.');
    }

    // Fetch usage for all accounts (needed for prompt display and account selection)
    const accountsWithTokens = allAccounts.map(a => ({
      ...a,
      token: readCredentials(a.configDir).token,
    })).filter(a => a.token);

    let accountsWithUsage = await checkAllUsage(accountsWithTokens, { forceRefresh: true });
    const hasPriorities = accountsWithUsage.some(a => a.priority != null);
    let best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });

    // Interactive prompt (TTY only, not remote-access mode)
    if (!remoteAccess && process.stdin.isTTY) {
      const currentEntry = accountsWithUsage.find(a => a.name === currentAccount.name)
        ?? { name: currentAccount.name, usage: null };
      const nextEntry = best ? best.account : null;

      // Fetch profiles for display (fire in parallel)
      const [currentProfile, nextProfile] = await Promise.all([
        fetchProfile(readCredentials(currentAccount.configDir).token || ''),
        nextEntry ? fetchProfile(readCredentials(nextEntry.configDir).token || '') : Promise.resolve(null),
      ]);

      const action = await promptRateLimitAction(currentEntry, currentProfile, nextEntry, nextProfile);

      if (action === 'quit') {
        console.error('[claude-nonstop] Exiting.');
        process.exitCode = 130;
        return;
      }

      if (action === 'wait') {
        // Find earliest reset time for current account
        const usage = currentEntry.usage;
        let sleepMs = 0;
        if (usage && !usage.error) {
          for (const ts of [usage.sessionResetsAt, usage.weeklyResetsAt]) {
            if (!ts) continue;
            const ms = new Date(ts).getTime() - Date.now();
            if (ms > 0 && (sleepMs === 0 || ms < sleepMs)) sleepMs = ms;
          }
        }

        if (sleepMs > 0) {
          const clampedMs = Math.min(sleepMs, MAX_SLEEP_MS);
          const resetDate = new Date(Date.now() + clampedMs);
          console.error(`[claude-nonstop] Waiting until ${resetDate.toLocaleTimeString()} (${formatDuration(clampedMs)})...`);
          const { interrupted } = await sleep(clampedMs);
          if (interrupted) {
            console.error('\n[claude-nonstop] Wait interrupted by signal. Exiting.');
            process.exitCode = 130;
            return;
          }
          console.error('[claude-nonstop] Reset complete. Resuming on same account...');
          // After waiting, re-find the session (it may have moved or the initial search may have failed)
          const freshedSession = findLatestSession(currentAccount.configDir, cwd);
          if (freshedSession) {
            sessionId = freshedSession.sessionId;
            claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
          }
          swapCount--; // Waiting doesn't count against swap budget
          continue;
        } else {
          console.error('[claude-nonstop] Could not determine reset time. Switching account instead...');
        }
      }
      // action === 'switch' falls through to the switch logic below
    }

    // If best candidate is near-exhausted, sleep until earliest reset instead of thrashing.
    // Include all accounts (even current) when finding reset times — after sleeping,
    // any account may have recovered, including the one that just hit the limit.
    //
    // TODO: For remote mode, consider an event-driven approach instead of blocking sleep:
    //   1. Notify Slack and save session state to disk
    //   2. Exit the runner cleanly
    //   3. Slack bot schedules a re-launch at the reset time (or user sends !resume)
    // This would free the tmux pane instead of holding it for hours.
    if (best && effectiveUtilization(best.account.usage) >= EXHAUSTION_THRESHOLD) {
      const sleepMs = findEarliestReset(accountsWithUsage);
      if (sleepMs > 0) {
        const clampedMs = Math.min(sleepMs, MAX_SLEEP_MS);
        const resetDate = new Date(Date.now() + clampedMs);
        console.error(`[claude-nonstop] All accounts near limit. Sleeping until ${resetDate.toLocaleTimeString()} (${formatDuration(clampedMs)})...`);

        if (remoteAccess) {
          spawnHookNotify('sleep-until-reset', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            sleep_ms: clampedMs,
            reset_at: resetDate.toISOString(),
          });
        }

        const { interrupted } = await sleep(clampedMs);
        if (interrupted) {
          console.error('\n[claude-nonstop] Sleep interrupted by signal. Exiting.');
          process.exitCode = 130;
          return;
        }

        console.error('[claude-nonstop] Sleep complete. Re-checking account usage...');

        // Re-fetch usage after sleeping — any account may have recovered,
        // including the current one, so don't exclude it from the pick.
        const refreshedTokens = allAccounts.map(a => ({
          ...a,
          token: readCredentials(a.configDir).token,
        })).filter(a => a.token);
        accountsWithUsage = await checkAllUsage(refreshedTokens);
        best = pickBestAccount(accountsWithUsage, undefined, { usePriority: hasPriorities });

        if (remoteAccess) {
          spawnHookNotify('sleep-wake', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            best_account: best?.account?.name || null,
          });
        }

        // Sleep-then-swap doesn't count against the swap budget — the sleep
        // itself is the mechanism to avoid thrashing, so this is a "free" swap.
        swapCount--;
      }
    }

    // If no accounts available, check if auth errors are the cause and attempt re-auth
    if (!best && !remoteAccess) {
      const authErrors = accountsWithUsage.filter(a =>
        a.name !== currentAccount.name && a.usage?.error === 'HTTP 401'
      );
      if (authErrors.length > 0) {
        console.error('[claude-nonstop] Some accounts have expired tokens. Attempting re-auth...');
        const refreshed = await reauthExpiredAccounts(authErrors);
        if (refreshed.length > 0) {
          // Re-read credentials and re-check usage
          const updatedAccounts = allAccounts.map(a => ({
            ...a,
            token: readCredentials(a.configDir).token,
          })).filter(a => a.token);
          accountsWithUsage = await checkAllUsage(updatedAccounts);
          best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });
        }
      }
    }

    if (!best) {
      console.error('[claude-nonstop] No alternative accounts available.');
      process.exitCode = 1;
      return;
    }

    const nextAccount = best.account;
    console.error(`[claude-nonstop] Switching to "${nextAccount.name}" (${best.reason})`);

    // Notify Slack about account switch (fire-and-forget)
    if (remoteAccess) {
      spawnHookNotify('account-switch', {
        session_id: sessionId || null,
        cwd: process.cwd(),
        from_account: currentAccount.name,
        to_account: nextAccount.name,
        reason: best.reason,
        swap_count: swapCount,
        max_swaps: maxSwaps,
      });
    }

    // Migrate session if we have one
    if (session) {
      const migration = migrateSession(
        currentAccount.configDir,
        nextAccount.configDir,
        cwd,
        session.sessionId
      );

      if (migration.success) {
        sessionId = session.sessionId;
        console.error(`[claude-nonstop] Session ${sessionId} migrated successfully`);
      } else {
        console.error(`[claude-nonstop] Session migration failed: ${migration.error}`);
        console.error('[claude-nonstop] Starting fresh session on new account');
        sessionId = null;
      }
    } else {
      sessionId = null;
    }

    // Update args for resume if we have a session — include continuation
    // message so Claude picks up immediately instead of waiting for input
    if (sessionId) {
      claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
    }

    currentAccount = nextAccount;
  }
}

/**
 * Run Claude once, monitoring for rate limits.
 *
 * @returns {Promise<{ exitCode: number|null, rateLimitDetected: boolean, resetTime: string|null, sessionId: string|null }>}
 */
function runOnce(claudeArgs, account, existingSessionId, options = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: account.configDir,
      FORCE_COLOR: '1',
    };

    // Strip CLAUDECODE so spawned claude works from inside a Claude Code session
    delete env.CLAUDECODE;

    if (options.remoteAccess) {
      env.CLAUDE_REMOTE_ACCESS = 'true';
    }

    const child = pty.spawn(CLAUDE_BIN, claudeArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });

    // Resize PTY when the real terminal resizes
    const onResize = () => {
      try { child.resize(process.stdout.columns, process.stdout.rows); } catch {}
    };
    process.stdout.on('resize', onResize);

    // Forward stdin to the PTY (resume in case it was paused by a previous runOnce)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    const onStdinData = (data) => {
      // Ctrl+Z (^Z = 0x1a): raw mode intercepts it before the OS can turn it into SIGTSTP.
      // Forward to PTY so claude suspends, then suspend ourselves too so the shell
      // can bring both back with `fg`.
      if (data.length === 1 && data[0] === 0x1a) {
        child.write(data);

        if (process.stdin.isTTY) {
          try { process.stdin.setRawMode(false); } catch {}
        }
        process.stdin.pause();

        process.stderr.write(
          '[claude-nonstop] Suspending... Press Ctrl+Z once more to send to background.\r\n'
        );

        process.once('SIGCONT', () => {
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch {}
          }
          process.stdin.resume();
          try { child.kill('SIGCONT'); } catch {}
        });

        process.kill(process.pid, 'SIGSTOP');
        return;
      }
      child.write(data);
    };
    process.stdin.on('data', onStdinData);
    process.stdin.on('error', () => {});

    let rateLimitDetected = false;
    let resetTime = null;
    let outputBuffer = '';

    child.onData((data) => {
      process.stdout.write(data);

      // Scan for rate limit patterns in rolling buffer
      outputBuffer += data;
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) {
        outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_TRIM);
      }

      if (rateLimitDetected) return;

      // Filter out user input lines before pattern matching
      const cleanedBuffer = outputBuffer.replace(INPUT_LINE_PATTERN, '');

      // Primary pattern: "Limit reached · resets ..."
      // Strip ANSI codes before matching — FORCE_COLOR=1 means output has styling
      const stripped = stripAnsi(cleanedBuffer);
      const match = RATE_LIMIT_PATTERN.exec(stripped);

      if (match) {
        rateLimitDetected = true;
        resetTime = match[1].trim();
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_DELAY);
        return;
      }
    });

    // Forward signals to child
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = {};
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;

      for (const sig of signals) {
        process.removeListener(sig, signalHandlers[sig]);
      }

      process.stdin.removeListener('data', onStdinData);
      process.stdin.pause();
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdout.removeListener('resize', onResize);
    }

    for (const sig of signals) {
      const handler = () => {
        if (!rateLimitDetected) {
          try { child.kill(sig); } catch {}
        }
      };
      signalHandlers[sig] = handler;
      process.on(sig, handler);
    }

    // Single onExit handler: cleanup + resolve
    child.onExit(({ exitCode, signal }) => {
      cleanup();

      resolve({
        exitCode: exitCode ?? null,
        rateLimitDetected,
        resetTime,
        sessionId: existingSessionId,
      });
    });
  });
}

/**
 * Extract --resume session ID from claude args if present.
 */
function extractResumeSessionId(args) {
  const idx = args.indexOf('--resume');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // Also check -r shorthand
  const idxR = args.indexOf('-r');
  if (idxR !== -1 && idxR + 1 < args.length) {
    return args[idxR + 1];
  }
  return null;
}

/** Known Claude CLI flags that take a value argument. */
const FLAGS_WITH_VALUES = new Set([
  '--append-system-prompt', '--model', '-m',
  '--allowedTools', '--disallowedTools',
]);

/**
 * Build new claude args with --resume flag.
 * Replaces existing --resume if present, otherwise prepends it.
 *
 * When continueMessage is provided (rate-limit swap), strips positional args
 * (the original user prompt and any previous continue message) so Claude
 * receives only the continuation prompt and picks up where it left off.
 */
function buildResumeArgs(originalArgs, sessionId, continueMessage) {
  const args = [...originalArgs];

  // Remove existing --resume or -r flags
  for (const flag of ['--resume', '-r']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      args.splice(idx, 2); // Remove flag and its value
    }
  }

  if (continueMessage) {
    // Strip positional args — keep only flags and their values
    const flagsOnly = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        flagsOnly.push(args[i]);
        if (FLAGS_WITH_VALUES.has(args[i]) && i + 1 < args.length) {
          flagsOnly.push(args[++i]);
        }
      }
    }
    flagsOnly.unshift('--resume', sessionId);
    flagsOnly.push(continueMessage);
    return flagsOnly;
  }

  // Prepend --resume
  args.unshift('--resume', sessionId);
  return args;
}

export {
  stripAnsi, extractResumeSessionId, buildResumeArgs, RATE_LIMIT_PATTERN,
  RATE_LIMIT_CONTINUE_MSG, FLAGS_WITH_VALUES,
  findEarliestReset, formatDuration, sleep, deactivateStaleChannels,
  EXHAUSTION_THRESHOLD, MAX_SLEEP_MS,
};
