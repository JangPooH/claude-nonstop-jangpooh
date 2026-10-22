import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitEvent, eventToRaw, getSetupToken, setSetupToken, listEventTypes, parseResultEvent, formatProbeUsage } from '../../../lib/probe.js';
import { redactSecrets } from '../../../lib/timing.js';

// Shape captured from a real run (Claude Code stream-json, /login account, allowed state)
const ALLOWED_INFO = {
  status: 'allowed',
  resetsAt: 1792419000,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'out_of_credits',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.45, resetsAt: 1792419000 },
    seven_day: { utilization: 0.07, resetsAt: 1792681200 },
  },
};

// Shape captured from a real run (five_hour limit hit; the probe exited 1 with a 429 result)
const BLOCKED_INFO = {
  status: 'rejected',
  resetsAt: 1792669800,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'out_of_credits',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: 1792669800 },
    seven_day: { utilization: 0.61, resetsAt: 1792681200 },
  },
};

const eventLine = (info) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });

describe('parseRateLimitEvent', () => {
  it('returns the info of the rate_limit_event line', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      eventLine(ALLOWED_INFO),
      JSON.stringify({ type: 'result', subtype: 'success' }),
    ].join('\n');
    assert.deepEqual(parseRateLimitEvent(stdout), ALLOWED_INFO);
  });

  it('uses the last event when there are several', () => {
    const stdout = [eventLine({ ...ALLOWED_INFO, status: 'allowed' }), eventLine({ ...ALLOWED_INFO, status: 'rejected' })].join('\n');
    assert.equal(parseRateLimitEvent(stdout).status, 'rejected');
  });

  it('returns null when there is no event', () => {
    assert.equal(parseRateLimitEvent(JSON.stringify({ type: 'result' })), null);
    assert.equal(parseRateLimitEvent(''), null);
  });

  it('skips malformed lines', () => {
    const stdout = `{"type":"rate_limit_event", broken\n${eventLine(ALLOWED_INFO)}`;
    assert.deepEqual(parseRateLimitEvent(stdout), ALLOWED_INFO);
  });
});

describe('eventToRaw', () => {
  it('converts 0-1 fractions to percent and epoch seconds to ISO', () => {
    const raw = eventToRaw(ALLOWED_INFO);
    assert.equal(raw.source, 'probe');
    assert.deepEqual(raw.five_hour, { utilization: 45, resets_at: '2026-10-19T14:10:00.000Z' });
    assert.deepEqual(raw.seven_day, { utilization: 7, resets_at: '2026-10-22T15:00:00.000Z' });
  });

  it('keeps overage state', () => {
    assert.deepEqual(eventToRaw(ALLOWED_INFO).overage, {
      status: 'rejected',
      disabled_reason: 'out_of_credits',
      is_using_overage: false,
    });
  });

  it('treats allowed_warning as not blocked', () => {
    const raw = eventToRaw({ ...ALLOWED_INFO, status: 'allowed_warning' });
    assert.equal(raw.five_hour.utilization, 45);
  });

  it('marks the five_hour window as 100% when blocked on it', () => {
    const raw = eventToRaw({
      ...ALLOWED_INFO,
      status: 'rejected',
      rateLimitType: 'five_hour',
      unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: 1792681200 } },
    });
    assert.deepEqual(raw.five_hour, { utilization: 100, resets_at: '2026-10-19T14:10:00.000Z' });
    assert.equal(raw.seven_day.utilization, 30);
  });

  it('marks the seven_day window as 100% when blocked on it', () => {
    const raw = eventToRaw({
      ...ALLOWED_INFO,
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt: 1792681200,
    });
    assert.deepEqual(raw.seven_day, { utilization: 100, resets_at: '2026-10-22T15:00:00.000Z' });
  });

  it('reads both windows from a real blocked event', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      eventLine(BLOCKED_INFO),
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429 }),
    ].join('\n');
    const raw = eventToRaw(parseRateLimitEvent(stdout));
    assert.deepEqual(raw.five_hour, { utilization: 100, resets_at: '2026-10-22T11:50:00.000Z' });
    assert.deepEqual(raw.seven_day, { utilization: 61, resets_at: '2026-10-22T15:00:00.000Z' });
  });

  it('leaves an unreported window null instead of 0', () => {
    const raw = eventToRaw({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792419000 });
    assert.equal(raw.five_hour.utilization, 100);
    assert.equal(raw.seven_day, null);
  });
});

describe('getSetupToken', () => {
  it('returns null for a configDir that is not a registered account', () => {
    assert.equal(getSetupToken('/nonexistent/cn-test-dir'), null);
  });
});

// Shape captured from a real run (stream-json final result event)
const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 561,
    cache_read_input_tokens: 0,
    output_tokens: 47,
    cache_creation: { ephemeral_1h_input_tokens: 561, ephemeral_5m_input_tokens: 0 },
  },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 2 } },
};

describe('probe stream diagnostics', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    'not json',
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify(RESULT_EVENT),
  ].join('\n');

  it('lists event types in arrival order, skipping non-JSON lines', () => {
    assert.equal(listEventTypes(stdout), 'system:init,assistant,result:success');
  });

  it('shows a probe that stalled after init as just system:init', () => {
    assert.equal(listEventTypes(JSON.stringify({ type: 'system', subtype: 'init' })), 'system:init');
    assert.equal(listEventTypes(''), '');
  });

  it('finds the result event, or null', () => {
    assert.equal(parseResultEvent(stdout).subtype, 'success');
    assert.equal(parseResultEvent(JSON.stringify({ type: 'system' })), null);
  });

  it('formats model and token breakdown with cache write split by TTL', () => {
    assert.equal(
      formatProbeUsage(RESULT_EVENT),
      'model=claude-haiku-5-5 in=2 write=561(1h:561,5m:0) read=0 out=47',
    );
  });

  it('returns empty text when the result has no usage', () => {
    assert.equal(formatProbeUsage(null), '');
    assert.equal(formatProbeUsage({ type: 'result' }), '');
  });
});

describe('redactSecrets', () => {
  it('masks OAuth and Slack tokens', () => {
    assert.equal(redactSecrets('x sk-ant-oat01-AbC_d-1 y'), 'x sk-ant-*** y');
    assert.equal(redactSecrets('xoxb-123-abc xapp-1-Zz'), 'xoxb-*** xapp-***');
  });

  it('leaves other text untouched', () => {
    assert.equal(redactSecrets('probe: no rate_limit_event (exit null)'), 'probe: no rate_limit_event (exit null)');
  });
});

describe('setSetupToken', () => {
  it('rejects a malformed token before touching the Keychain', () => {
    assert.throws(() => setSetupToken('cn-test-dummy', 'not-a-token'), /valid setup-token/);
    assert.throws(() => setSetupToken('cn-test-dummy', ''), /valid setup-token/);
  });

  it('rejects a token that would inject extra security arguments', () => {
    assert.throws(() => setSetupToken('cn-test-dummy', 'sk-ant-x -T /bin/sh'), /valid setup-token/);
    assert.throws(() => setSetupToken('cn-test-dummy', 'sk-ant-x\nadd-generic-password'), /valid setup-token/);
  });
});
