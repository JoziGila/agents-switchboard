import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer, authorize } from '../src/server.js';
import { mockUpstream } from './helpers.js';

const seen = { openai: [], anthropic: [], deepseek: [], openrouter: [] };
const mock = (name, handler) => mockUpstream(handler, seen[name]);
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };

let openai, anthropic, deepseek, openrouter, sb, base, sbLegacy, legacyOrigin, tmpLogs, requestLog, config;
const logs = [];
before(async () => {
  openai = await mock('openai', (req, res) => {
    if (req.headers['x-mock'] === 'quota') { res.writeHead(429, { 'content-type': 'application/json', 'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 600) }); res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } })); return; }
    if (req.headers['x-mock'] === 'ratelimit') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }); res.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } })); return; }
    if (req.url.startsWith('/backend-api/codex/models')) { res.writeHead(200, { 'content-type': 'application/json', etag: '"up1"' }); res.end(JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })); return; }
    sse(res, [{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  });
  anthropic = await mock('anthropic', (req, res) => {
    if (req.headers['x-mock'] === 'ratelimit') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3', 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-tokens-remaining': '10' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })); return; }
    if (req.headers['x-mock'] === 'quota') { res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 600) }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your session limit" } })); return; }
    return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'message_stop' }]);
  });
  deepseek = await mock('deepseek', (req, res) => {
    if (req.headers['x-mock'] === 'reject-input') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid input[0]: AUDIT_PRIVATE_ERROR_MARKER' } })); return; }
    if (req.headers['x-mock'] === 'reject-input-3') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid input[3]: AUDIT_PRIVATE_ERROR_MARKER' } })); return; }
    if (req.headers['x-mock'] === 'tool-call') return sse(res, [{ type: 'response.output_item.done', item: { type: 'function_call', name: 'collaboration__spawn_agent', call_id: 'call-1', arguments: '{}' } }]);
    // A 200 with an HTML body: what a wrong-URL request (the OpenRouter marketing site) looks like upstream.
    if (req.headers['x-mock'] === 'html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html><body>AUDIT_PRIVATE_HTML_MARKER not an API response</body></html>'); return; }
    // Headers plus one SSE line, then silence: the caller aborts to simulate a client disconnect mid-stream.
    if (req.headers['x-mock'] === 'hold-open') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`); return; }
    // Headers plus one SSE line, then the socket is torn down: simulates an upstream reset mid-stream.
    if (req.headers['x-mock'] === 'reset-mid-stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`); setImmediate(() => res.destroy()); return; }
    if (req.url === '/responses') return sse(res, [{ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 90 } } } }]);
    if (req.url === '/anthropic/v1/messages') return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 50, prompt_cache_hit_tokens: 40 } } }, { type: 'message_delta', usage: { output_tokens: 3, prompt_cache_hit_tokens: 40, input_tokens: 50 } }]);
    res.writeHead(404); res.end();
  });
  openrouter = await mock('openrouter', (req, res) => {
    if (req.url === '/v1/responses') return sse(res, [{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_or_1', encrypted_content: 'E' } }, { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, cost: 0.0004 } } }]);
    if (req.url === '/v1/messages') return sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 4 } } }, { type: 'message_stop' }]);
    res.writeHead(404); res.end();
  });
  config = {
    listen: '127.0.0.1:0',
    access_token: 'audit-test-token',
    upstream: {
      openai: { base_url: `http://127.0.0.1:${openai.address().port}/backend-api/codex` },
      anthropic: { base_url: `http://127.0.0.1:${anthropic.address().port}` },
      deepseek: { base_url: `http://127.0.0.1:${deepseek.address().port}`, models: ['deepseek-flash', 'deepseek-v4-pro'] },
      openrouter: { base_url: `http://127.0.0.1:${openrouter.address().port}`, models: ['qwen/qwen3-coder'] },
    },
    failover: { enabled: true, model: 'deepseek-flash' },
  };
  tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-server-test-'));
  requestLog = path.join(tmpLogs, 'requests.jsonl');
  sb = createServer({ config, keyFor: async (section) => (section === config.upstream.openrouter ? 'sk-or-test' : 'sk-ds-test'), logFile: requestLog, log: (line) => logs.push(line) });
  await new Promise((r) => sb.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${sb.address().port}/_switchboard/audit-test-token`;
  // The same router before `switchboard install` minted a token: legacy paths, no capability prefix.
  sbLegacy = createServer({ config: { ...config, access_token: undefined }, keyFor: async (section) => (section === config.upstream.openrouter ? 'sk-or-test' : 'sk-ds-test'), log: (line) => logs.push(line) });
  await new Promise((r) => sbLegacy.listen(0, '127.0.0.1', r));
  legacyOrigin = `http://127.0.0.1:${sbLegacy.address().port}`;
});
after(() => { for (const s of [openai, anthropic, deepseek, openrouter, sb, sbLegacy]) s.close(); fs.rmSync(tmpLogs, { recursive: true, force: true }); });

/** stats.record writes through a stream: poll for the gate line rather than racing the write. */
async function gateEntry(file, want = 1) {
  for (let i = 0; i < 25; i++) {
    const entries = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((l) => l.route === 'gate') : [];
    if (entries.length >= want) return entries[entries.length - 1];
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('authorize: open, ok, and every deny case including a supplied segment on a tokenless router', () => {
  assert.equal(authorize(null, { access_token: '' }), 'open');
  assert.equal(authorize(null, {}), 'open'); // no access_token key at all is the same as ''
  assert.equal(authorize('tok', { access_token: 'tok' }), 'ok');
  assert.equal(authorize('', { access_token: '' }), 'deny', 'a supplied segment on a tokenless router is deny');
  assert.equal(authorize('anything', { access_token: '' }), 'deny', 'a supplied segment on a tokenless router is deny');
  assert.equal(authorize(null, { access_token: 'tok' }), 'deny', 'a configured token with no segment supplied is deny');
  assert.equal(authorize('wrong', { access_token: 'tok' }), 'deny');
  assert.equal(authorize('', { access_token: 'tok' }), 'deny');
});

test('codex /models is merged and etag forked', async () => {
  const r = await fetch(base + '/backend-api/codex/models?client_version=0.154.0', { headers: { authorization: 'Bearer t' } });
  const j = await r.json();
  assert.deepEqual(j.models.map((m) => m.slug), ['gpt-5.5', 'deepseek-flash', 'deepseek-v4-pro', 'qwen/qwen3-coder']);
  assert.ok(j.models.every((m) => m.multi_agent_version !== 'v2'), 'no entry is served as v2');
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
  assert.equal(r.status, 400);
  assert.equal((await post('/backend-api/codex/responses', '{}', { 'x-codex-routing-hint': 'model=deepseek-flash' })).status, 400, 'provider routes need the client credential too');
  assert.equal((await fetch(base + '/backend-api/codex/models')).status, 400);
  const big = await post('/anthropic/v1/messages', Buffer.alloc(33 * 1024 * 1024), { authorization: 'Bearer x' });
  assert.equal(big.status, 413);
  assert.equal((await fetch(base + '/anthropic/api/hello', { method: 'HEAD' })).status, 200);
  const ct = await post('/anthropic/v1/messages/count_tokens', JSON.stringify({ model: 'deepseek-flash' }), { authorization: 'Bearer x' });
  assert.equal(ct.status, 404);
});

test('a tokenless request for the bare route prefix gets the reinstall guidance, not a 404', async () => {
  const origin = new URL(base).origin;
  for (const path of ['/backend-api/codex', '/anthropic']) {
    const r = await fetch(origin + path, { headers: { authorization: 'Bearer invented-token' } });
    assert.equal(r.status, 400, path);
    assert.match((await r.json()).error.message, /local access token required/);
  }
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

test('responses-lite tools retain their namespace during active quota failover', async () => {
  try {
    const headers = { authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-6-astra' };
    const quota = await post('/backend-api/codex/responses', JSON.stringify({ model: 'gpt-6-astra', input: [] }), { ...headers, 'x-mock': 'quota' });
    await quota.text();
    const body = { model: 'gpt-6-astra', input: [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] }] }] };
    const response = await post('/backend-api/codex/responses', JSON.stringify(body), { ...headers, 'x-mock': 'tool-call' });
    assert.equal(response.status, 200);
    const text = await response.text();
    const event = JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    assert.equal(event.item.name, 'spawn_agent');
    assert.equal(event.item.namespace, 'collaboration');
    assert.equal(JSON.parse(seen.deepseek.at(-1).body).tools[0].name, 'collaboration__spawn_agent');
  } finally {
    await fetch(base + '/switchboard/failover/reset', { method: 'POST' });
  }
});

test('provider rejection does not log prompt or upstream error content', async () => {
  const start = logs.length;
  const response = await post('/backend-api/codex/responses', JSON.stringify({ model: 'deepseek-flash', input: [{ role: 'user', content: 'AUDIT_PRIVATE_PROMPT_MARKER' }] }), { authorization: 'Bearer t', 'x-codex-routing-hint': 'model=deepseek-flash', 'x-mock': 'reject-input' });
  assert.equal(response.status, 400);
  await response.text();
  assert.doesNotMatch(logs.slice(start).join('\n'), /AUDIT_PRIVATE_(PROMPT|ERROR)_MARKER/);
});

test('a rejected input is logged by index, type and role only', async () => {
  const start = logs.length;
  const input = [{ role: 'user', content: 'AUDIT_PRIVATE_PROMPT_MARKER' }, { role: 'user', content: 'AUDIT_PRIVATE_PROMPT_MARKER' }, { role: 'user', content: 'AUDIT_PRIVATE_PROMPT_MARKER' }, { role: 'user', content: 'AUDIT_PRIVATE_PROMPT_MARKER' }];
  const response = await post('/backend-api/codex/responses', JSON.stringify({ model: 'deepseek-flash', input }), { authorization: 'Bearer t', 'x-codex-routing-hint': 'model=deepseek-flash', 'x-mock': 'reject-input-3' });
  assert.equal(response.status, 400);
  await response.text();
  const said = logs.slice(start).join('\n');
  assert.match(said, /^deepseek rejected input\[3\] \(type=[^,)]+, role=[^)]+\)$/m);
  assert.doesNotMatch(said, /AUDIT_PRIVATE_(PROMPT|ERROR)_MARKER/);
});

test('invented client credentials cannot spend a provider key without the local capability', async () => {
  const origin = new URL(base).origin;
  const previous = seen.deepseek.length;
  for (const prefix of ['', '/_switchboard/incorrect-token']) {
    for (const [route, body] of [
      ['/backend-api/codex/responses', { model: 'deepseek-flash', input: [] }],
      ['/anthropic/v1/messages', { model: 'deepseek-flash', messages: [] }],
    ]) {
      const response = await fetch(origin + prefix + route, { method: 'POST', headers: { authorization: 'Bearer invented-token', 'content-type': 'application/json', 'x-codex-routing-hint': 'model=deepseek-flash' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      await response.text();
    }
  }
  assert.equal(seen.deepseek.length, previous);
  assert.doesNotMatch(logs.join('\n'), /audit-test-token|incorrect-token/);
  assert.equal((await fetch(origin + '/switchboard/health')).status, 200);
  assert.equal((await fetch(origin + '/switchboard/failover/reset', { method: 'POST' })).status, 400);
});

test('a protocol-relative Claude path cannot forward credentials to another host', async () => {
  const previous = seen.deepseek.length;
  const response = await fetch(`${base}/anthropic//127.0.0.1:${deepseek.address().port}/capture`, { headers: { authorization: 'Bearer private-client-token' } });
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(seen.deepseek.length, previous);
});

test('an absolute request target cannot override the Codex models upstream', async () => {
  const previous = seen.deepseek.length;
  const status = await new Promise((resolve, reject) => {
    const request = http.request(base, { path: `http://127.0.0.1:${deepseek.address().port}/backend-api/codex/models`, headers: { authorization: 'Bearer private-client-token' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 400);
  assert.equal(seen.deepseek.length, previous);
  const prefixed = await fetch(`${base}//127.0.0.1:${deepseek.address().port}/backend-api/codex/models`, { headers: { authorization: 'Bearer private-client-token' } });
  assert.equal(prefixed.status, 400);
  await prefixed.text();
  assert.equal(seen.deepseek.length, previous);
});

test('Claude transient rate limits preserve quota headers with failover enabled', async () => {
  const response = await post('/anthropic/v1/messages', JSON.stringify({ model: 'claude-sonnet-5', messages: [] }), { authorization: 'Bearer t', 'x-mock': 'ratelimit' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(response.headers.get('anthropic-ratelimit-requests-remaining'), '0');
  assert.equal(response.headers.get('anthropic-ratelimit-tokens-remaining'), '10');
  assert.equal((await response.json()).error.message, 'slow down');
  assert.deepEqual(sb.statusJson().failover.active, {});
});

test('a plain rate limit is relayed as 429 with its headers, not failed over', async () => {
  const body = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-5.5', input: [] })));
  const r = await post('/backend-api/codex/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=gpt-5.5', 'x-mock': 'ratelimit' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '3');
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

test('a router with no access_token serves the legacy vendor paths', async () => {
  const models = await fetch(`${legacyOrigin}/backend-api/codex/models?client_version=0.154.0`, { headers: { authorization: 'Bearer t' } });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).models.map((m) => m.slug), ['gpt-5.5', 'deepseek-flash', 'deepseek-v4-pro', 'qwen/qwen3-coder']);
  const claude = await fetch(`${legacyOrigin}/anthropic/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer sk-ant-oat', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(claude.status, 200);
  assert.match(await claude.text(), /message_start/);
  assert.equal(seen.anthropic.at(-1).url, '/v1/messages?beta=true');
  assert.equal(logs.filter((l) => l.includes('no access_token configured')).length, 1, 'announced exactly once');
});

test('a router with no access_token still refuses a capability prefix', async () => {
  const response = await fetch(`${legacyOrigin}/_switchboard/xyz/backend-api/codex/models`, { headers: { authorization: 'Bearer t' } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /invalid local access token/);
});

test('a gate rejection is recorded as traffic and carries no token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gate-test-'));
  const file = path.join(dir, 'requests.jsonl');
  const gated = createServer({ config, keyFor: async () => 'sk-ds-test', logFile: file });
  await new Promise((r) => gated.listen(0, '127.0.0.1', r));
  try {
    const rejected = await fetch(`http://127.0.0.1:${gated.address().port}/anthropic/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer invented-token', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 400);
    await rejected.text();
    const entry = await gateEntry(file);
    assert.deepEqual({ client: entry.client, route: entry.route, upstream: entry.upstream, status: entry.status }, { client: 'claude', route: 'gate', upstream: null, status: 400 });
    assert.equal(entry.url, undefined);
    const prefixed = await fetch(`http://127.0.0.1:${gated.address().port}/_switchboard/wrong/backend-api/codex/models`, { headers: { authorization: 'Bearer invented-token' } });
    assert.equal(prefixed.status, 400);
    await prefixed.text();
    const second = await gateEntry(file, 2);
    assert.deepEqual({ client: second.client, route: second.route, status: second.status }, { client: 'codex', route: 'gate', status: 400 });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /audit-test-token|invented-token|wrong/);
  } finally { gated.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A dedicated server + log file per abandoned-stream test, so `inflight`/log assertions never race the shared `sb`. */
async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-abort-test-'));
  const file = path.join(dir, 'requests.jsonl');
  const logLines = [];
  const s = createServer({ config, keyFor: async (section) => (section === config.upstream.openrouter ? 'sk-or-test' : 'sk-ds-test'), logFile: file, log: (line) => logLines.push(line) });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${s.address().port}/_switchboard/${config.access_token}`;
  try { await fn({ s, origin, entries: () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), logLines }); }
  finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function waitForEmptyInflight(s) {
  for (let i = 0; i < 25 && s.statusJson().inflight.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.statusJson().inflight, [], 'inflight is cleared');
}

test('codex client disconnect mid-stream clears inflight and logs exactly one entry', () => withServer(async ({ s, origin, entries }) => {
  const controller = new AbortController();
  const r = await fetch(`${origin}/backend-api/codex/responses`, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=deepseek-flash', 'x-mock': 'hold-open' },
    body: JSON.stringify({ model: 'deepseek-flash', input: [] }),
  });
  await r.body.getReader().read(); // the first SSE bytes, so the abort is genuinely mid-stream
  controller.abort();
  await waitForEmptyInflight(s);
  const e = entries();
  assert.equal(e.length, 1, 'exactly one log entry');
  assert.equal(e[0].route, 'responses');
  assert.equal(e[0].error, 'client disconnected');
}));

test('claude client disconnect mid-stream clears inflight and logs exactly one entry', () => withServer(async ({ s, origin, entries }) => {
  const controller = new AbortController();
  const r = await fetch(`${origin}/anthropic/v1/messages`, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-mock': 'hold-open' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await r.body.getReader().read();
  controller.abort();
  await waitForEmptyInflight(s);
  const e = entries();
  assert.equal(e.length, 1, 'exactly one log entry');
  assert.equal(e[0].route, 'messages');
  assert.equal(e[0].error, 'client disconnected');
}));

test('codex upstream reset mid-stream clears inflight and logs exactly one entry', () => withServer(async ({ s, origin, entries }) => {
  await assert.rejects(async () => {
    const r = await fetch(`${origin}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=deepseek-flash', 'x-mock': 'reset-mid-stream' },
      body: JSON.stringify({ model: 'deepseek-flash', input: [] }),
    });
    await r.text();
  }, 'the client stream terminates instead of hanging');
  await waitForEmptyInflight(s);
  const e = entries();
  assert.equal(e.length, 1, 'exactly one log entry');
  assert.equal(e[0].route, 'responses');
  assert.equal(e[0].error, 'upstream reset');
}));

test('codex normal completion still logs exactly one 200 entry', () => withServer(async ({ origin, entries }) => {
  const r = await fetch(`${origin}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=deepseek-flash' },
    body: JSON.stringify({ model: 'deepseek-flash', input: [] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  const e = entries();
  assert.equal(e.length, 1, 'exactly one log entry, no duplicate');
  assert.equal(e[0].status, 200);
  assert.equal(e[0].error, undefined);
}));

test('codex: a 2xx upstream response with a non-API content-type is relayed as 502, not success', () => withServer(async ({ origin, entries, logLines }) => {
  const r = await fetch(`${origin}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-codex-routing-hint': 'model=deepseek-flash', 'x-mock': 'html' },
    body: JSON.stringify({ model: 'deepseek-flash', input: [] }),
  });
  assert.equal(r.status, 502);
  const body = await r.text();
  assert.doesNotMatch(body, /AUDIT_PRIVATE_HTML_MARKER/, 'the html body is never relayed to the client');
  const e = entries();
  assert.equal(e.length, 1, 'exactly one log entry');
  assert.equal(e[0].status, 502);
  assert.equal(e[0].error, 'unexpected upstream content-type');
  assert.doesNotMatch(logLines.join('\n'), /AUDIT_PRIVATE_HTML_MARKER/, 'the html body never reaches the log');
}));

test('claude: a 2xx upstream response with a non-API content-type is relayed as 502, not success', () => withServer(async ({ origin, entries, logLines }) => {
  const r = await fetch(`${origin}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-mock': 'html' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 502);
  const body = await r.text();
  assert.doesNotMatch(body, /AUDIT_PRIVATE_HTML_MARKER/, 'the html body is never relayed to the client');
  const e = entries();
  assert.equal(e.length, 1, 'exactly one log entry');
  assert.equal(e[0].status, 502);
  assert.equal(e[0].error, 'unexpected upstream content-type');
  assert.doesNotMatch(logLines.join('\n'), /AUDIT_PRIVATE_HTML_MARKER/, 'the html body never reaches the log');
}));
