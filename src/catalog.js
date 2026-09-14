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

/** Short stable hash of the injected entries, used to fork the upstream ETag. */
export function catalogHash(entries) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 8);
}

/** Append DeepSeek entries to an upstream `/models` payload, skipping slugs already present. */
export function mergeModels(upstream, entries) {
  const models = Array.isArray(upstream?.models) ? upstream.models : [];
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
