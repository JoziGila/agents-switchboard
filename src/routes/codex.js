// Codex traffic: /backend-api/codex/*  (SPEC §4, §5.1, §6.1, §7)
import { mergeModels, rewriteEtag } from '../catalog.js';
import { resolveProvider } from '../providers.js';
import { rewriteResponsesRequest, mapUpstreamError, usageFromResponsesEvent, reasoningIdsFromEvent, codexSseMapper, DEEPSEEK_RESPONSES, OPENROUTER_RESPONSES } from '../adapters/responses.js';
import { readBody, decodeBody, sendJson, upstreamHeaders, upstreamRequest, relayResponse, passThrough, readResponse } from '../proxy.js';
import { detectExhaustion, plan, transient429Headers } from '../failover.js';
import { createSseRelay } from '../sse.js';
import { CODEX_PREFIX, providerHeaders, modelFromRoutingHint, requireClientAuth, requireProviderKey, conversationId } from './shared.js';

/** Every real Responses-shaped response is SSE or JSON; anything else on a 2xx (an HTML error/marketing page) is the wrong endpoint. */
function isApiContentType(contentType) {
  const v = String(contentType ?? '').toLowerCase();
  return v.startsWith('text/event-stream') || v.startsWith('application/json');
}

/** Drains at most `capBytes` of a response for internal diagnostics only; never surfaced to the client or logged. */
function readDiagnosticSample(up, capBytes = 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    const finish = () => resolve(Buffer.concat(chunks));
    up.on('data', (chunk) => {
      if (size >= capBytes) return;
      const take = chunk.subarray(0, capBytes - size);
      chunks.push(take);
      size += take.length;
      if (size >= capBytes) { up.destroy(); finish(); }
    });
    up.once('end', finish);
    up.once('error', finish);
    up.once('close', finish);
  });
}

/** @param {import('../server.js').RouteContext} ctx */
export function codexRoutes(ctx) {
  const { openai, providers, catalog, stats, provenance, failover, log } = ctx;

  function profileFor(provider) {
    const ownsReasoning = (item) => provenance.has(provider.name, item.id);
    if (provider.name === 'openrouter') return { ...OPENROUTER_RESPONSES, ownsReasoning, keepEncryptedContent: ownsReasoning };
    return { ...DEEPSEEK_RESPONSES, ownsReasoning };
  }

  /** GET /models: proxy upstream, append the provider entries, fork the ETag. */
  async function models(req, res) {
    if (!requireClientAuth(req, res)) return;
    const url = new URL(req.url, openai);
    const up = await upstreamRequest(url, { method: 'GET', headers: upstreamHeaders(req.headers, url, { 'accept-encoding': 'identity' }), signal: req.proxySignal });
    if (up.statusCode !== 200) { relayResponse(up, res); stats.record({ client: 'codex', route: 'models', upstream: 'openai', status: up.statusCode }); return; }
    let payload;
    try { payload = JSON.parse((await readResponse(up)).toString('utf8')); }
    catch (e) { sendJson(res, 502, { error: { message: `agents-switchboard: bad models payload: ${e.message}` } }); return; }
    const headers = { etag: rewriteEtag(up.headers.etag, catalog.hash), ...(up.headers['cache-control'] ? { 'cache-control': up.headers['cache-control'] } : {}) };
    sendJson(res, 200, mergeModels(payload, catalog.entries), headers);
    stats.record({ client: 'codex', route: 'models', upstream: 'openai', status: 200, injected: catalog.slugs });
  }

  /** Diagnose a 400 by index only: the item's type and role, never its text or the provider's message. */
  function logRejected(provider, text, rewritten) {
    const n = text.match(/input\[(\d+)\]/)?.[1];
    if (n === undefined) return log(`${provider} rejected request (400)`);
    log(`${provider} rejected input[${n}] (type=${rewritten.input?.[n]?.type ?? 'unknown'}, role=${rewritten.input?.[n]?.role ?? '-'})`);
  }

  /** Send an already-parsed body to a provider and relay its stream. */
  async function toProvider(req, res, provider, body, model, role, t0, via) {
    const key = await requireProviderKey(provider, res);
    if (!key) return;
    const extra = provider.requestOptions('responses', conversationId(req.headers), req.headers);
    const { body: adapted, decode } = rewriteResponsesRequest({ ...body, model }, profileFor(provider));
    const rewritten = { ...adapted, ...extra.body };
    const url = provider.endpoint('responses');
    const payload = Buffer.from(JSON.stringify(rewritten));
    const entry = { client: 'codex', route: 'responses', model: rewritten.model, role, upstream: provider.name, ...(via ? { via } : {}) };
    const inflight = stats.begin(entry);
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers: providerHeaders(req.headers, url, { ...provider.authHeaders('responses', key), ...extra.headers }, payload.length), body: payload, signal: req.proxySignal }); }
    catch (e) { sendJson(res, 502, { error: { type: 'server_error', message: `agents-switchboard: ${provider.name} unreachable: ${e.message}` } }); inflight.end({ error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      const text = (await readResponse(up)).toString('utf8');
      if (up.statusCode === 400) logRejected(provider.name, text, rewritten);
      const mapped = mapUpstreamError(up.statusCode, text, provider.name);
      sendJson(res, mapped.status, mapped.body);
      inflight.end({ status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    const contentType = up.headers['content-type'];
    if (!isApiContentType(contentType)) {
      await readDiagnosticSample(up);
      const ctLabel = contentType || 'no content-type';
      sendJson(res, 502, { error: { type: 'server_error', message: `agents-switchboard: ${provider.name} returned ${ctLabel} instead of an API response` } });
      inflight.end({ status: 502, error: 'unexpected upstream content-type', ms: Date.now() - t0 });
      log(`unexpected upstream content-type (codex/${provider.name}): ${ctLabel}`);
      return;
    }
    let usage = null;
    let done = false; // the watchdog and up's own 'end' both end the request; only the first counts
    const finish = (result) => { if (done) return; done = true; inflight.end(result); };
    const relay = createSseRelay({
      mapData: codexSseMapper(decode),
      onEvent: (j) => {
        for (const id of reasoningIdsFromEvent(j)) provenance.remember(provider.name, id);
        if (j?.type === 'response.completed') usage = usageFromResponsesEvent(j);
      },
      abort: () => up.destroy(),
      stallPayload: (ms) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'server_error', message: `agents-switchboard: upstream stall (no content for ${Math.round(ms / 1000)} s)` } })}\n\n`,
      onStall: ({ stalledAfterMs }) => {
        log(`upstream stall (codex/${provider.name}): no content for ${Math.round(stalledAfterMs / 1000)} s`);
        finish({ status: 504, error: 'upstream stall', ms: Date.now() - t0 });
      },
    });
    relayResponse(up, res, {
      transform: relay,
      onAbort: (info) => {
        if (info.type === 'client') finish({ status: up.statusCode, ms: Date.now() - t0, error: res.writableEnded ? undefined : 'client disconnected' });
        else finish({ status: up.statusCode, ms: Date.now() - t0, error: 'upstream reset' });
      },
    });
    up.on('end', () => finish({ status: up.statusCode, ms: Date.now() - t0, usage, requestId: up.headers['x-request-id'] ?? up.headers['x-deepseek-request-id'] ?? up.headers['x-generation-id'] }));
  }

  const parseBody = (req, raw) => JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8'));

  /** POST /responses: route by the routing-hint header; pass-through bodies are never decompressed unless failover needs them. */
  async function responses(req, res) {
    const model = modelFromRoutingHint(req.headers['x-codex-routing-hint']);
    const role = req.headers['x-openai-subagent'] ? String(req.headers['x-openai-subagent']) : null;
    const t0 = Date.now();
    // The capability authorizes local access; the native credential is still required for subscription routes.
    if (!requireClientAuth(req, res)) return;
    const provider = resolveProvider(providers, model);
    const badBody = (e) => sendJson(res, 400, { error: { type: 'invalid_request_error', message: `agents-switchboard: cannot read request body: ${e.message}` } });
    if (provider) {
      let body;
      try { body = parseBody(req, await readBody(req)); } catch (e) { return badBody(e); }
      return toProvider(req, res, provider, body, model, role, t0);
    }
    const { armed, fallback, fallbackModel: target } = plan(ctx, 'codex', model);
    if (!fallback) {
      const up = await passThrough(req, res, openai, `${CODEX_PREFIX}/responses`);
      stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    // Failover is on: buffer the bytes so the same request can be re-sent to the fallback provider.
    const raw = await readBody(req);
    if (armed) {
      log(`failover active for codex: ${model} → ${target}`);
      let body; try { body = parseBody(req, raw); } catch (e) { return badBody(e); }
      return toProvider(req, res, fallback, body, target, role, t0, 'failover');
    }
    const url = new URL(`${CODEX_PREFIX}/responses`, openai);
    const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url), body: raw, signal: req.proxySignal });
    if (up.statusCode === 429) {
      const text = (await readResponse(up)).toString('utf8');
      const verdict = detectExhaustion('codex', up.statusCode, up.headers, text);
      stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: 429, ms: Date.now() - t0 });
      if (!verdict.triggered) {
        // A transient limit goes back untouched, with the headers Codex reads for its retry and its usage meter.
        const headers = { 'content-type': up.headers['content-type'] ?? 'application/json', ...transient429Headers('codex', up.headers) };
        res.writeHead(429, headers); res.end(text); return;
      }
      failover.state.activate('codex', verdict.resetAt, verdict.reason);
      log(`codex usage limit reached (${verdict.reason}); failing over to ${target} until ${verdict.resetAt.toISOString()}`);
      let body; try { body = parseBody(req, raw); } catch (e) { return badBody(e); }
      return toProvider(req, res, fallback, body, target, role, t0, 'failover');
    }
    relayResponse(up, res);
    stats.record({ client: 'codex', route: 'responses', model, role, upstream: 'openai', status: up.statusCode, ms: Date.now() - t0 });
  }


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
