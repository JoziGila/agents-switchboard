// Anthropic Messages adapter for DeepSeek (Claude Code traffic). Pure functions; see SPEC §6.2.
import { baseModelId } from '../catalog.js';

const UNSUPPORTED_BLOCKS = new Set(['document', 'search_result', 'redacted_thinking']);

function cleanMessage(m, notes) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if (out.role === 'system') { out.role = 'user'; notes.push('system-role→user'); }
  if (Array.isArray(out.content)) {
    const kept = out.content.filter((b) => !(b && UNSUPPORTED_BLOCKS.has(b.type)));
    if (kept.length !== out.content.length) notes.push(`dropped ${out.content.length - kept.length} unsupported block(s)`);
    if (kept.length === 0) return null;
    out.content = kept;
  }
  return out;
}

/**
 * Rewrite a Claude Code Messages request for DeepSeek's Anthropic-compatible endpoint.
 * @returns {{ body: object, notes: string[] }}
 */
export function rewriteMessagesRequest(body) {
  const notes = [];
  const out = { ...body, model: baseModelId(body.model) };
  if (out.thinking && typeof out.thinking === 'object') {
    const { display: _d, ...t } = out.thinking;
    if (t.type === 'adaptive') { t.type = 'enabled'; notes.push('thinking adaptive→enabled'); }
    out.thinking = t;
  }
  if (Array.isArray(out.messages)) out.messages = out.messages.map((m) => cleanMessage(m, notes)).filter(Boolean);
  if (out.output_config && typeof out.output_config === 'object' && 'format' in out.output_config) {
    const { format: _f, ...oc } = out.output_config;
    notes.push('dropped output_config.format');
    if (Object.keys(oc).length) out.output_config = oc; else delete out.output_config;
  }
  out.stream = true;
  return { body: out, notes };
}

/** True when any assistant message carries a thinking block without a signature (DeepSeek-originated). */
export function hasUnsignedThinking(body) {
  for (const m of body?.messages ?? []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    if (m.content.some((b) => b?.type === 'thinking' && !b.signature)) return true;
  }
  return false;
}

/** Remove unsigned thinking blocks so Anthropic does not reject the conversation. */
export function stripUnsignedThinking(body) {
  const messages = (body.messages ?? []).map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.filter((b) => !(b?.type === 'thinking' && !b.signature));
    return content.length ? { ...m, content } : { ...m, content: [{ type: 'text', text: '' }] };
  });
  return { ...body, messages };
}

/** Fill Anthropic cache fields from DeepSeek's spelling inside a streamed event's `usage`. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  if (usage.cache_read_input_tokens == null && usage.prompt_cache_hit_tokens != null) {
    return { ...usage, cache_read_input_tokens: usage.prompt_cache_hit_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 };
  }
  return usage;
}

/** Apply normalizeUsage to one SSE `data:` JSON payload if it carries usage; returns the (possibly new) string. */
export function normalizeSseData(data) {
  if (!data.includes('"usage"')) return data;
  try {
    const j = JSON.parse(data);
    if (j.usage) j.usage = normalizeUsage(j.usage);
    if (j.message?.usage) j.message.usage = normalizeUsage(j.message.usage);
    return JSON.stringify(j);
  } catch { return data; }
}

/** Token counts from a final `message_delta` / `message_start` payload. */
export function usageFromMessagesEvent(j) {
  const u = j?.usage ?? j?.message?.usage;
  if (!u) return null;
  return { input: u.input_tokens ?? 0, cached: u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? 0, output: u.output_tokens ?? 0 };
}
