import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = JSON.parse(readFileSync(path.join(here, '..', 'catalog', 'deepseek.models.json'), 'utf8'));

/** Strip a Claude-style `[1m]` context suffix. */
export function baseModelId(model) {
  return String(model ?? '').replace(/\[1m\]$/i, '');
}

/** A model is DeepSeek-bound when its id (sans suffix) starts with `deepseek-`. */
export function isDeepSeekModel(model) {
  return /^deepseek-/i.test(baseModelId(model));
}

/** Bundled DeepSeek catalog entries restricted to the configured slugs. */
export function deepseekEntries(slugs) {
  const wanted = new Set(slugs ?? bundled.models.map((m) => m.slug));
  return bundled.models.filter((m) => wanted.has(m.slug));
}

/**
 * A picker entry for a model a provider serves but ships no catalog for (OpenRouter ids). Derived from
 * DeepSeek's Flash entry: plain function tools, function-style apply_patch, no responses-lite, no code mode.
 * Per-model `overrides` (context_window, display_name, supported_reasoning_levels, ...) win.
 */
export function genericEntry(slug, providerName, overrides = {}) {
  const base = bundled.models.find((m) => m.slug === 'deepseek-flash');
  const { base_instructions: _b, model_messages: _m, ...template } = base;
  const vendor = slug.replace(/^~/, '').split('/')[0];
  return {
    ...template,
    slug,
    display_name: overrides.display_name ?? slug.replace(/^~/, '').split('/').pop(),
    description: overrides.description ?? `${vendor} model via ${providerName}`,
    apply_patch_tool_type: 'function',
    input_modalities: ['text'],
    supports_search_tool: false,
    context_window: 262_144,
    max_context_window: 262_144,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balanced reasoning for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    priority: 9,
    ...overrides,
  };
}

/**
 * All entries to inject into the Codex picker for the configured providers: DeepSeek's bundled entries
 * for its slugs, generic entries for everything else.
 * @param {import('./providers.js').Provider[]} providers
 */
export function entriesFor(providers) {
  const out = [];
  for (const p of providers) {
    for (const slug of p.models) {
      const bundledEntry = bundled.models.find((m) => m.slug === slug);
      const entry = bundledEntry ?? genericEntry(slug, p.name, p.modelOverrides[slug]);
      out.push(p.modelOverrides[slug] && bundledEntry ? { ...entry, ...p.modelOverrides[slug] } : entry);
    }
  }
  return out;
}

/** Short stable hash of everything the router changes in the catalog, used to fork the upstream ETag. */
export function catalogHash(changes) {
  return createHash('sha256').update(JSON.stringify(changes)).digest('hex').slice(0, 8);
}

/**
 * Append provider entries to an upstream `/models` payload, skipping slugs already present.
 *
 * With `forceMultiAgentV1`, upstream entries that declare `multi_agent_version: "v2"` are served as
 * `"v1"`. Codex takes the multi-agent version from the parent model's catalog entry (the
 * `features.multi_agent_v2` flag only forces v2 on, never off), and under v2 the OpenAI backend
 * returns spawn_agent arguments encrypted: the child then receives an opaque payload it cannot read.
 * v1 sends the task in plaintext, which is what a child on another provider needs.
 */
export function mergeModels(upstream, entries, { forceMultiAgentV1 = true } = {}) {
  const models = (Array.isArray(upstream?.models) ? upstream.models : []).map((m) =>
    forceMultiAgentV1 && m?.multi_agent_version === 'v2' ? { ...m, multi_agent_version: 'v1' } : m);
  const present = new Set(models.map((m) => m.slug));
  return { ...upstream, models: [...models, ...entries.filter((e) => !present.has(e.slug))] };
}

/** `"abc"` → `"abc+sb1234abcd"`; missing upstream ETag → `"sb1234abcd"`. Weak prefixes preserved. */
export function rewriteEtag(etag, hash) {
  if (!etag) return `"sb${hash}"`;
  const weak = etag.startsWith('W/');
  const inner = etag.replace(/^W\//, '').replace(/^"|"$/g, '');
  return `${weak ? 'W/' : ''}"${inner}+sb${hash}"`;
}
