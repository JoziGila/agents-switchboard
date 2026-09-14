import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createServer } from '../src/server.js';

const seen = { openai: [], anthropic: [], deepseek: [] };
function mock(name, handler) {
  const s = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen[name].push({ method: req.method, url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };

let openai, anthropic, deepseek, sb, base;
before(async () => {
  openai = await mock('openai', (req, res) => {
    if (req.url.startsWith('/backend-api/codex/models')) { res.writeHead(200, { 'content-type': 'application/json', etag: '"up1"' }); res.end(JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })); return; }
    sse(res, [{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  });
  anthropic = await mock('anthropic', (req, res) => sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'message_stop' }]));
  deepseek = await mock('deepseek', (req, res) => {
    if (req.url === '/responses') return sse(res, [{ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 90 } } } }]);
    if (req.url === '/anthropic/v1/messages') return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 50, prompt_cache_hit_tokens: 40 } } }, { type: 'message_delta', usage: { output_tokens: 3, prompt_cache_hit_tokens: 40, input_tokens: 50 } }]);
    res.writeHead(404); res.end();
  });
  const config = {
    listen: '127.0.0.1:0',
    upstream: { openai: { base_url: `http://127.0.0.1:${openai.address().port}/backend-api/codex` }, anthropic: { base_url: `http://127.0.0.1:${anthropic.address().port}` }, deepseek: { base_url: `http://127.0.0.1:${deepseek.address().port}`, models: ['deepseek-flash', 'deepseek-v4-pro'] } },
    failover: { enabled: false, model: 'deepseek-flash' },
  };
  sb = createServer({ config, deepseekKey: async () => 'sk-ds-test' });
  await new Promise((r) => sb.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${sb.address().port}`;
});
after(() => { for (const s of [openai, anthropic, deepseek, sb]) s.close(); });

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('codex /models is merged and etag forked', async () => {
  const r = await fetch(base + '/backend-api/codex/models?client_version=0.154.0', { headers: { authorization: 'Bearer t' } });
  const j = await r.json();
  assert.deepEqual(j.models.map((m) => m.slug), ['gpt-5.5', 'deepseek-flash', 'deepseek-v4-pro']);
  assert.match(r.headers.get('etag'), /^"up1\+sb[0-9a-f]{8}"$/);
  assert.equal(seen.openai.at(-1).headers.authorization, 'Bearer t');
});

test('codex gpt request passes through byte-for-byte without decompression', async () => {
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [] })));
  const r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-5.5', 'x-codex-turn-state': 'ts1' });
  assert.equal(r.status, 200);
  await r.text();
  const up = seen.openai.at(-1);
  assert.equal(up.url, '/backend-api/codex/responses');
  assert.ok(up.body.equals(body), 'bytes identical');
  assert.equal(up.headers['content-encoding'], 'zstd');
  assert.equal(up.headers['x-codex-turn-state'], 'ts1');
});

test('codex deepseek request is decoded, rewritten and routed', async () => {
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'deepseek-flash', store: false, include: ['reasoning.encrypted_content'], input: [], tools: [{ type: 'web_search' }] })));
  const r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer chatgpt', 'chatgpt-account-id': 'acc', 'x-codex-routing-hint': 'model=deepseek-flash', 'x-openai-subagent': 'explorer' });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /response\.completed/);
  const up = seen.deepseek.at(-1);
  const sent = JSON.parse(up.body.toString());
  assert.equal(up.headers.authorization, 'Bearer sk-ds-test');
  assert.equal(up.headers['chatgpt-account-id'], undefined);
  assert.equal(up.headers['x-openai-subagent'], undefined);
  assert.ok(!('store' in sent) && !('include' in sent));
  assert.deepEqual(sent.tools, []);
  const snap = sb.statusJson();
  assert.equal(snap.models['deepseek-flash'].cached, 90);
  assert.equal(snap.roles.explorer.requests, 1);
});

test('claude request to a claude model passes through with oauth headers', async () => {
  const body = JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
  const r = await post('/anthropic/v1/messages?beta=true', body, { authorization: 'Bearer sk-ant-oat', 'anthropic-beta': 'oauth-2025-04-20,x', 'anthropic-version': '2023-06-01' });
  assert.equal(r.status, 200); await r.text();
  const up = seen.anthropic.at(-1);
  assert.equal(up.url, '/v1/messages?beta=true');
  assert.equal(up.body.toString(), body);
  assert.equal(up.headers['anthropic-beta'], 'oauth-2025-04-20,x');
});

test('claude request to deepseek is rewritten, usage normalised', async () => {
  const body = JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] });
  const r = await post('/anthropic/v1/messages?beta=true', body, { authorization: 'Bearer sk-ant-oat', 'anthropic-beta': 'oauth-2025-04-20', 'x-claude-code-agent-id': 'a1' });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /"cache_read_input_tokens":40/);
  const up = seen.deepseek.at(-1);
  assert.equal(up.headers['x-api-key'], 'sk-ds-test');
  assert.equal(up.headers['anthropic-beta'], undefined);
  assert.deepEqual(JSON.parse(up.body.toString()).thinking, { type: 'enabled' });
  assert.equal(sb.statusJson().roles.subagent.cached, 40);
});

test('claude unsigned thinking is stripped before anthropic', async () => {
  const body = JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'ds' }, { type: 'text', text: 'a' }] }, { role: 'user', content: 'q' }] });
  const r = await post('/anthropic/v1/messages', body, { authorization: 'Bearer x' });
  assert.equal(r.status, 200); await r.text();
  const sent = JSON.parse(seen.anthropic.at(-1).body.toString());
  assert.deepEqual(sent.messages[0].content, [{ type: 'text', text: 'a' }]);
});

test('pass-through without credentials is refused; hello and count_tokens handled', async () => {
  const r = await post('/backend-api/codex/responses', '{}', { 'x-codex-routing-hint': 'model=gpt-5.5' });
  assert.equal(r.status, 401);
  assert.equal((await fetch(base + '/anthropic/api/hello', { method: 'HEAD' })).status, 200);
  const ct = await post('/anthropic/v1/messages/count_tokens', JSON.stringify({ model: 'deepseek-flash' }), { authorization: 'Bearer x' });
  assert.equal(ct.status, 404);
});

test('websocket upgrade is declined with 426', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request(base + '/backend-api/codex/responses', { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve('upgraded'));
    req.on('error', () => resolve('error'));
    req.end();
  });
  assert.equal(status, 426);
});
