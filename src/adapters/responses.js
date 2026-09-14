// Responses API adapter (Codex traffic) for DeepSeek and OpenRouter. Pure functions; see SPEC §6.1 and docs/deepseek-standard.md.
import { baseModelId } from '../catalog.js';

/**
 * @typedef {object} ResponsesProfile
 * @property {string} name                       provider name, used in error messages
 * @property {string[]|null} effortLevels        the provider's effort ladder, or null to pass efforts through
 * @property {string[]} customTools              custom tool names the provider accepts
 * @property {(item: object) => boolean} keepEncryptedContent  whether a reasoning item may keep `encrypted_content`
 * @property {boolean} placeholderEmptyOutput    replace empty tool output with a placeholder
 */

/** @type {ResponsesProfile} */
export const DEEPSEEK_RESPONSES = { name: 'deepseek', effortLevels: ['low', 'high', 'max'], customTools: ['apply_patch'], keepEncryptedContent: () => false, placeholderEmptyOutput: true };
/** @type {ResponsesProfile} The caller overrides keepEncryptedContent with a provenance check. */
export const OPENROUTER_RESPONSES = { name: 'openrouter', effortLevels: ['minimal', 'low', 'medium', 'high'], customTools: [], keepEncryptedContent: () => false, placeholderEmptyOutput: false };

const DROP_TOP_LEVEL = ['store', 'prompt_cache_key', 'service_tier', 'safety_identifier', 'text', 'client_metadata', 'previous_response_id', 'user', 'truncation'];
const DROPPED_TOOL_TYPES = new Set(['tool_search', 'web_search', 'image_generation']);
export const EMPTY_OUTPUT_PLACEHOLDER = '(no output)';

/**
 * Map a client effort onto the provider's ladder. Harness rule: only the provider's own spellings
 * cross the wire; unknown values would be rejected by gateways that validate effort.
 * @param {string} effort
 * @param {string[]|null} ladder
 */
export function mapEffort(effort, ladder) {
  if (!ladder) return effort;
  const e = String(effort ?? '').toLowerCase();
  if (ladder.includes(e)) return e;
  const threeLevel = { minimal: 'low', none: 'low', medium: 'high', xhigh: 'max', ultra: 'max' };
  const fourLevel = { none: 'minimal', xhigh: 'high', max: 'high', ultra: 'high' };
  const table = ladder.length === 3 ? threeLevel : fourLevel;
  return table[e] ?? 'high';
}

function flattenTools(tools, profile) {
  const out = [];
  for (const t of tools ?? []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'namespace') { for (const inner of t.tools ?? []) pushTool(out, inner, profile); }
    else pushTool(out, t, profile);
  }
  return out;
}

function pushTool(out, t, profile) {
  if (t.type === 'function') out.push(t);
  else if (t.type === 'custom' && profile.customTools.includes(t.name)) out.push(t);
  else if (DROPPED_TOOL_TYPES.has(t.type)) return; // provider built-ins do not exist upstream
}

/** Harness rule: reasoning text is replayed byte-exact; only the encrypted payload is provider-bound. */
function cleanReasoningItem(item, profile) {
  if (item.encrypted_content != null && profile.keepEncryptedContent(item)) return item;
  const { encrypted_content: _e, ...r } = item;
  const hasSummary = Array.isArray(r.summary) && r.summary.length > 0;
  const hasContent = Array.isArray(r.content) && r.content.length > 0;
  return hasSummary || hasContent ? r : null;
}

/** Harness rule: an assistant turn must carry content or tool calls; a null content bricks every later turn. */
function ensureAssistantContent(item) {
  if (item.role !== 'assistant') return item;
  const empty = !Array.isArray(item.content) || item.content.length === 0;
  return empty ? { ...item, content: [{ type: 'output_text', text: '' }] } : item;
}

/** Harness rule: empty tool output still needs some content on the wire. */
function ensureToolOutput(item, profile) {
  if (!profile.placeholderEmptyOutput) return item;
  const empty = item.output == null || item.output === '' || (Array.isArray(item.output) && item.output.length === 0);
  return empty ? { ...item, output: EMPTY_OUTPUT_PLACEHOLDER } : item;
}

function cleanInputItem(item, profile) {
  if (!item || typeof item !== 'object') return item;
  const { internal_chat_message_metadata_passthrough: _p, ...rest } = item;
  switch (rest.type) {
    case 'reasoning': return cleanReasoningItem(rest, profile);
    case 'message': return ensureAssistantContent(rest);
    case 'function_call_output': return ensureToolOutput(rest, profile);
    default: return rest;
  }
}

/**
 * Rewrite a Codex Responses request for a stateless provider, touching nothing the cache depends on.
 * @param {object} body parsed request body
 * @param {ResponsesProfile} [profile]
 * @returns {object} new body
 */
export function rewriteResponsesRequest(body, profile = DEEPSEEK_RESPONSES) {
  const out = { ...body };
  if (out.model != null) out.model = baseModelId(out.model);
  for (const k of DROP_TOP_LEVEL) delete out[k];
  if (Array.isArray(out.include)) {
    const inc = out.include.filter((x) => x !== 'reasoning.encrypted_content');
    if (inc.length) out.include = inc; else delete out.include;
  }
  if (Array.isArray(out.input)) out.input = out.input.map((i) => cleanInputItem(i, profile)).filter(Boolean);
  if (Array.isArray(out.tools)) out.tools = flattenTools(out.tools, profile);
  if (out.reasoning && typeof out.reasoning === 'object') {
    const { summary: _s, ...r } = out.reasoning;
    if (r.effort) r.effort = mapEffort(r.effort, profile.effortLevels);
    out.reasoning = r;
  }
  out.stream = true;
  return out;
}

function parseErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (e && typeof e === 'object') {
      const meta = e.metadata ?? {};
      const tags = [meta.error_type, meta.provider_name && `provider ${meta.provider_name}`].filter(Boolean);
      return tags.length ? `${e.message} [${tags.join(', ')}]` : (e.message ?? text);
    }
    return j?.message ?? text;
  } catch { return text; }
}

/**
 * Map an upstream HTTP error to the OpenAI error envelope Codex understands. Never 401/402/403:
 * both clients treat an auth-shaped status from their backend as an expired login.
 * @param {number} status
 * @param {string} text upstream body
 * @param {string} [providerName]
 */
export function mapUpstreamError(status, text, providerName = 'deepseek') {
  const message = `${providerName}: ${parseErrorMessage(text)}`;
  if (status === 401 || status === 402 || status === 403) {
    return { status: 400, body: envelope('invalid_request_error', `${message} (check the ${providerName} API key or credits)`) };
  }
  if (status === 429) return { status: 429, body: envelope('rate_limit_exceeded', message) };
  if (status >= 500) return { status, body: envelope('server_error', message) };
  return { status, body: envelope('invalid_request_error', message) };
}
const envelope = (type, message) => ({ error: { type, code: type, message } });

/** @deprecated use mapUpstreamError */
export const mapDeepSeekError = (status, text) => mapUpstreamError(status, text, 'deepseek');

/** Pull token counts (and OpenRouter's `cost`) from a `response.completed` event, either usage spelling. */
export function usageFromResponsesEvent(event) {
  const u = event?.response?.usage;
  if (!u) return null;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const usage = { input: u.input_tokens ?? 0, cached, output: u.output_tokens ?? 0 };
  if (typeof u.cost === 'number') usage.usd = u.cost;
  return usage;
}

/** Ids of reasoning output items in a `response.output_item.done` or `response.completed` event. */
export function reasoningIdsFromEvent(event) {
  if (event?.type === 'response.output_item.done') return event.item?.type === 'reasoning' && event.item.id ? [event.item.id] : [];
  if (event?.type === 'response.completed') return (event.response?.output ?? []).filter((i) => i?.type === 'reasoning' && i.id).map((i) => i.id);
  return [];
}
