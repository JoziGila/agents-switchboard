// Claude Code traffic: /anthropic/*  (SPEC §4, §5.2, §6.2)
import { resolveProvider } from '../providers.js';
import { rewriteMessagesRequest, hasUnsignedThinking, stripUnsignedThinking, normalizeSseData, usageFromMessagesEvent, DEEPSEEK_MESSAGES, OPENROUTER_MESSAGES } from '../adapters/messages.js';
import { readBody, decodeBody, sendJson, upstreamHeaders, upstreamRequest, relayResponse, passThrough, readResponse } from '../proxy.js';
import { createSseRelay } from '../sse.js';
import { providerHeaders, requireClientAuth, requireProviderKey, conversationId } from './shared.js';
import { detectExhaustion } from '../failover.js';

/** Claude Code aborts a stream silent for 300 s; a provider can think longer than that without a byte. */
const PING_INTERVAL_MS = 20_000;

const anthropicError = (type, message) => ({ type: 'error', error: { type, message } });

/** @param {import('../server.js').RouteContext} ctx */
export function claudeRoutes(ctx) {
  const { anthropic, providers, stats, log, failover } = ctx;

  const profileFor = (provider) => (provider.name === 'openrouter' ? OPENROUTER_MESSAGES : DEEPSEEK_MESSAGES);

  /** Send a parsed body to a provider and relay its stream. */
  async function toProvider(req, res, provider, body, role, t0, via) {
    const key = await requireProviderKey(provider, res);
    if (!key) return;
    const extra = provider.requestOptions('messages', conversationId(req.headers), req.headers);
    const { body: adapted, notes } = rewriteMessagesRequest(body, profileFor(provider));
    const rewritten = { ...adapted, ...extra.body };
    if (notes.length) log(`messages adapter (${provider.name}): ${notes.join('; ')}`);
    const url = new URL(provider.messagesPath, provider.baseUrl);
    const payload = Buffer.from(JSON.stringify(rewritten));
    const entry = { client: 'claude', route: 'messages', model: rewritten.model, role, upstream: provider.name, ...(via ? { via } : {}) };
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers: providerHeaders(req.headers, url, { ...provider.authHeaders('messages', key), ...extra.headers }, payload.length), body: payload }); }
    catch (e) { sendJson(res, 502, anthropicError('api_error', `switchboard: ${provider.name} unreachable: ${e.message}`)); stats.record({ ...entry, error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      // Auth and billing failures must not reach the client as 401/402/403 (token refresh); everything else is the provider's own Anthropic-shaped error.
      if ([401, 402, 403].includes(up.statusCode)) {
        const text = (await readResponse(up)).toString('utf8');
        sendJson(res, 400, anthropicError('invalid_request_error', `agents-switchboard: ${provider.name} rejected the request (${up.statusCode}): ${text.slice(0, 300)}`));
      } else relayResponse(up, res);
      stats.record({ ...entry, status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    let usage = null;
    const relay = createSseRelay({ mapData: normalizeSseData, pingMs: PING_INTERVAL_MS, onEvent: (j) => { const u = usageFromMessagesEvent(j); if (u) usage = { ...(usage ?? {}), ...u }; } });
    relayResponse(up, res, { transform: relay });
    up.on('end', () => stats.record({ ...entry, status: up.statusCode, ms: Date.now() - t0, usage, requestId: up.headers['x-request-id'] ?? up.headers['x-deepseek-request-id'] ?? up.headers['x-generation-id'] }));
  }

  /** POST /v1/messages: unclaimed models pass through (original bytes unless unsigned thinking must go); provider models are adapted. */
  async function messages(req, res, upstreamPath) {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8')); }
    catch (e) { sendJson(res, 400, anthropicError('invalid_request_error', `switchboard: cannot read request body: ${e.message}`)); return; }
    const model = body.model;
    const role = req.headers['x-claude-code-agent-id'] ? 'subagent' : 'main';
    const t0 = Date.now();
    // Every route needs the client's own credential: a provider key must not be spendable by any local process.
    if (!requireClientAuth(req, res)) return;
    const provider = resolveProvider(providers, model);
    if (provider) return toProvider(req, res, provider, body, role, t0);

    const fallback = failover.enabled ? resolveProvider(providers, failover.model) : null;
    if (fallback && failover.state.isActive('claude')) {
      log(`failover active for claude: ${model} → ${failover.model}`);
      return toProvider(req, res, fallback, { ...body, model: failover.model }, role, t0, 'failover');
    }
    const url = new URL(upstreamPath, anthropic);
    let payload = raw, overrides = {};
    if (hasUnsignedThinking(body)) {
      payload = Buffer.from(JSON.stringify(stripUnsignedThinking(body)));
      overrides = { 'content-encoding': null, 'content-length': payload.length };
      log('stripped unsigned thinking blocks before anthropic');
    }
    const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url, overrides), body: payload });
    if (fallback && up.statusCode === 429) {
      const text = (await readResponse(up)).toString('utf8');
      const verdict = detectExhaustion('claude', 429, up.headers, text);
      stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'anthropic', status: 429, ms: Date.now() - t0 });
      if (!verdict.triggered) { res.writeHead(429, { 'content-type': 'application/json', ...(up.headers['retry-after'] ? { 'retry-after': up.headers['retry-after'] } : {}) }); res.end(text); return; }
      failover.state.activate('claude', verdict.resetAt, verdict.reason);
      log(`claude usage limit reached (${verdict.reason}); failing over to ${failover.model} until ${verdict.resetAt.toISOString()}`);
      return toProvider(req, res, fallback, { ...body, model: failover.model }, role, t0, 'failover');
    }
    relayResponse(up, res);
    stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'anthropic', status: up.statusCode, ms: Date.now() - t0 });
  }

  /** count_tokens: providers have no such endpoint; a 404 makes Claude Code fall back to its own estimate. */
  async function countTokens(req, res, upstreamPath) {
    const raw = await readBody(req);
    let model = null;
    try { model = JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8')).model; }
    catch (e) { sendJson(res, 400, anthropicError('invalid_request_error', `switchboard: cannot read request body: ${e.message}`)); return; }
    if (resolveProvider(providers, model)) { sendJson(res, 404, anthropicError('not_found_error', 'token counting is not available for this model')); return; }
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
