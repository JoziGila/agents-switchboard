// Responses API adapter for DeepSeek (Codex traffic). Pure functions; see SPEC §6.1.

const EFFORT_MAP = { minimal: 'low', none: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' };
const DROP_TOP_LEVEL = ['store', 'prompt_cache_key', 'service_tier', 'safety_identifier', 'text', 'client_metadata', 'previous_response_id', 'user', 'truncation'];

function flattenTools(tools) {
  const out = [];
  for (const t of tools ?? []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'namespace') {
      for (const inner of t.tools ?? []) pushTool(out, inner);
    } else pushTool(out, t);
  }
  return out;
}

function pushTool(out, t) {
  if (t.type === 'function') out.push(t);
  else if (t.type === 'custom' && t.name === 'apply_patch') out.push(t);
  // tool_search, web_search, image_generation, other custom tools: DeepSeek ignores or rejects them.
}

function cleanInputItem(item) {
  if (!item || typeof item !== 'object') return item;
  const { internal_chat_message_metadata_passthrough: _p, ...rest } = item;
  if (rest.type === 'reasoning') {
    const { encrypted_content: _e, ...r } = rest;
    const hasSummary = Array.isArray(r.summary) && r.summary.length > 0;
    const hasContent = Array.isArray(r.content) && r.content.length > 0;
    return hasSummary || hasContent ? r : null;
  }
  return rest;
}

/**
 * Rewrite a Codex Responses request so DeepSeek accepts it, touching nothing the cache depends on.
 * @param {object} body parsed request body
 * @returns {object} new body
 */
export function rewriteResponsesRequest(body) {
  const out = { ...body };
  for (const k of DROP_TOP_LEVEL) delete out[k];
  if (Array.isArray(out.include)) {
    const inc = out.include.filter((x) => x !== 'reasoning.encrypted_content');
    if (inc.length) out.include = inc; else delete out.include;
  }
  if (Array.isArray(out.input)) out.input = out.input.map(cleanInputItem).filter(Boolean);
  if (Array.isArray(out.tools)) out.tools = flattenTools(out.tools);
  if (out.reasoning && typeof out.reasoning === 'object') {
    const { summary: _s, ...r } = out.reasoning;
    if (r.effort) r.effort = EFFORT_MAP[String(r.effort).toLowerCase()] ?? 'high';
    out.reasoning = r;
  }
  out.stream = true;
  return out;
}

/** Map a DeepSeek HTTP error to the OpenAI error envelope Codex understands. */
export function mapDeepSeekError(status, text) {
  let message = text;
  try { const j = JSON.parse(text); message = j?.error?.message ?? j?.message ?? text; } catch {}
  const type = status === 401 || status === 403 ? 'invalid_request_error'
    : status === 429 ? 'rate_limit_exceeded'
    : status >= 500 ? 'server_error'
    : 'invalid_request_error';
  // 401/403 from DeepSeek must not reach Codex as 401: it would trigger a ChatGPT token refresh.
  const outStatus = status === 401 || status === 403 ? 400 : status;
  return { status: outStatus, body: { error: { type, code: type, message: `deepseek: ${message}` } } };
}

/** Pull token counts from a `response.completed` event, DeepSeek or OpenAI spelling. */
export function usageFromResponsesEvent(event) {
  const u = event?.response?.usage;
  if (!u) return null;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  return { input: (u.input_tokens ?? 0), cached, output: u.output_tokens ?? 0 };
}
