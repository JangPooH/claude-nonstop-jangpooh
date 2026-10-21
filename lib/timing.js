/**
 * Startup timing log: one line per launch with per-step durations, so a slow
 * start can be traced after the fact.
 *
 * Written to {CONFIG_DIR}/logs/startup-timing.log. Spans of parallel work
 * (per-account usage checks) overlap, so their sum can exceed the total.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './config.js';

const LOG_PATH = path.join(CONFIG_DIR, 'logs', 'startup-timing.log');
const SLOW_MS = 3000;

const spans = [];

/** Mask OAuth / Slack tokens: error text is logged whole, so it may carry one. */
export function redactSecrets(text) {
  return String(text).replace(/(sk-ant|xoxb|xoxp|xapp)-[A-Za-z0-9_-]+/g, '$1-***');
}

export function record(label, ms, detail = '') {
  spans.push({ label, ms, detail });
}

/** Run fn (sync or async) and record how long it took, plus the error if it throws. */
export async function timed(label, fn) {
  const start = Date.now();
  let detail = '';
  try {
    return await fn();
  } catch (err) {
    detail = `error=${JSON.stringify(err?.message ?? String(err))}`;
    throw err;
  } finally {
    record(label, Date.now() - start, detail);
  }
}

/**
 * Append the collected spans as one line. total is the process uptime, so it
 * includes node startup and module loading.
 */
export function flushStartupTiming(command) {
  try {
    const total = Math.round(process.uptime() * 1000);
    const mark = (ms) => (ms >= SLOW_MS ? ' SLOW' : '');
    const parts = spans.map(s => `${s.label} ${s.ms}ms${mark(s.ms)}${s.detail ? ` ${s.detail}` : ''}`);
    const line = redactSecrets(`[${new Date().toISOString()}] ${command} total=${total}ms${mark(total)} | ${parts.join(' | ')}`) + '\n';
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
  } catch {
    // Silent fail on write error
  }
  spans.length = 0;
}
