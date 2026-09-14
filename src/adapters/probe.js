// Minimal streamed probes that prove a provider key works on each dialect the router uses.

/**
 * @param {import('../providers.js').Provider} provider
 * @param {string} key
 * @param {{model?: string, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{responses: {ok: boolean, error?: string}, messages: {ok: boolean, error?: string}}>}
 */
export async function probeProvider(provider, key, { model, fetchImpl = fetch } = {}) {
  const probeModel = model ?? provider.models[0] ?? (provider.name === 'deepseek' ? 'deepseek-flash' : 'deepseek/deepseek-v4.1-flash');
  const one = async (dialect, path, body) => {
    try {
      const r = await fetchImpl(new URL(path, provider.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json', ...provider.authHeaders(dialect, key) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (r.ok) { await r.body?.cancel?.(); return { ok: true }; }
      return { ok: false, error: `${r.status} ${(await r.text()).slice(0, 160)}` };
    } catch (e) { return { ok: false, error: e.message }; }
  };
  const [responses, messages] = await Promise.all([
    one('responses', provider.responsesPath, { model: probeModel, input: 'ping', max_output_tokens: 8, stream: true }),
    one('messages', provider.messagesPath, { model: probeModel, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], stream: true }),
  ]);
  return { responses, messages };
}

/** @deprecated kept for older callers: probes DeepSeek directly. */
export async function probeDeepSeek(key, baseUrl = 'https://api.deepseek.com', opts = {}) {
  const { buildProviders } = await import('../providers.js');
  const [provider] = buildProviders({ upstream: { deepseek: { base_url: baseUrl, models: ['deepseek-flash'] } } }, async () => key);
  return probeProvider(provider, key, opts);
}
