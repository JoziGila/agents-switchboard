import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createServer } from '../src/server.js';

const seen = { openai: [], anthropic: [], deepseek: [], openrouter: [] };
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

let openai, anthropic, deepseek, openrouter, sb, base;
before(async () => {
  openai = await mock('openai', (req, res) => {
    if (req.headers['x-mock'] === 'quota') { res.writeHead(429, { 'content-type': 'application/json', 'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 600) }); res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } })); return; }
    if (req.headers['x-mock'] === 'ratelimit') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }); res.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } })); return; }
    if (req.url.startsWith('/backend-api/codex/models')) { res.writeHead(200, { 'content-type': 'application/json', etag: '"up1"' }); res.end(JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })); return; }
    sse(res, [{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  });
  anthropic = await mock('anthropic', (req, res) => {
    if (req.headers['x-mock'] === 'quota') { res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 600) }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your session limit" } })); return; }
    return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'message_stop' }]);
  });
  deepseek = await mock('deepseek', (req, res) => {
    if (req.url === '/responses') return sse(res, [{ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 90 } } } }]);
    if (req.url === '/anthropic/v1/messages') return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 50, prompt_cache_hit_tokens: 40 } } }, { type: 'message_delta', usage: { output_tokens: 3, prompt_cache_hit_tokens: 40, input_tokens: 50 } }]);
    res.writeHead(404); res.end();
  });
  openrouter = await mock('openrouter', (req, res) => {
    if (req.url === '/v1/responses') return sse(res, [{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_or_1', encrypted_content: 'E' } }, { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, cost: 0.0004 } } }]);
    if (req.url === '/v1/messages') return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 4 } } }, { type: 'message_stop' }]);
    res.writeHead(404); res.end();
  });
  const config = {
    listen: '127.0.0.1:0',
    upstream: {
      openai: { base_url: `http://127.0.0.1:${openai.address().port}/backend-api/codex` },
      anthropic: { base_url: `http://127.0.0.1:${anthropic.address().port}` },
      deepseek: { base_url: `http://127.0.0.1:${deepseek.address().port}`, models: ['deepseek-flash', 'deepseek-v4-pro'] },
      openrouter: { base_url: `http://127.0.0.1:${openrouter.address().port}`, models: ['qwen/qwen3-coder'] },
    },
    failover: { enabled: true, model: 'deepseek-flash' },
  };
  sb = createServer({ config, keyFor: async (section) => (section === config.upstream.openrouter ? 'sk-or-test' : 'sk-ds-test') });
  await new Promise((r) => sb.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${sb.address().port}`;
});
after(() => { for (const s of [openai, anthropic, deepseek, openrouter, sb]) s.close(); });

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('codex /models is merged and etag forked', async () => {
  const r = await fetch(base + '/backend-api/codex/models?client_version=0.154.0', { headers: { authorization: 'Bearer t' } });
  const j = await r.json();
  assert.deepEqual(j.models.map((m) => m.slug), ['gpt-5.5', 'deepseek-flash', 'deepseek-v4-pro', 'qwen/qwen3-coder']);
  assert.equal(j.models.at(-1).display_name, 'qwen3-coder');
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

test('codex openrouter model routes to openrouter with attribution headers and cost', async () => {
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'qwen/qwen3-coder', input: [], reasoning: { effort: 'xhigh' } })));
  const r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer chatgpt', 'x-codex-routing-hint': 'model=qwen/qwen3-coder', 'thread-id': 'thr-1' });
  assert.equal(r.status, 200); await r.text();
  const up = seen.openrouter.at(-1);
  assert.equal(up.url, '/v1/responses');
  assert.equal(up.headers.authorization, 'Bearer sk-or-test');
  assert.equal(up.headers['x-title'], 'agents-switchboard');
  const sentBody = JSON.parse(up.body.toString());
  assert.equal(sentBody.reasoning.effort, 'high');
  assert.deepEqual(sentBody.provider, { require_parameters: true, allow_fallbacks: true });
  assert.equal(sentBody.session_id, 'thr-1');
  assert.equal(up.headers['x-session-id'], 'thr-1');
  const snap = sb.statusJson();
  assert.equal(snap.models['qwen/qwen3-coder'].requests, 1);
  assert.ok(snap.models['qwen/qwen3-coder'].usd > 0, 'cost from usage.cost');
});

test('openrouter reasoning provenance: its own encrypted items go back, foreign ones are stripped', async () => {
  const input = [{ type: 'reasoning', id: 'rs_or_1', encrypted_content: 'E', summary: [] }, { type: 'reasoning', id: 'rs_openai_9', encrypted_content: 'F', summary: [] }];
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'qwen/qwen3-coder', input })));
  const r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer chatgpt', 'x-codex-routing-hint': 'model=qwen/qwen3-coder' });
  assert.equal(r.status, 200); await r.text();
  const sent = JSON.parse(seen.openrouter.at(-1).body.toString());
  assert.deepEqual(sent.input.map((i) => [i.id, 'encrypted_content' in i]), [['rs_or_1', true]]);
});

test('claude openrouter model routes to /v1/messages with adaptive thinking kept', async () => {
  const body = JSON.stringify({ model: 'anthropic/claude-sonnet-5[1m]', thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] });
  const r = await post('/anthropic/v1/messages?beta=true', body, { authorization: 'Bearer sk-ant-oat', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14', 'x-claude-code-session-id': 'sess-1', 'x-claude-code-agent-id': 'ag-2' });
  assert.equal(r.status, 200); await r.text();
  const up = seen.openrouter.at(-1);
  assert.equal(up.url, '/v1/messages');
  const sent = JSON.parse(up.body.toString());
  assert.equal(sent.model, 'anthropic/claude-sonnet-5');
  assert.deepEqual(sent.thinking, { type: 'adaptive' });
  assert.equal(sent.provider.require_parameters, true);
  assert.equal(up.headers['anthropic-beta'], undefined);
  assert.equal(up.headers['x-anthropic-beta'], 'interleaved-thinking-2025-05-14');
  assert.equal(up.headers['x-session-id'], 'sess-1/ag-2');
});

test('codex quota 429 fails the turn over to the fallback provider and stays there until reset', async () => {
  const before = seen.openai.length;
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: [] }], tools: [] })));
  let r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-5.5', 'x-mock': 'quota' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /response\.completed/);
  assert.equal(JSON.parse(seen.deepseek.at(-1).body.toString()).model, 'deepseek-flash');
  assert.equal(sb.statusJson().failover.active.codex?.reason, 'The usage limit has been reached');
  // second request: OpenAI is not even asked
  r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-5.5' });
  assert.equal(r.status, 200); await r.text();
  assert.equal(seen.openai.length, before + 1);
  // reset clears it and OpenAI is used again
  assert.equal((await fetch(base + '/switchboard/failover/reset', { method: 'POST' })).status, 200);
  r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-5.5' });
  assert.equal(r.status, 200); await r.text();
  assert.equal(seen.openai.length, before + 2);
  assert.deepEqual(sb.statusJson().failover.active, {});
});

test('a plain rate limit is relayed as 429, not failed over', async () => {
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [] })));
  const r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-5.5', 'x-mock': 'ratelimit' });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, 'rate_limit_exceeded');
  assert.deepEqual(sb.statusJson().failover.active, {});
});

test('claude session-limit 429 fails over to the fallback provider', async () => {
  const body = JSON.stringify({ model: 'claude-sonnet-5', thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] });
  const r = await post('/anthropic/v1/messages?beta=true', body, { authorization: 'Bearer sk-ant-oat', 'x-mock': 'quota' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /message_start/);
  const sent = JSON.parse(seen.deepseek.at(-1).body.toString());
  assert.equal(sent.model, 'deepseek-flash');
  assert.deepEqual(sent.thinking, { type: 'enabled' });
  assert.equal(sb.statusJson().failover.active.claude?.reason, "You've hit your session limit");
  await fetch(base + '/switchboard/failover/reset', { method: 'POST' });
});
