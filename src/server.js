import http from 'node:http';
import { isDeepSeekModel, deepseekEntries, mergeModels, rewriteEtag, catalogHash, baseModelId } from './catalog.js';
import { rewriteResponsesRequest, mapDeepSeekError, usageFromResponsesEvent } from './adapters/responses.js';
import { rewriteMessagesRequest, hasUnsignedThinking, stripUnsignedThinking, normalizeSseData, usageFromMessagesEvent } from './adapters/messages.js';
import { readBody, decodeBody, sendJson, upstreamHeaders, upstreamRequest, relayResponse, passThrough, readResponse } from './proxy.js';
import { createSseRelay } from './sse.js';
import { createStats } from './stats.js';
import { renderStatusPage } from './status-page.js';

const CODEX_PREFIX = '/backend-api/codex';
const CLAUDE_PREFIX = '/anthropic';
const DROP_FOR_DEEPSEEK = ['authorization', 'x-api-key', 'chatgpt-account-id', 'session_id', 'session-id', 'thread-id', 'originator', 'anthropic-beta', 'anthropic-version', 'openai-beta', 'content-encoding', 'content-length', 'accept-encoding', 'x-client-request-id', 'anthropic-dangerous-direct-browser-access'];

function modelFromRoutingHint(h) {
  const m = /(?:^|[;,\s])model=([^;,\s]+)/.exec(h ?? '');
  return m ? m[1] : null;
}

function dropHeaders(headers) {
  const out = { ...headers };
  for (const k of Object.keys(out)) if (DROP_FOR_DEEPSEEK.includes(k) || k.startsWith('x-codex-') || k.startsWith('x-openai-') || k.startsWith('x-claude-code-') || k.startsWith('x-stainless-') || k.startsWith('x-app')) delete out[k];
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.config loaded switchboard config
 * @param {() => Promise<string|null>} opts.deepseekKey resolves the DeepSeek API key
 * @param {string} [opts.logFile]
 * @param {(line: string) => void} [opts.log]
 */
export function createServer({ config, deepseekKey, logFile, log = () => {} }) {
  const stats = createStats({ logFile });
  const entries = deepseekEntries(config.upstream.deepseek.models);
  const hash = catalogHash(entries);
  const openai = new URL(config.upstream.openai.base_url);
  const anthropic = new URL(config.upstream.anthropic.base_url);
  const deepseek = new URL(config.upstream.deepseek.base_url);

  async function requireKey(res) {
    const key = await deepseekKey();
    // Never answer a client with 401: both clients treat it as an expired login and try to refresh their token.
    if (!key) sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'agents-switchboard: no DeepSeek API key configured. Run `switchboard install`.' } });
    return key;
  }

  function requireClientAuth(req, res) {
    if (req.headers.authorization || req.headers['x-api-key']) return true;
    sendJson(res, 401, { error: { type: 'authentication_error', message: 'agents-switchboard: pass-through requires the client credential' } });
    return false;
  }

  // ---------- Codex ----------
  async function codexModels(req, res, path) {
    const url = new URL(path, openai);
    const up = await upstreamRequest(url, { method: 'GET', headers: upstreamHeaders(req.headers, url, { 'accept-encoding': 'identity' }) });
    if (up.statusCode !== 200) { relayResponse(up, res); stats.record({ client: 'codex', route: 'models', upstream: 'openai', status: up.statusCode }); return; }
    let payload;
    try { payload = JSON.parse((await readResponse(up)).toString('utf8')); } catch (e) { sendJson(res, 502, { error: { message: `switchboard: bad models payload: ${e.message}` } }); return; }
    const merged = mergeModels(payload, entries);
    const etag = rewriteEtag(up.headers.etag, hash);
    const headers = { etag };
    for (const k of ['cache-control', 'x-models-etag']) if (up.headers[k]) headers[k] = k === 'x-models-etag' ? etag : up.headers[k];
    sendJson(res, 200, merged, headers);
    stats.record({ client: 'codex', route: 'models', upstream: 'openai', status: 200, injected: entries.map((e) => e.slug) });
  }

  async function codexResponses(req, res) {
    const model = modelFromRoutingHint(req.headers['x-codex-routing-hint']);
    const role = subagentRole(req.headers);
    const t0 = Date.now();
    if (!isDeepSeekModel(model)) {
      if (!requireClientAuth(req, res)) return;
      const up = await passThrough(req, res, openai, `${CODEX_PREFIX}/responses`);
      stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    const key = await requireKey(res); if (!key) return;
    let body;
    try { body = JSON.parse(decodeBody(await readBody(req), req.headers['content-encoding']).toString('utf8')); }
    catch (e) { sendJson(res, 400, { error: { type: 'invalid_request_error', message: `switchboard: cannot read request body: ${e.message}` } }); return; }
    const rewritten = rewriteResponsesRequest({ ...body, model: baseModelId(model) });
    const url = new URL('/responses', deepseek);
    const payload = Buffer.from(JSON.stringify(rewritten));
    const headers = { ...dropHeaders(upstreamHeaders(req.headers, url)), authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': payload.length, accept: 'text/event-stream', 'accept-encoding': 'identity' };
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers, body: payload }); }
    catch (e) { sendJson(res, 502, { error: { type: 'server_error', message: `switchboard: deepseek unreachable: ${e.message}` } }); stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'deepseek', error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      const text = (await readResponse(up)).toString('utf8');
      const mapped = mapDeepSeekError(up.statusCode, text);
      sendJson(res, mapped.status, mapped.body);
      stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'deepseek', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    let usage = null;
    const relay = createSseRelay({ onEvent: (j) => { if (j?.type === 'response.completed') usage = usageFromResponsesEvent(j); } });
    relayResponse(up, res, { transform: relay });
    up.on('end', () => stats.record({ client: 'codex', route: 'responses', model: rewritten.model, role, upstream: 'deepseek', status: up.statusCode, ms: Date.now() - t0, usage }));
  }

  // ---------- Claude Code ----------
  async function claudeMessages(req, res, path) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8')); }
    catch (e) { sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `switchboard: cannot read request body: ${e.message}` } }); return; }
    const model = body.model;
    const role = req.headers['x-claude-code-agent-id'] ? 'subagent' : 'main';
    const t0 = Date.now();
    if (!isDeepSeekModel(model)) {
      if (!requireClientAuth(req, res)) return;
      const url = new URL(path, anthropic);
      let payload = raw, extra = {};
      if (hasUnsignedThinking(body)) { payload = Buffer.from(JSON.stringify(stripUnsignedThinking(body))); extra = { 'content-encoding': null, 'content-length': payload.length }; log('stripped unsigned thinking blocks for anthropic'); }
      const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url, extra), body: payload });
      relayResponse(up, res);
      stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'anthropic', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    const key = await requireKey(res); if (!key) return;
    const { body: rewritten, notes } = rewriteMessagesRequest(body);
    if (notes.length) log(`messages adapter: ${notes.join('; ')}`);
    const url = new URL('/anthropic/v1/messages', deepseek);
    const payload = Buffer.from(JSON.stringify(rewritten));
    const headers = { ...dropHeaders(upstreamHeaders(req.headers, url)), 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': payload.length, accept: 'text/event-stream', 'accept-encoding': 'identity' };
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers, body: payload }); }
    catch (e) { sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `switchboard: deepseek unreachable: ${e.message}` } }); stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'deepseek', error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      if (up.statusCode === 401 || up.statusCode === 403) { const text = (await readResponse(up)).toString('utf8'); sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `agents-switchboard: DeepSeek rejected the API key (${up.statusCode}): ${text.slice(0, 300)}` } }); }
      else relayResponse(up, res);
      stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'deepseek', status: up.statusCode, ms: Date.now() - t0 }); return;
    }
    let usage = null;
    const relay = createSseRelay({ mapData: normalizeSseData, pingMs: 20_000, onEvent: (j) => { const u = usageFromMessagesEvent(j); if (u) usage = { ...(usage ?? {}), ...u }; } });
    relayResponse(up, res, { transform: relay });
    up.on('end', () => stats.record({ client: 'claude', route: 'messages', model: rewritten.model, role, upstream: 'deepseek', status: up.statusCode, ms: Date.now() - t0, usage }));
  }

  async function claudeCountTokens(req, res, path) {
    const raw = await readBody(req);
    let model = null; try { model = JSON.parse(raw.toString('utf8')).model; } catch {}
    if (isDeepSeekModel(model)) { sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'token counting is not available for DeepSeek models' } }); return; }
    if (!requireClientAuth(req, res)) return;
    const url = new URL(path, anthropic);
    const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url), body: raw });
    relayResponse(up, res);
  }

  function subagentRole(headers) {
    return headers['x-openai-subagent'] ? String(headers['x-openai-subagent']) : null;
  }

  // ---------- dispatch ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith(CODEX_PREFIX + '/')) {
        const sub = p.slice(CODEX_PREFIX.length);
        if (sub === '/models' && req.method === 'GET') return await codexModels(req, res, req.url);
        if (sub === '/responses' && req.method === 'POST') return await codexResponses(req, res);
        if (!requireClientAuth(req, res)) return;
        const up = await passThrough(req, res, openai, req.url);
        stats.record({ client: 'codex', route: sub, upstream: 'openai', status: up.statusCode });
        return;
      }
      if (p.startsWith(CLAUDE_PREFIX + '/')) {
        const sub = p.slice(CLAUDE_PREFIX.length);
        const upstreamPath = req.url.slice(CLAUDE_PREFIX.length);
        if (sub === '/api/hello') { res.writeHead(200); res.end(); return; }
        if (sub === '/v1/messages' && req.method === 'POST') return await claudeMessages(req, res, upstreamPath);
        if (sub === '/v1/messages/count_tokens' && req.method === 'POST') return await claudeCountTokens(req, res, upstreamPath);
        if (!requireClientAuth(req, res)) return;
        const up = await passThrough(req, res, anthropic, upstreamPath);
        stats.record({ client: 'claude', route: sub, upstream: 'anthropic', status: up.statusCode });
        return;
      }
      if (p === '/switchboard/status') return sendJson(res, 200, statusJson());
      if (p === '/switchboard/' || p === '/switchboard') { const html = renderStatusPage(statusJson()); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
      if (p === '/switchboard/health') return sendJson(res, 200, { ok: true });
      if (p === '/switchboard/failover/reset' && req.method === 'POST') return sendJson(res, 200, { ok: true, note: 'failover state machine ships in phase 2' });
      sendJson(res, 404, { error: { message: 'agents-switchboard: unknown route' } });
    } catch (e) {
      log(`error ${req.method} ${p}: ${e.message}`);
      if (!res.headersSent) sendJson(res, 502, { error: { type: 'server_error', message: `switchboard: ${e.message}` } }); else res.destroy();
    }
  }

  function statusJson() {
    return { name: 'agents-switchboard', listen: config.listen, routes: { codex: `${CODEX_PREFIX}/*`, claude: `${CLAUDE_PREFIX}/*` }, deepseekModels: entries.map((e) => e.slug), failover: { enabled: !!config.failover?.enabled, model: config.failover?.model ?? null, active: null }, ...stats.snapshot() };
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('upgrade', (req, socket) => {
    log(`declined websocket upgrade ${req.url} (${req.headers['x-codex-routing-hint'] ?? 'no hint'})`);
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
  server.stats = stats;
  server.statusJson = statusJson;
  return server;
}
