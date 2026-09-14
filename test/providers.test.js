import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviders, resolveProvider } from '../src/providers.js';
import { baseModelId } from '../src/catalog.js';
import { createProvenance } from '../src/provenance.js';
import { genericEntry, entriesFor } from '../src/catalog.js';

const cfg = { upstream: { deepseek: { base_url: 'https://api.deepseek.com', models: ['deepseek-flash'] }, openrouter: { base_url: 'https://openrouter.ai/api', models: ['qwen/qwen3-coder', 'deepseek/deepseek-v4.1-flash'], model_overrides: { 'qwen/qwen3-coder': { context_window: 131072 } } } } };
const providers = buildProviders(cfg, async () => 'k');

test('model ids select providers; everything else passes through', () => {
  const name = (m) => resolveProvider(providers, m)?.name ?? null;
  assert.equal(name('deepseek-flash'), 'deepseek');
  assert.equal(name('deepseek-flash[1m]'), 'deepseek');
  assert.equal(name('deepseek-v4-flash'), 'deepseek');
  assert.equal(name('deepseek/deepseek-v4.1-flash'), 'openrouter');
  assert.equal(name('~anthropic/claude-opus-latest[1m]'), 'openrouter');
  assert.equal(name('openai/gpt-5.5:nitro'), 'openrouter');
  assert.equal(name('gpt-6-astra'), null);
  assert.equal(name('claude-sonnet-5'), null);
  assert.equal(name(''), null);
  assert.equal(name(undefined), null);
  assert.equal(baseModelId('x[1m]'), 'x');
});

test('provider auth headers per dialect', () => {
  const [ds, or] = providers;
  assert.deepEqual(ds.authHeaders('responses', 'k'), { authorization: 'Bearer k' });
  assert.equal(ds.authHeaders('messages', 'k')['x-api-key'], 'k');
  assert.equal(or.authHeaders('messages', 'k')['anthropic-version'], '2023-06-01');
  assert.equal(or.authHeaders('responses', 'k')['http-referer'], 'https://github.com/JoziGila/agents-switchboard');
});

test('catalog entries: bundled for deepseek slugs, generic with overrides for the rest', () => {
  const entries = entriesFor(providers);
  assert.deepEqual(entries.map((e) => e.slug), ['deepseek-flash', 'qwen/qwen3-coder', 'deepseek/deepseek-v4.1-flash']);
  assert.equal(entries[0].base_instructions.length > 1000, true, 'bundled entry keeps its instructions');
  assert.equal(entries[1].context_window, 131072);
  assert.equal(entries[1].apply_patch_tool_type, 'function');
  assert.equal(entries[2].display_name, 'deepseek-v4.1-flash');
  assert.equal(genericEntry('a/b', 'openrouter').description, 'a model via openrouter');
});

test('provider.endpoint joins baseUrl and dialect path without dropping a path segment already on baseUrl', () => {
  const [ds, or] = providers;
  // OpenRouter's base_url carries a path (/api): a naive new URL(messagesPath, baseUrl) would discard it.
  assert.equal(or.endpoint('messages').href, 'https://openrouter.ai/api/v1/messages');
  assert.equal(or.endpoint('responses').href, 'https://openrouter.ai/api/v1/responses');
  // DeepSeek's base_url has no path: behavior is unchanged, no regression.
  assert.equal(ds.endpoint('messages').href, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(ds.endpoint('responses').href, 'https://api.deepseek.com/responses');
  // A trailing slash on baseUrl must not produce a doubled slash at the join.
  const trailing = buildProviders({ upstream: { openrouter: { base_url: 'https://openrouter.ai/api/', models: [] } } }, async () => 'k')[0];
  assert.equal(trailing.endpoint('messages').href, 'https://openrouter.ai/api/v1/messages');
});

test('provenance is bounded and per provider', () => {
  const p = createProvenance({ limit: 2 });
  p.remember('openrouter', 'a'); p.remember('openrouter', 'b'); p.remember('openrouter', 'c');
  assert.equal(p.has('openrouter', 'a'), false, 'oldest evicted');
  assert.equal(p.has('openrouter', 'c'), true);
  assert.equal(p.has('deepseek', 'c'), false);
  assert.equal(p.has('openrouter', undefined), false);
});
