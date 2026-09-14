// Claude Code traffic: /anthropic/*  (SPEC §4, §5.2, §6.2)
import { resolveProvider } from '../providers.js';
import { rewriteMessagesRequest, hasUnsignedThinking, stripUnsignedThinking, normalizeSseData, usageFromMessagesEvent, DEEPSEEK_MESSAGES, OPENROUTER_MESSAGES } from '../adapters/messages.js';
import { readBody, decodeBody, sendJson, upstreamHeaders, upstreamRequest, relayResponse, passThrough, readResponse } from '../proxy.js';
import { createSseRelay } from '../sse.js';
import { providerHeaders, requireClientAuth, requireProviderKey, conversationId } from './shared.js';
import { detectExhaustion, plan, transient429Headers } from '../failover.js';

/** Claude Code aborts a stream silent for 300 s; a provider can think longer than that without a byte. */
const PING_INTERVAL_MS = 20_000;

const anthropicError = (type, message) => ({ type: 'error', error: { type, message } });

/** Every real Anthropic-shaped response is SSE or JSON; anything else on a 2xx (an HTML error/marketing page) is the wrong endpoint. */
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
    const url = provider.endpoint('messages');
    const payload = Buffer.from(JSON.stringify(rewritten));
    const entry = { client: 'claude', route: 'messages', model: rewritten.model, role, upstream: provider.name, ...(via ? { via } : {}) };
    const inflight = stats.begin(entry);
    let up;
    try { up = await upstreamRequest(url, { method: 'POST', headers: providerHeaders(req.headers, url, { ...provider.authHeaders('messages', key), ...extra.headers }, payload.length), body: payload, signal: req.proxySignal }); }
    catch (e) { sendJson(res, 502, anthropicError('api_error', `agents-switchboard: ${provider.name} unreachable: ${e.message}`)); inflight.end({ error: e.message }); return; }
    if (up.statusCode < 200 || up.statusCode >= 300) {
      // Auth and billing failures must not reach the client as 401/402/403 (token refresh); everything else is the provider's own Anthropic-shaped error.
      if ([401, 402, 403].includes(up.statusCode)) {
        const text = (await readResponse(up)).toString('utf8');
        sendJson(res, 400, anthropicError('invalid_request_error', `agents-switchboard: ${provider.name} rejected the request (${up.statusCode}): ${text.slice(0, 300)}`));
      } else relayResponse(up, res);
      inflight.end({ status: up.statusCode, ms: Date.now() - t0 });
      return;
    }
    const contentType = up.headers['content-type'];
    if (!isApiContentType(contentType)) {
      await readDiagnosticSample(up);
      const ctLabel = contentType || 'no content-type';
      sendJson(res, 502, anthropicError('api_error', `agents-switchboard: ${provider.name} returned ${ctLabel} instead of an API response`));
      inflight.end({ status: 502, error: 'unexpected upstream content-type', ms: Date.now() - t0 });
      log(`unexpected upstream content-type (claude/${provider.name}): ${ctLabel}`);
      return;
    }
    let usage = null;
    let done = false; // the watchdog and up's own 'end' both end the request; only the first counts
    const finish = (result) => { if (done) return; done = true; inflight.end(result); };
    const relay = createSseRelay({
      mapData: normalizeSseData, pingMs: PING_INTERVAL_MS,
      onEvent: (j) => { const u = usageFromMessagesEvent(j); if (u) usage = { ...(usage ?? {}), ...u }; },
      abort: () => up.destroy(),
      stallPayload: (ms) => `event: error\ndata: ${JSON.stringify(anthropicError('overloaded_error', `agents-switchboard: upstream stall (no content for ${Math.round(ms / 1000)} s)`))}\n\n`,
      onStall: ({ stalledAfterMs }) => {
        log(`upstream stall (claude/${provider.name}): no content for ${Math.round(stalledAfterMs / 1000)} s`);
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

  /** POST /v1/messages: unclaimed models pass through (original bytes unless unsigned thinking must go); provider models are adapted. */
  async function messages(req, res, upstreamPath) {
    if (!requireClientAuth(req, res)) return;
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8')); }
    catch (e) { sendJson(res, 400, anthropicError('invalid_request_error', `agents-switchboard: cannot read request body: ${e.message}`)); return; }
    const model = body.model;
    const role = req.headers['x-claude-code-agent-id'] ? 'subagent' : 'main';
    const t0 = Date.now();
    const provider = resolveProvider(providers, model);
    if (provider) return toProvider(req, res, provider, body, role, t0);

    const { armed, fallback, fallbackModel: target } = plan(ctx, 'claude', model);
    if (armed) {
      log(`failover active for claude: ${model} → ${target}`);
      return toProvider(req, res, fallback, { ...body, model: target }, role, t0, 'failover');
    }
    const url = new URL(upstreamPath, anthropic);
    let payload = raw, overrides = {};
    if (hasUnsignedThinking(body)) {
      payload = Buffer.from(JSON.stringify(stripUnsignedThinking(body)));
      overrides = { 'content-encoding': null, 'content-length': payload.length };
      log('stripped unsigned thinking blocks before anthropic');
    }
    const up = await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url, overrides), body: payload, signal: req.proxySignal });
    if (fallback && up.statusCode === 429) {
      const text = (await readResponse(up)).toString('utf8');
      const verdict = detectExhaustion('claude', 429, up.headers, text);
      stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'anthropic', status: 429, ms: Date.now() - t0 });
      if (!verdict.triggered) {
        const headers = { 'content-type': up.headers['content-type'] ?? 'application/json', ...transient429Headers('claude', up.headers) };
        res.writeHead(429, headers); res.end(text); return;
      }
      failover.state.activate('claude', verdict.resetAt, verdict.reason);
      log(`claude usage limit reached (${verdict.reason}); failing over to ${target} until ${verdict.resetAt.toISOString()}`);
      return toProvider(req, res, fallback, { ...body, model: target }, role, t0, 'failover');
    }
    relayResponse(up, res);
    stats.record({ client: 'claude', route: 'messages', model, role, upstream: 'anthropic', status: up.statusCode, ms: Date.now() - t0 });
  }

  /** count_tokens: providers have no such endpoint; a 404 makes Claude Code fall back to its own estimate. */
  async function countTokens(req, res, upstreamPath) {
    const raw = await readBody(req);
    let model = null;
    try { model = JSON.parse(decodeBody(raw, req.headers['content-encoding']).toString('utf8')).model; }
    catch (e) { sendJson(res, 400, anthropicError('invalid_request_error', `agents-switchboard: cannot read request body: ${e.message}`)); return; }
    if (resolveProvider(providers, model)) { sendJson(res, 404, anthropicError('not_found_error', 'token counting is not available for this model')); return; }
    if (!requireClientAuth(req, res)) return;
    const url = new URL(upstreamPath, anthropic);
    relayResponse(await upstreamRequest(url, { method: 'POST', headers: upstreamHeaders(req.headers, url), body: raw, signal: req.proxySignal }), res);
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
