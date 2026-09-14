// Codex traffic: /backend-api/codex/*  (SPEC §4, §5.1, §6.1, §7)
import { mergeModels, rewriteEtag } from '../catalog.js';
import { resolveProvider, stripSuffix } from '../providers.js';
import { rewriteResponsesRequest, mapUpstreamError, usageFromResponsesEvent, reasoningIdsFromEvent, normalizeResponsesSseData, DEEPSEEK_RESPONSES, OPENROUTER_RESPONSES } from '../adapters/responses.js';
import { readBody, decodeBody, sendJson, upstreamHeaders, upstreamRequest, relayResponse, passThrough, readResponse } from '../proxy.js';
import { detectExhaustion, liftResponsesLite } from '../failover.js';
import { createSseRelay } from '../sse.js';
import { CODEX_PREFIX, providerHeaders, modelFromRoutingHint, requireClientAuth, requireProviderKey } from './shared.js';

/** @param {import('../server.js').RouteContext} ctx */
export function codexRoutes(ctx) {
  const { openai, providers, catalog, stats, provenance, failover, log } = ctx;

  function profileFor(provider) {
    if (provider.name === 'openrouter') return { ...OPENROUTER_RESPONSES, keepEncryptedContent: (item) => provenance.has('openrouter', item.id) };
    return DEEPSEEK_RESPONSES;
  }

  /** GET /models: proxy upstream, append the provider entries, fork the ETag. */
  async function models(req, res) {
    const url = new URL(req.url, openai);
    const up = await upstreamRequest(url, { method: 'GET', headers: upstreamHeaders(req.headers, url, { 'accept-encoding': 'identity' }) });
    if (up.statusCode !== 200) { relayResponse(up, res); stats.record({ client: 'codex', route: 'models', upstream: 'openai', status: up.statusCode }); return; }
    let payload;
    try { payload = JSON.parse((await readResponse(up)).toString('utf8')); }
    catch (e) { sendJson(res, 502, { error: { message: `switchboard: bad models payload: ${e.message}` } }); return; }
    const headers = { etag: rewriteEtag(up.headers.etag, catalog.hash), ...(up.headers['cache-control'] ? { 'cache-control': up.headers['cache-control'] } : {}) };
    sendJson(res, 200, mergeModels(payload, catalog.entries), headers);
    stats.record({ client: 'codex', route: 'models', upstream: 'openai', status: 200, injected: catalog.slugs });
  }

  /** Send an already-parsed body to a provider and relay its stream. */
  async function toProvider(req, res, provider, body, model, role, t0, via) {
    const key = await requireProviderKey(provider, res);
    if (!key) return;
    const rewritten = rewriteResponsesRequest({ ...liftResponsesLite(body), model: stripSuffix(model) }, profileFor(provider));
    const url = new URL(provider.responsesPath, provider.baseUrl);
    const payload = Buffer.from(JSON.stringify(rewritten));
    const entry = { client: 'codex', route: 'responses', model: rewritten.model, role, upstream: provider.name, ...(via ? { via } : {}) };
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers: providerHeaders(req.headers, url, provider.authHeaders('responses', key), payload.length), body: payload }); }
    catch (e) { sendJson(res, 502, { error: { type: 'server_error', message: `switchboard: ${provider.name} unreachable: ${e.message}` } }); stats.record({ ...entry, error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      const mapped = mapUpstreamError(up.statusCode, (await readResponse(up)).toString('utf8'), provider.name);
      sendJson(res, mapped.status, mapped.body);
      stats.record({ ...entry, status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    let usage = null;
    const relay = createSseRelay({ mapData: normalizeResponsesSseData, onEvent: (j) => {
      for (const id of reasoningIdsFromEvent(j)) provenance.remember(provider.name, id);
      if (j?.type === 'response.completed') usage = usageFromResponsesEvent(j);
    } });
    relayResponse(up, res, { transform: relay });
    up.on('end', () => stats.record({ ...entry, status: up.statusCode, ms: Date.now() - t0, usage, requestId: up.headers['x-request-id'] ?? up.headers['x-deepseek-request-id'] ?? up.headers['x-generation-id'] }));
  }

  const parseBody = (req, raw) => JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8'));

  /** POST /responses: route by the routing-hint header; pass-through bodies are never decompressed unless failover needs them. */
  async function responses(req, res) {
    const model = modelFromRoutingHint(req.headers['x-codex-routing-hint']);
    const role = req.headers['x-openai-subagent'] ? String(req.headers['x-openai-subagent']) : null;
    const t0 = Date.now();
    const provider = resolveProvider(providers, model);
    if (provider) {
      let body;
      try { body = parseBody(req, await readBody(req)); }
      catch (e) { sendJson(res, 400, { error: { type: 'invalid_request_error', message: `switchboard: cannot read request body: ${e.message}` } }); return; }
      return toProvider(req, res, provider, body, model, role, t0);
    }
    if (!requireClientAuth(req, res)) return;
    const fallback = failover.enabled ? resolveProvider(providers, failover.model) : null;
    if (!fallback) {
      const up = await passThrough(req, res, openai, `${CODEX_PREFIX}/responses`);
      stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    // Failover is on: buffer the bytes so the same request can be re-sent to the fallback provider.
    const raw = await readBody(req);
    if (failover.state.isActive('codex')) {
      log(`failover active for codex: ${model} → ${failover.model}`);
      return toProvider(req, res, fallback, parseBody(req, raw), failover.model, role, t0, 'failover');
    }
    const url = new URL(`${CODEX_PREFIX}/responses`, openai);
    const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url), body: raw });
    if (up.statusCode === 429) {
      const text = (await readResponse(up)).toString('utf8');
      const verdict = detectExhaustion('codex', up.statusCode, up.headers, text);
      stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: 429, ms: Date.now() - t0 });
      if (!verdict.triggered) { sendJson(res, 429, safeJson(text)); return; }
      failover.state.activate('codex', verdict.resetAt, verdict.reason);
      log(`codex usage limit reached (${verdict.reason}); failing over to ${failover.model} until ${verdict.resetAt.toISOString()}`);
      return toProvider(req, res, fallback, parseBody(req, raw), failover.model, role, t0, 'failover');
    }
    relayResponse(up, res);
    stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: up.statusCode, ms: Date.now() - t0 });
  }

  const safeJson = (text) => { try { return JSON.parse(text); } catch { return { error: { type: 'rate_limit_exceeded', message: text.slice(0, 300) } }; } };

  /** Everything else under the prefix (usage, compaction, realtime, memories) goes to OpenAI unchanged. */
  async function other(req, res, sub) {
    if (!requireClientAuth(req, res)) return;
    const up = await passThrough(req, res, openai, req.url);
    stats.record({ client: 'codex', route: sub, upstream: 'openai', status: up.statusCode });
  }

  return async function handle(req, res, sub) {
    if (sub === '/models' && req.method === 'GET') return models(req, res);
    if (sub === '/responses' && req.method === 'POST') return responses(req, res);
    return other(req, res, sub);
  };
}
