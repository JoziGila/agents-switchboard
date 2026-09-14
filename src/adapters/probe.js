// Minimal streamed probes that prove a provider key works on each dialect the router uses.
// `r.ok` alone is not proof: DeepSeek's API has been observed answering 200 and then streaming nothing
// but `: keep-alive` comment lines forever. A probe must read the body until it sees a real content
// event, or it reports the same stall doctor is meant to catch.

/** First event that means "this stream is actually producing", per dialect. */
function isResponsesContent(line) {
  if (line.startsWith('event:')) return line.slice(6).trim().length > 0;
  if (line.startsWith('data:')) { try { const t = JSON.parse(line.slice(5).trim())?.type; return t === 'response.created' || t === 'response.output_text.delta'; } catch { return false; } }
  return false; // blank lines and `:`-comments (keep-alives) are not content
}
function isMessagesContent(line) {
  if (line.startsWith('event:')) return line.slice(6).trim() === 'message_start';
  if (line.startsWith('data:')) { try { return JSON.parse(line.slice(5).trim())?.type === 'message_start'; } catch { return false; } }
  return false;
}

/** Every real API response is SSE or JSON; anything else on a 2xx (an HTML error/marketing page) is the wrong endpoint. */
function isApiContentType(contentType) {
  const v = String(contentType ?? '').toLowerCase();
  return v.startsWith('text/event-stream') || v.startsWith('application/json');
}

/** Read a fetch body stream until `isContent(line)` is true or `capMs` elapses; always cancels the reader. */
async function firstContentWithin(body, isContent, capMs) {
  if (!body || typeof body.getReader !== 'function') return false;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + Math.max(0, capMs);
  let rest = '';
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const outcome = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r('timeout'), remaining))]);
      if (outcome === 'timeout') return false;
      const { value, done } = outcome;
      if (done) return false;
      rest += decoder.decode(value, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop();
      if (lines.some((l) => isContent(l))) return true;
    }
  } finally {
    try { await reader.cancel(); } catch { /* body already closed/errored */ }
  }
}

/**
 * @param {import('../providers.js').Provider} provider
 * @param {string} key
 * @param {{model?: string, fetchImpl?: typeof fetch, capMs?: number}} [opts]  `capMs` (default 20 s) bounds
 *   headers *and* first-content together, so a slow-but-honest provider and a header-only stall are judged
 *   by the same clock; tests lower it instead of waiting out the real default.
 * @returns {Promise<{responses: {ok: boolean, error?: string}, messages: {ok: boolean, error?: string}}>}
 */
export async function probeProvider(provider, key, { model, fetchImpl = fetch, capMs = 20_000 } = {}) {
  const probeModel = model ?? provider.models[0] ?? (provider.name === 'deepseek' ? 'deepseek-flash' : 'deepseek/deepseek-v4.1-flash');
  const one = async (dialect, body, isContent) => {
    const t0 = Date.now();
    try {
      const r = await fetchImpl(provider.endpoint(dialect), { method: 'POST', headers: { 'content-type': 'application/json', ...provider.authHeaders(dialect, key) }, body: JSON.stringify(body), signal: AbortSignal.timeout(capMs) });
      if (!r.ok) return { ok: false, error: `${r.status} ${(await r.text()).slice(0, 160)}` };
      // A 2xx with the wrong content-type (an HTML error/marketing page) is a distinct failure from a genuine
      // stall: fixtures that don't model headers at all (r.headers undefined) keep the old, header-blind behavior.
      const contentType = typeof r.headers?.get === 'function' ? r.headers.get('content-type') : undefined;
      if (contentType !== undefined && !isApiContentType(contentType)) return { ok: false, error: `200 ${contentType || 'no content-type'} instead of an API response (model ${body.model})` };
      const remaining = capMs - (Date.now() - t0);
      const got = await firstContentWithin(r.body, isContent, remaining);
      if (!got) return { ok: false, error: `stalled: 200 but no content within ${Math.round(capMs / 1000)} s (model ${body.model})` };
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  };
  const [responses, messages] = await Promise.all([
    one('responses', { model: probeModel, input: 'ping', max_output_tokens: 8, stream: true }, isResponsesContent),
    one('messages', { model: probeModel, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], stream: true }, isMessagesContent),
  ]);
  return { responses, messages };
}
