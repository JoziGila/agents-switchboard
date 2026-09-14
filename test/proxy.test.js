// Behavioral regressions for the streaming lifecycle in src/proxy.js: a provider that mislabels a
// compressed body must not take the process down, and a client that hangs up must kill the vendor request.
// A client abort reaches the router as `res.close` → `req.proxySignal`, the same wiring createServer installs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.js';
import { passThrough } from '../src/proxy.js';
import { mockUpstream } from './helpers.js';

const messages = (model = 'deepseek-flash') => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });

/** A mock provider whose response shape each test selects. */
async function mockProvider() {
  const state = { opened: 0, closed: 0, mode: 'stream' };
  const server = await mockUpstream((req, res) => {
    state.opened++;
    res.on('close', () => { if (!res.writableEnded) state.closed++; });
    if (state.mode === 'corrupt') { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end('this body is not gzip'); return; }
    if (state.mode === 'stall') return; // never answers: only cancellation ends this request
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ping"}\n\n'); // headers and one byte, then silence
  });
  return { server, state };
}

const ACCESS_TOKEN = 'audit-test-token';

let provider, sb, root, base;
before(async () => {
  provider = await mockProvider();
  const upstream = `http://127.0.0.1:${provider.server.address().port}`;
  const config = {
    listen: '127.0.0.1:0',
    access_token: ACCESS_TOKEN,
    upstream: {
      openai: { base_url: 'http://127.0.0.1:1/backend-api/codex' },
      anthropic: { base_url: upstream },
      deepseek: { base_url: upstream, models: ['deepseek-flash'] },
    },
    failover: { enabled: false },
  };
  sb = createServer({ config, keyFor: async () => 'sk-ds' });
  await new Promise((r) => sb.listen(0, '127.0.0.1', r));
  root = `http://127.0.0.1:${sb.address().port}`;
  base = `${root}/_switchboard/${ACCESS_TOKEN}`;
});
after(() => {
  sb.closeAllConnections?.();
  provider.server.closeAllConnections?.();
  sb.close();
  provider.server.close();
});

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return cond();
}

/** Send a real client request and hang up after `abortAfterMs` (optionally once headers arrive). */
function clientRequest({ abortAfterMs, waitForHeaders = false }) {
  const payload = messages();
  const req = http.request({ host: '127.0.0.1', port: sb.address().port, path: `/_switchboard/${ACCESS_TOKEN}/anthropic/v1/messages`, method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x', 'content-length': Buffer.byteLength(payload) } });
  req.on('error', () => {});
  req.end(payload);
  if (waitForHeaders) req.on('response', (res) => { res.on('error', () => {}); setTimeout(() => req.destroy(), abortAfterMs); });
  else setTimeout(() => req.destroy(), abortAfterMs);
}

test('a malformed compressed provider body ends that client stream instead of killing the process', async () => {
  provider.state.mode = 'corrupt';
  // The stream ends with a broken connection rather than a clean body; either shape is fine as long as
  // the request terminates and the router survives it.
  await assert.rejects(async () => {
    const r = await fetch(`${base}/anthropic/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: messages() });
    await r.text();
  }, 'the client stream terminates instead of hanging');
  // Reaching these lines is the regression assertion: the unhandled zlib error used to abort the process.
  assert.equal((await fetch(`${root}/switchboard/health`)).status, 200, 'the router is still serving');
  provider.state.mode = 'stream';
});

test('a client that hangs up before upstream headers tears the vendor request down', async () => {
  provider.state.mode = 'stall';
  const opened = provider.state.opened, closed = provider.state.closed;
  clientRequest({ abortAfterMs: 200 });
  assert.ok(await waitFor(() => provider.state.opened > opened), 'the vendor request was opened');
  assert.ok(await waitFor(() => provider.state.closed > closed), 'the vendor request was destroyed on client abort');
  provider.state.mode = 'stream';
});

test('a client that hangs up after headers still tears the vendor stream down', async () => {
  provider.state.mode = 'stream';
  const opened = provider.state.opened, closed = provider.state.closed;
  clientRequest({ abortAfterMs: 150, waitForHeaders: true });
  assert.ok(await waitFor(() => provider.state.opened > opened), 'the vendor request was opened');
  assert.ok(await waitFor(() => provider.state.closed > closed), 'the vendor stream was destroyed on client abort');
});

test('a path resolving to a different origin than the configured upstream is refused', async () => {
  // These are the forms a client request line reaches the router as: `//host/x` and an absolute URL.
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {} });
  for (const path of ['//evil.example/steal', 'http://evil.example/steal', '//127.0.0.1:9/steal']) {
    await assert.rejects(() => passThrough(req, new EventEmitter(), new URL('http://127.0.0.1:1'), path),
      (e) => e.status === 400 && /different origin/.test(e.message), path);
  }
  // A same-origin path is not refused by the guard itself.
  await assert.rejects(() => passThrough(req, new EventEmitter(), new URL('http://127.0.0.1:1'), '/v1/messages'),
    (e) => e.status !== 400, 'same-origin path passes the origin guard');
});
