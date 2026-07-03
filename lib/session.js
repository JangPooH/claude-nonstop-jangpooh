/**
 * Session migration between Claude Code config directories.
 *
 * Claude Code stores sessions at:
 *   <CLAUDE_CONFIG_DIR>/projects/<cwdHash>/<sessionId>.jsonl
 *
 * The cwdHash is the absolute CWD path with '/' replaced by '-'.
 * Example: /Users/rc/code/myproject -> -Users-rc-code-myproject
 *
 * When switching accounts mid-session, we copy the session files
 * to the new account's config dir so `claude --resume` can find them.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, statSync, realpathSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// UUID v4 pattern — Claude Code session IDs are always UUIDs
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a session ID to prevent path traversal.
 * Session IDs must be valid UUID v4 strings.
 *
 * @param {string} sessionId
 * @throws {Error} if the session ID is invalid
 */
export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session ID: must be a valid UUID');
  }
}

/**
 * Compute the project directory hash for a CWD.
 * Claude Code uses the absolute path with every non-alphanumeric character
 * (path separators, dots, spaces, etc.) replaced by '-'.
 *
 * @param {string} cwd - The working directory
 * @returns {string} The hashed directory name
 */
export function getCwdHash(cwd) {
  const resolved = cwd.startsWith('~')
    ? cwd.replace(/^~/, homedir())
    : cwd;
  return resolved.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Get the projects directory for a config dir and CWD.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR
 * @param {string} cwd - The working directory
 * @returns {string} Full path to the project's session directory
 */
export function getProjectDir(configDir, cwd) {
  const expanded = configDir.startsWith('~')
    ? configDir.replace(/^~/, homedir())
    : configDir;
  return join(expanded, 'projects', getCwdHash(cwd));
}

/**
 * Find the most recently modified session in a project directory.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR
 * @param {string} cwd - The working directory
 * @returns {{ sessionId: string, path: string } | null}
 */
export function findLatestSession(configDir, cwd) {
  const projectDir = getProjectDir(configDir, cwd);

  if (!existsSync(projectDir)) return null;

  let latest = null;
  let latestMtime = 0;

  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;

      const fullPath = join(projectDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latest = {
            sessionId: basename(entry, '.jsonl'),
            path: fullPath,
          };
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    return null;
  }

  return latest;
}

/**
 * Search all accounts' project directories for a specific session ID.
 *
 * @param {Array<{name: string, configDir: string}>} accounts
 * @param {string} sessionId - The session ID to find
 * @returns {{ account: object, cwdHash: string, path: string, mtime: number } | null}
 */
export function findSessionAcrossProfiles(accounts, sessionId) {
  validateSessionId(sessionId);
  const filename = `${sessionId}.jsonl`;
  let best = null;

  for (const account of accounts) {
    const expanded = account.configDir.startsWith('~')
      ? account.configDir.replace(/^~/, homedir())
      : account.configDir;
    const projectsDir = join(expanded, 'projects');

    if (!existsSync(projectsDir)) continue;

    let cwdHashes;
    try {
      cwdHashes = readdirSync(projectsDir);
    } catch {
      continue;
    }

    for (const cwdHash of cwdHashes) {
      const sessionPath = join(projectsDir, cwdHash, filename);
      try {
        const stat = statSync(sessionPath);
        if (!best || stat.mtimeMs > best.mtime) {
          best = { account, cwdHash, path: sessionPath, mtime: stat.mtimeMs };
        }
      } catch {
        // File doesn't exist in this cwdHash — skip
      }
    }
  }

  return best;
}

/**
 * Check whether a session is currently running in another process.
 *
 * Claude Code writes a live-process registry at <configDir>/sessions/<pid>.json
 * containing { pid, sessionId, cwd, status }. A session is "active" if a
 * registry entry references it and that pid is still alive.
 *
 * @param {string} configDir - The CLAUDE_CONFIG_DIR to check
 * @param {string} sessionId - The session ID to check
 * @returns {boolean}
 */
export function isSessionActive(configDir, sessionId) {
  const expanded = configDir.startsWith('~')
    ? configDir.replace(/^~/, homedir())
    : configDir;
  const sessionsDir = join(expanded, 'sessions');

  if (!existsSync(sessionsDir)) return false;

  let entries;
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(sessionsDir, entry), 'utf8'));
      if (data.sessionId !== sessionId) continue;
      // process.kill(pid, 0) throws if the pid doesn't exist; succeeds (no-op) if it's alive.
      process.kill(data.pid, 0);
      return true;
    } catch {
      // Malformed registry entry, or ESRCH (pid dead) from process.kill — not active.
    }
  }

  return false;
}

/**
 * Check whether a session is currently running in another process, under
 * ANY registered account. A session file can exist as a copy in more than
 * one account's config dir (left behind by a previous migration), so the
 * live registry entry may live in a different account than the candidate
 * file being considered.
 *
 * @param {Array<{name: string, configDir: string}>} accounts
 * @param {string} sessionId - The session ID to check
 * @returns {boolean}
 */
export function isSessionActiveAnywhere(accounts, sessionId) {
  return accounts.some(account => isSessionActive(account.configDir, sessionId));
}

/**
 * Find the most recently modified session across all accounts for the current project,
 * skipping sessions that are currently running in another process.
 *
 * @param {Array<{name: string, configDir: string}>} accounts
 * @param {string} cwd - The working directory to scope the search to
 * @returns {{ account: object, cwdHash: string, sessionId: string, path: string, mtime: number } | null}
 */
export function findLatestSessionAcrossProfiles(accounts, cwd) {
  const cwdHash = getCwdHash(cwd);
  const candidates = [];

  for (const account of accounts) {
    const expanded = account.configDir.startsWith('~')
      ? account.configDir.replace(/^~/, homedir())
      : account.configDir;
    const cwdDir = join(expanded, 'projects', cwdHash);

    if (!existsSync(cwdDir)) continue;

    let entries;
    try {
      entries = readdirSync(cwdDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(cwdDir, entry);
      try {
        const stat = statSync(fullPath);
        candidates.push({
          account,
          cwdHash,
          sessionId: basename(entry, '.jsonl'),
          path: fullPath,
          mtime: stat.mtimeMs,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  return candidates.find(c => !isSessionActiveAnywhere(accounts, c.sessionId)) || null;
}

/**
 * Get the model used in the last assistant turn of a session transcript.
 *
 * @param {string} sessionPath - Full path to the session .jsonl file
 * @returns {string | null} The raw model string (e.g. "claude-sonnet-5"), or null if not found
 */
export function getLastAssistantModel(sessionPath) {
  let content;
  try {
    content = readFileSync(sessionPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && entry.message?.model) {
        return entry.message.model;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return null;
}

/**
 * Find which account last used a session by checking all accounts' history.jsonl files.
 *
 * @param {Array<{name: string, configDir: string}>} accounts
 * @param {string} sessionId - The session ID to find
 * @returns {{ name: string, configDir: string } | null}
 */
export function getLastUsedAccount(accounts, sessionId) {
  validateSessionId(sessionId);
  let latestAccount = null;
  let latestTimestamp = -1;

  for (const account of accounts) {
    const expanded = account.configDir.startsWith('~')
      ? account.configDir.replace(/^~/, homedir())
      : account.configDir;
    const historyPath = join(expanded, 'history.jsonl');

    if (!existsSync(historyPath)) continue;

    try {
      const content = readFileSync(historyPath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId === sessionId && entry.timestamp > latestTimestamp) {
            latestTimestamp = entry.timestamp;
            latestAccount = account;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    } catch {
      // Skip if history file cannot be read
    }
  }

  return latestAccount;
}

/**
 * Migrate a session using a cwdHash directly (instead of computing from CWD).
 * Used by the resume command when the original CWD is unknown.
 *
 * @param {string} fromConfigDir - Source config directory
 * @param {string} toConfigDir - Destination config directory
 * @param {string} cwdHash - The project directory hash
 * @param {string} sessionId - The session ID to migrate
 * @returns {{ success: boolean, error?: string }}
 */
export function migrateSessionByHash(fromConfigDir, toConfigDir, cwdHash, sessionId) {
  validateSessionId(sessionId);
  try {
    const expandFrom = fromConfigDir.startsWith('~')
      ? fromConfigDir.replace(/^~/, homedir())
      : fromConfigDir;
    const expandTo = toConfigDir.startsWith('~')
      ? toConfigDir.replace(/^~/, homedir())
      : toConfigDir;

    const fromProjectDir = join(expandFrom, 'projects', cwdHash);
    const toProjectDir = join(expandTo, 'projects', cwdHash);

    if (!existsSync(toProjectDir)) {
      mkdirSync(toProjectDir, { recursive: true });
    }

    const sessionFile = `${sessionId}.jsonl`;
    const fromSession = join(fromProjectDir, sessionFile);
    const toSession = join(toProjectDir, sessionFile);

    if (!existsSync(fromSession)) {
      return { success: false, error: `Session file not found: ${fromSession}` };
    }

    const sameDir = realpathSync(fromProjectDir) === realpathSync(toProjectDir);
    if (!sameDir) {
      cpSync(fromSession, toSession, { force: true });

      // Copy tool-results directory if it exists
      const fromToolResults = join(fromProjectDir, sessionId);
      const toToolResults = join(toProjectDir, sessionId);

      if (existsSync(fromToolResults)) {
        cpSync(fromToolResults, toToolResults, { recursive: true, force: true });
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Migrate a session from one config dir to another.
 *
 * Copies:
 * - The session .jsonl file
 * - The associated tool-results directory (if it exists)
 *
 * @param {string} fromConfigDir - Source config directory
 * @param {string} toConfigDir - Destination config directory
 * @param {string} cwd - The working directory
 * @param {string} sessionId - The session ID to migrate
 * @returns {{ success: boolean, error?: string }}
 */
export function migrateSession(fromConfigDir, toConfigDir, cwd, sessionId) {
  validateSessionId(sessionId);
  try {
    const fromProjectDir = getProjectDir(fromConfigDir, cwd);
    const toProjectDir = getProjectDir(toConfigDir, cwd);

    // Ensure destination project directory exists
    if (!existsSync(toProjectDir)) {
      mkdirSync(toProjectDir, { recursive: true });
    }

    // Copy session file
    const sessionFile = `${sessionId}.jsonl`;
    const fromSession = join(fromProjectDir, sessionFile);
    const toSession = join(toProjectDir, sessionFile);

    if (!existsSync(fromSession)) {
      return { success: false, error: `Session file not found: ${fromSession}` };
    }

    const sameDir = realpathSync(fromProjectDir) === realpathSync(toProjectDir);
    if (!sameDir) {
      cpSync(fromSession, toSession, { force: true });

      // Copy tool-results directory if it exists
      const fromToolResults = join(fromProjectDir, sessionId);
      const toToolResults = join(toProjectDir, sessionId);

      if (existsSync(fromToolResults)) {
        cpSync(fromToolResults, toToolResults, { recursive: true, force: true });
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
