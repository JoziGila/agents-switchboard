// Claude Code traffic: /anthropic/*  (SPEC §4, §5.2, §6.2)
import { isDeepSeekModel } from '../catalog.js';
import { rewriteMessagesRequest, hasUnsignedThinking, stripUnsignedThinking, normalizeSseData, usageFromMessagesEvent } from '../adapters/messages.js';
import { readBody, decodeBody, sendJson, upstreamHeaders, upstreamRequest, relayResponse, passThrough, readResponse } from '../proxy.js';
import { createSseRelay } from '../sse.js';
import { headersForDeepSeek, requireClientAuth, requireDeepSeekKey } from './shared.js';

/** Claude Code aborts a stream silent for 300 s; DeepSeek can think longer than that without a byte. */
const PING_INTERVAL_MS = 20_000;

/** @param {import('../server.js').RouteContext} ctx */
export function claudeRoutes(ctx) {
  const { anthropic, deepseek, stats, deepseekKey, log } = ctx;

  async function parseJson(req, res, raw, envelope) {
    try { return JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8')); }
    catch (e) { sendJson(res, 400, envelope(`switchboard: cannot read request body: ${e.message}`)); return null; }
  }
  const anthropicError = (type, message) => ({ type: 'error', error: { type, message } });

  /** POST /v1/messages: claude-* passes through (original bytes unless unsigned thinking must go); deepseek-* is adapted. */
  async function messages(req, res, upstreamPath) {
    const raw = await readBody(req);
    const body = await parseJson(req, res, raw, (m) => anthropicError('invalid_request_error', m));
    if (!body) return;
    const model = body.model;
    const role = req.headers['x-claude-code-agent-id'] ? 'subagent' : 'main';
    const t0 = Date.now();

    if (!isDeepSeekModel(model)) {
      if (!requireClientAuth(req, res)) return;
      const url = new URL(upstreamPath, anthropic);
      let payload = raw, overrides = {};
      if (hasUnsignedThinking(body)) {
        payload = Buffer.from(JSON.stringify(stripUnsignedThinking(body)));
        overrides = { 'content-encoding': null, 'content-length': payload.length };
        log('stripped unsigned thinking blocks before anthropic');
      }
      const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url, overrides), body: payload });
      relayResponse(up, res);
      stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'anthropic', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }

    const key = await requireDeepSeekKey(deepseekKey, res);
    if (!key) return;
    const { body: rewritten, notes } = rewriteMessagesRequest(body);
    if (notes.length) log(`messages adapter: ${notes.join('; ')}`);
    const url = new URL('/anthropic/v1/messages', deepseek);
    const payload = Buffer.from(JSON.stringify(rewritten));
    const headers = { ...headersForDeepSeek(upstreamHeaders(req.headers, url)), 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': payload.length, accept: 'text/event-stream', 'accept-encoding': 'identity' };
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers, body: payload }); }
    catch (e) { sendJson(res, 502, anthropicError('api_error', `switchboard: deepseek unreachable: ${e.message}`)); stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'deepseek', error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      if (up.statusCode === 401 || up.statusCode === 403) {
        const text = (await readResponse(up)).toString('utf8');
        sendJson(res, 400, anthropicError('invalid_request_error', `agents-switchboard: DeepSeek rejected the API key (${up.statusCode}): ${text.slice(0, 300)}`));
      } else relayResponse(up, res);
      stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'deepseek', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    let usage = null;
    const relay = createSseRelay({ mapData: normalizeSseData, pingMs: PING_INTERVAL_MS, onEvent: (j) => { const u = usageFromMessagesEvent(j); if (u) usage = { ...(usage ?? {}), ...u }; } });
    relayResponse(up, res, { transform: relay });
    up.on('end', () => stats.record({ client: 'claude', route: 'messages', model: rewritten.model, role, upstream: 'deepseek', status: up.statusCode, ms: Date.now() - t0, usage }));
  }

  /** count_tokens: DeepSeek has no such endpoint; a 404 makes Claude Code fall back to its own estimate. */
  async function countTokens(req, res, upstreamPath) {
    const raw = await readBody(req);
    let model = null;
    try { model = JSON.parse(raw.toString('utf8')).model; } catch {}
    if (isDeepSeekModel(model)) { sendJson(res, 404, anthropicError('not_found_error', 'token counting is not available for DeepSeek models')); return; }
    if (!requireClientAuth(req, res)) return;
    const url = new URL(upstreamPath, anthropic);
    relayResponse(await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url), body: raw }), res);
  }

  async function other(req, res, sub, upstreamPath) {
    if (!requireClientAuth(req, res)) return;
    const up = await passThrough(req, res, anthropic, upstreamPath);
    stats.record({ client: 'claude', route: sub, upstream: 'anthropic', status: up.statusCode });
  }

  return async function handle(req, res, sub, upstreamPath) {
    if (sub === '/api/hello') { res.writeHead(200); res.end(); return; }
    if (sub === '/v1/messages' && req.method === 'POST') return messages(req, res, upstreamPath);
    if (sub === '/v1/messages/count_tokens' && req.method === 'POST') return countTokens(req, res, upstreamPath);
    return other(req, res, sub, upstreamPath);
  };
}
