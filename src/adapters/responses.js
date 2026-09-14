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

/**
 * Codex groups collaboration and MCP tools under `namespace` tools and expects returned calls to carry
 * `namespace` + `name`. Providers know only flat function names, so a member is sent as
 * `<namespace>__<name>` and the call is decoded back with the map this returns (never by string parsing:
 * MCP namespaces already contain `__`).
 */
export function encodeToolName(namespace, name) {
  return `${namespace}__${name}`;
}

/** Map of encoded wire name → { namespace, name } for every namespaced member in a tool list. */
export function namespacedToolMap(tools) {
  const map = new Map();
  for (const t of tools ?? []) {
    if (t?.type !== 'namespace') continue;
    for (const inner of t.tools ?? []) if (inner?.name) map.set(encodeToolName(t.name, inner.name), { namespace: t.name, name: inner.name });
  }
  return map;
}

function flattenTools(tools, profile) {
  const out = [];
  for (const t of tools ?? []) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'namespace') {
      for (const inner of t.tools ?? []) {
        if (!inner || typeof inner !== 'object') continue;
        const prefixed = { ...inner, name: encodeToolName(t.name, inner.name) };
        if (t.description && inner.type === 'function') prefixed.description = `[${t.name}] ${inner.description ?? ''}`.trim();
        pushTool(out, prefixed, profile);
      }
    } else pushTool(out, t, profile);
  }
  return out;
}

/** History `function_call` items that carry a namespace must use the same encoded name the tools use. */
function encodeCallItem(item) {
  if (item?.type !== 'function_call' || !item.namespace) return item;
  const { namespace, ...rest } = item;
  return { ...rest, name: encodeToolName(namespace, item.name) };
}

/** Rewrite one function_call item from the provider back into Codex's namespace + name form. */
function decodeCallItem(item, map) {
  if (item?.type !== 'function_call') return item;
  const hit = map.get(item.name);
  return hit ? { ...item, name: hit.name, namespace: hit.namespace } : item;
}

/**
 * SSE `data:` mapper for the Codex path: decodes namespaced calls in output items and normalises usage.
 * @param {Map<string, {namespace: string, name: string}>} map from namespacedToolMap(originalTools)
 */
export function codexSseMapper(map) {
  return (data) => {
    let out = normalizeResponsesSseData(data);
    if (!map.size || !out.includes('function_call')) return out;
    try {
      const j = JSON.parse(out);
      if (j?.item) j.item = decodeCallItem(j.item, map);
      if (Array.isArray(j?.response?.output)) j.response.output = j.response.output.map((i) => decodeCallItem(i, map));
      return JSON.stringify(j);
    } catch { return out; }
  };
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

const ENCRYPTED_PAYLOAD_NOTE = '[agents-switchboard: this part of the message was encrypted by the vendor and is not readable by this model. If it looks like your task is missing, report that instead of guessing.]';

/**
 * Codex delivers inter-agent traffic as `agent_message` items, a type only the OpenAI backend knows.
 * A stateless provider sees them as a plain user message carrying the same text. An encrypted part
 * (produced under multi-agent v2) cannot be read here; it is replaced by a note so the child says so.
 */
function agentMessageToUserMessage(item) {
  const parts = (Array.isArray(item.content) ? item.content : []).map((c) =>
    c?.type === 'encrypted_content' ? ENCRYPTED_PAYLOAD_NOTE : (c?.text ?? ''));
  const text = parts.filter(Boolean).join('\n');
  return { type: 'message', role: 'user', ...(item.id ? { id: item.id } : {}), content: [{ type: 'input_text', text }] };
}

function cleanInputItem(item, profile) {
  if (!item || typeof item !== 'object') return item;
  const { internal_chat_message_metadata_passthrough: _p, ...rest } = item;
  switch (rest.type) {
    case 'reasoning': return cleanReasoningItem(rest, profile);
    case 'message': return ensureAssistantContent(rest);
    case 'agent_message': return agentMessageToUserMessage(rest);
    case 'function_call': return encodeCallItem(rest);
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

/**
 * Codex reads `usage` from `response.completed` for its context meter and compaction thresholds.
 * Fill the OpenAI spellings from DeepSeek's when they are missing so the shape is native.
 */
export function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    ...usage,
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.total_tokens ?? input + output,
    input_tokens_details: { ...(usage.input_tokens_details ?? {}), cached_tokens: cached },
    output_tokens_details: { ...(usage.output_tokens_details ?? {}), reasoning_tokens: reasoning },
  };
}

/** Apply normalizeResponsesUsage to one SSE `data:` payload when it carries a response with usage. */
export function normalizeResponsesSseData(data) {
  if (!data.includes('"usage"')) return data;
  try {
    const j = JSON.parse(data);
    if (j?.response?.usage) { j.response.usage = normalizeResponsesUsage(j.response.usage); return JSON.stringify(j); }
    return data;
  } catch { return data; }
}
