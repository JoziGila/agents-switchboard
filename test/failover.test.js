import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetAt, detectExhaustion, createFailoverState, plan, transient429, transient429Headers } from '../src/failover.js';
import { buildProviders } from '../src/providers.js';

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
  assert.deepEqual(Object.keys(s.snapshot(now)), ['claude']);
  s.reset();
  assert.deepEqual(s.snapshot(now), {});
});

/** A ctx shaped like the router's, over a config that serves exactly one provider model. */
function ctxFor({ enabled = true, model = 'deepseek-flash' } = {}) {
  const providers = buildProviders({ upstream: { deepseek: { base_url: 'http://127.0.0.1:1', models: ['deepseek-flash'] } } }, () => 'k');
  return { providers, failover: { enabled, model, state: createFailoverState() } };
}

test('plan: disabled never arms; enabled but inactive keeps the requested model and offers the fallback', () => {
  const off = ctxFor({ enabled: false });
  assert.deepEqual(plan(off, 'codex', 'gpt-5.5'), { armed: false, fallback: null, fallbackModel: null });

  const on = ctxFor();
  const idle = plan(on, 'codex', 'gpt-5.5');
  assert.equal(idle.armed, false);
  assert.equal(idle.fallback.name, 'deepseek', 'the fallback is resolved even while idle, so a 429 can still be inspected');
  assert.equal(idle.fallbackModel, 'deepseek-flash', 'fallbackModel is what the fallback would be sent, so a 429 that arms it already has its model');

  const unresolved = ctxFor({ model: 'gpt-5.5' });
  assert.deepEqual(plan(unresolved, 'codex', 'gpt-5.5'), { armed: false, fallback: null, fallbackModel: null }, 'an unserved fallback model is no failover');
});

test('plan: once active it arms and switches the model, per client', () => {
  const ctx = ctxFor();
  ctx.failover.state.activate('codex', new Date(Date.now() + 60_000), 'limit');
  assert.equal(plan(ctx, 'codex', 'gpt-5.5').armed, true);
  assert.equal(plan(ctx, 'codex', 'gpt-5.5').fallbackModel, 'deepseek-flash');
  assert.equal(plan(ctx, 'claude', 'claude-sonnet-5').armed, false, "one client's exhaustion does not arm the other");
  assert.equal(plan(ctx, 'claude', 'claude-sonnet-5').fallbackModel, 'deepseek-flash', 'fallbackModel reflects the resolved fallback regardless of which client is armed');
});

test("transient429: only the client's own retry and usage-meter headers are kept", () => {
  assert.equal(transient429('codex', { 'retry-after': '3' }), true);
  assert.equal(transient429('codex', { 'x-codex-primary-reset-at': '1789300000' }), true);
  assert.equal(transient429('codex', { 'anthropic-ratelimit-requests-remaining': '0' }), false);
  assert.equal(transient429('codex', {}), false);
  assert.equal(transient429('codex', undefined), false);
  assert.equal(transient429('claude', { 'retry-after': '3' }), true);
  assert.equal(transient429('claude', { 'anthropic-ratelimit-tokens-remaining': '10' }), true);
  assert.equal(transient429('claude', { 'x-codex-primary-reset-at': '1789300000' }), false);
  assert.equal(transient429('claude', { 'content-type': 'application/json' }), false);
});

test('transient429Headers copies exactly the allow-listed headers', () => {
  assert.deepEqual(transient429Headers('codex', { 'retry-after': '3', 'x-codex-primary-reset-at': '1789300000', 'content-type': 'application/json', 'set-cookie': 'x' }),
    { 'retry-after': '3', 'x-codex-primary-reset-at': '1789300000' });
  assert.deepEqual(transient429Headers('claude', { 'retry-after': '3', 'anthropic-ratelimit-tokens-remaining': '10', 'x-codex-primary-reset-at': '1789300000' }),
    { 'retry-after': '3', 'anthropic-ratelimit-tokens-remaining': '10' });
  assert.deepEqual(transient429Headers('codex', {}), {});
});

test('failover reset exits 1 on a non-2xx response and redacts the token it was sent', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { tempHome, write } = await import('./helpers.js');
  const path = await import('node:path');
  const { paths, cleanup } = tempHome();

  // A loopback stub standing in for the router: it rejects the capability and echoes it back in the body,
  // which is exactly the case the command must not print. No provider, service, or real config is touched.
  const server = createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid local access token tok-A' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    write(paths.configFile, `listen = "127.0.0.1:${port}"\naccess_token = "tok-A"\n`);
    const result = await new Promise((resolve, reject) => {
      // HOME and AGENTS_SWITCHBOARD_HOME both point inside the temp home, so the real config is never read.
      const child = spawn(process.execPath, ['bin/switchboard.js', 'failover', 'reset'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, HOME: paths.home, AGENTS_SWITCHBOARD_HOME: paths.switchboardHome, CODEX_HOME: paths.codexHome, CLAUDE_CONFIG_DIR: paths.claudeHome },
      });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });

    assert.equal(result.code, 1, 'a non-2xx reset is a failure, not a printed success');
    assert.match(result.err, /reset failed: HTTP 400/);
    assert.doesNotMatch(result.err, /tok-A/, 'the raw token is never echoed');
    assert.match(result.err, /\[redacted\]/, 'the upstream message is still reported, minus the token');
  } finally {
    await new Promise((r) => server.close(r));
    cleanup();
  }
});
