import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetAt, detectExhaustion, createFailoverState, liftResponsesLite } from '../src/failover.js';

const now = Date.UTC(2026, 8, 14, 12, 0, 0);

test('parseResetAt accepts epoch seconds, millis, RFC 3339, delta seconds', () => {
  assert.equal(parseResetAt('1789300000', now).getTime(), 1789300000000);
  assert.equal(parseResetAt(1789300000123, now).getTime(), 1789300000123);
  assert.equal(parseResetAt('2026-09-14T13:00:00Z', now).toISOString(), '2026-09-14T13:00:00.000Z');
  assert.equal(parseResetAt('90', now).getTime(), now + 90_000);
  assert.equal(parseResetAt('garbage', now), null);
  assert.equal(parseResetAt(undefined, now), null);
});

test('codex exhaustion: only usage_limit_reached on 429, reset from header, body, then retry-after, then 5 min', () => {
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: 1789300000 } });
  let v = detectExhaustion('codex', 429, { 'x-codex-primary-reset-at': '1789301000' }, body, now);
  assert.equal(v.triggered, true); assert.equal(v.resetAt.getTime(), 1789301000000);
  v = detectExhaustion('codex', 429, {}, body, now);
  assert.equal(v.resetAt.getTime(), 1789300000000);
  v = detectExhaustion('codex', 429, { 'retry-after': '30' }, JSON.stringify({ error: { type: 'usage_limit_reached' } }), now);
  assert.equal(v.resetAt.getTime(), now + 30_000);
  v = detectExhaustion('codex', 429, {}, JSON.stringify({ error: { type: 'usage_limit_reached' } }), now);
  assert.equal(v.resetAt.getTime(), now + 300_000);
  assert.equal(detectExhaustion('codex', 429, {}, JSON.stringify({ error: { type: 'rate_limit_exceeded' } }), now).triggered, false);
  assert.equal(detectExhaustion('codex', 500, {}, body, now).triggered, false);
});

test('claude exhaustion: unified rejected header or quota wording, never a plain per-minute limit', () => {
  const rl = (msg) => JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: msg } });
  assert.equal(detectExhaustion('claude', 429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': '1789300000' }, rl('x'), now).resetAt.getTime(), 1789300000000);
  assert.equal(detectExhaustion('claude', 429, {}, rl("You've hit your session limit"), now).triggered, true);
  assert.equal(detectExhaustion('claude', 429, {}, rl("You've hit your weekly limit"), now).triggered, true);
  assert.equal(detectExhaustion('claude', 429, { 'retry-after': '12' }, rl('Number of request tokens has exceeded your per-minute rate limit'), now).triggered, false);
  assert.equal(detectExhaustion('claude', 429, {}, JSON.stringify({ error: { type: 'overloaded_error' } }), now).triggered, false);
});

test('failover state expires and resets', () => {
  const s = createFailoverState();
  s.activate('codex', new Date(now + 60_000), 'limit');
  assert.equal(s.isActive('codex', now), true);
  assert.equal(s.isActive('claude', now), false);
  assert.equal(s.isActive('codex', now + 61_000), false);
  s.activate('claude', new Date(now + 60_000), 'limit');
  assert.deepEqual(Object.keys(s.snapshot(now + 61_000)), ['claude']);
  s.reset();
  assert.deepEqual(s.snapshot(now), {});
});

test('liftResponsesLite moves additional_tools into tools', () => {
  const body = { input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'a' }] }, { type: 'message', role: 'user', content: [] }], tools: [{ type: 'function', name: 'b' }] };
  const out = liftResponsesLite(body);
  assert.deepEqual(out.tools.map((t) => t.name), ['b', 'a']);
  assert.equal(out.input.length, 1);
  assert.equal(liftResponsesLite({ input: [] }).tools, undefined);
});
