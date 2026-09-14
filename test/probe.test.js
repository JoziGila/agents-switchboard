import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeProvider } from '../src/adapters/probe.js';

const provider = {
  name: 'deepseek',
  baseUrl: new URL('http://127.0.0.1:1'),
  responsesPath: '/responses',
  messagesPath: '/anthropic/v1/messages',
  models: ['deepseek-flash'],
  authHeaders: () => ({ authorization: 'Bearer k' }),
  endpoint(dialect) { return new URL(dialect === 'messages' ? this.messagesPath : this.responsesPath, this.baseUrl); },
};

function streamFrom(chunks) {
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
}

/** A 200 body that never carries a real content line, exactly what DeepSeek's stall looked like. */
function keepAliveForever(intervalMs = 5) {
  let timer;
  return new ReadableStream({
    start(c) { timer = setInterval(() => { try { c.enqueue(new TextEncoder().encode(': keep-alive\n\n')); } catch { /* closed */ } }, intervalMs); },
    cancel() { clearInterval(timer); },
  });
}

test('probe reports ok once real content arrives on both dialects', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    body: url.pathname.endsWith('/responses')
      ? streamFrom(['event: response.created\ndata: {"type":"response.created"}\n\n'])
      : streamFrom(['event: message_start\ndata: {"type":"message_start"}\n\n']),
  });
  const r = await probeProvider(provider, 'k', { fetchImpl, capMs: 200 });
  assert.deepEqual(r.responses, { ok: true });
  assert.deepEqual(r.messages, { ok: true });
});

test('a 200 with only keep-alive comment lines is reported stalled, not ok', async () => {
  const fetchImpl = async () => ({ ok: true, body: keepAliveForever(5) });
  const r = await probeProvider(provider, 'k', { fetchImpl, capMs: 60 });
  assert.equal(r.responses.ok, false);
  assert.match(r.responses.error, /^stalled: 200 but no content within \d+ s \(model [^)]+\)$/);
  assert.equal(r.messages.ok, false);
  assert.match(r.messages.error, /^stalled: 200 but no content within \d+ s \(model [^)]+\)$/);
});

test('a non-2xx response is still reported by status and body text, unaffected by the content check', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  const r = await probeProvider(provider, 'k', { fetchImpl, capMs: 200 });
  assert.equal(r.responses.ok, false);
  assert.equal(r.responses.error, '401 unauthorized');
});

test('a body that ends without ever producing content is stalled, not ok', async () => {
  const fetchImpl = async () => ({ ok: true, body: streamFrom([': keep-alive\n\n', ': keep-alive\n\n']) });
  const r = await probeProvider(provider, 'k', { fetchImpl, capMs: 200 });
  assert.equal(r.responses.ok, false);
  assert.match(r.responses.error, /stalled/);
});

/** A 200 whose content-type is neither SSE nor JSON (an HTML error/marketing page) is a wrong-endpoint error, not a stall. */
test('a 200 with a non-API content-type is reported by content-type, not treated as a stall', async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    body: streamFrom(['<html>not an api</html>']),
  });
  const r = await probeProvider(provider, 'k', { fetchImpl, capMs: 200 });
  assert.equal(r.responses.ok, false);
  assert.match(r.responses.error, /^200 text\/html; charset=utf-8 instead of an API response \(model [^)]+\)$/);
  assert.equal(r.messages.ok, false);
  assert.match(r.messages.error, /^200 text\/html; charset=utf-8 instead of an API response \(model [^)]+\)$/);
});
