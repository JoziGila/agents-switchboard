// Anthropic Messages adapter (Claude Code traffic) for DeepSeek and OpenRouter. Pure functions; see SPEC §6.2 and docs/deepseek-standard.md.
import { baseModelId } from '../catalog.js';
import { mapEffort, EMPTY_OUTPUT_PLACEHOLDER } from './responses.js';

/**
 * @typedef {object} MessagesProfile
 * @property {string} name
 * @property {boolean} adaptiveThinking        provider accepts `thinking.type = "adaptive"`
 * @property {boolean} structuredOutput        provider accepts `output_config.format`
 * @property {boolean} midConversationSystem   provider accepts `role: "system"` inside messages
 * @property {string[]} unsupportedBlocks      content block types to drop
 * @property {string[]|null} effortLevels      effort ladder for `output_config.effort`, or null to pass through
 * @property {boolean} placeholderEmptyOutput  replace empty tool results with a placeholder
 */

/** @type {MessagesProfile} */
export const DEEPSEEK_MESSAGES = { name: 'deepseek', adaptiveThinking: false, structuredOutput: false, midConversationSystem: false, unsupportedBlocks: ['document', 'search_result', 'redacted_thinking'], effortLevels: ['low', 'high', 'max'], placeholderEmptyOutput: true };
/** @type {MessagesProfile} */
export const OPENROUTER_MESSAGES = { name: 'openrouter', adaptiveThinking: true, structuredOutput: true, midConversationSystem: false, unsupportedBlocks: [], effortLevels: null, placeholderEmptyOutput: false };

/** Harness rule: empty tool output still needs some content on the wire. */
function ensureToolResult(block) {
  if (block?.type !== 'tool_result') return block;
  const c = block.content;
  const empty = c == null || c === '' || (Array.isArray(c) && c.length === 0);
  return empty ? { ...block, content: EMPTY_OUTPUT_PLACEHOLDER } : block;
}

/** Harness rule: assistant content is never null or empty; a bricked turn stays in the log forever. */
function ensureAssistantContent(m) {
  if (m.role !== 'assistant') return m;
  const c = m.content;
  const empty = c == null || c === '' || (Array.isArray(c) && c.length === 0);
  return empty ? { ...m, content: '' } : m;
}

function cleanMessage(m, profile, notes) {
  if (!m || typeof m !== 'object') return m;
  let out = { ...m };
  if (out.role === 'system' && !profile.midConversationSystem) { out.role = 'user'; notes.push('system-role→user'); }
  if (Array.isArray(out.content)) {
    const unsupported = new Set(profile.unsupportedBlocks);
    const kept = out.content.filter((b) => !(b && unsupported.has(b.type)));
    if (kept.length !== out.content.length) notes.push(`dropped ${out.content.length - kept.length} unsupported block(s)`);
    if (kept.length === 0 && out.role !== 'assistant') return null;
    out.content = profile.placeholderEmptyOutput ? kept.map(ensureToolResult) : kept;
  }
  return ensureAssistantContent(out);
}

/** Harness rule: `thinking` travels as `{type: enabled|disabled}`; `display` is client-only. */
function cleanThinking(thinking, profile, notes) {
  const { display: _d, ...t } = thinking;
  if (t.type === 'adaptive' && !profile.adaptiveThinking) { t.type = 'enabled'; notes.push('thinking adaptive→enabled'); }
  return t;
}

function cleanOutputConfig(oc, profile, notes) {
  let out = { ...oc };
  if ('format' in out && !profile.structuredOutput) { delete out.format; notes.push('dropped output_config.format'); }
  if (out.effort && profile.effortLevels) out.effort = mapEffort(out.effort, profile.effortLevels);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Rewrite a Claude Code Messages request for a provider's Anthropic-compatible endpoint.
 * @param {object} body
 * @param {MessagesProfile} [profile]
 * @returns {{ body: object, notes: string[] }}
 */
export function rewriteMessagesRequest(body, profile = DEEPSEEK_MESSAGES) {
  const notes = [];
  const out = { ...body, model: baseModelId(body.model) };
  if (out.thinking && typeof out.thinking === 'object') out.thinking = cleanThinking(out.thinking, profile, notes);
  if (Array.isArray(out.messages)) out.messages = out.messages.map((m) => cleanMessage(m, profile, notes)).filter(Boolean);
  if (out.output_config && typeof out.output_config === 'object') {
    const oc = cleanOutputConfig(out.output_config, profile, notes);
    if (oc) out.output_config = oc; else delete out.output_config;
  }
  out.stream = true;
  return { body: out, notes };
}

/** True when any assistant message carries a thinking block without a signature (not Anthropic-originated). */
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

/** Token counts (and OpenRouter's `cost`) from a `message_delta` / `message_start` payload. */
export function usageFromMessagesEvent(j) {
  const u = j?.usage ?? j?.message?.usage;
  if (!u) return null;
  const usage = { input: u.input_tokens ?? 0, cached: u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? 0, output: u.output_tokens ?? 0 };
  if (typeof u.cost === 'number') usage.usd = u.cost;
  return usage;
}
