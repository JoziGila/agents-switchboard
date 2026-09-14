/** Minimal streamed probes of both DeepSeek dialects. Returns {responses:{ok,error?}, messages:{ok,error?}} */
export async function probeDeepSeek(key, baseUrl = 'https://api.deepseek.com', { fetchImpl = fetch, model = 'deepseek-flash' } = {}) {
  const one = async (path, headers, body) => {
    try {
      const r = await fetchImpl(new URL(path, baseUrl), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (r.ok) { await r.body?.cancel?.(); return { ok: true }; }
      return { ok: false, error: `${r.status} ${(await r.text()).slice(0, 160)}` };
    } catch (e) { return { ok: false, error: e.message }; }
  };
  const [responses, messages] = await Promise.all([
    one('/responses', { authorization: `Bearer ${key}` }, { model, input: 'ping', max_output_tokens: 8, stream: true }),
    one('/anthropic/v1/messages', { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' }, { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], stream: true }),
  ]);
  return { responses, messages };
}
