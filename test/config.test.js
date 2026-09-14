import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig, resolveDeepSeekKey, listenAddress, DEFAULT_CONFIG } from '../src/config.js';
import { upsertDelegation, removeDelegation } from '../src/install/roles.js';
import { resolvePaths, backupStamp } from '../src/paths.js';
import { tempHome, write } from './helpers.js';

test('defaults load when no file exists', () => {
  const { paths, cleanup } = tempHome();
  try {
    const cfg = loadConfig(paths);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.deepEqual(listenAddress(cfg), { host: '127.0.0.1', port: 4141 });
  } finally { cleanup(); }
});

test('user values merge over defaults and round-trip', () => {
  const { paths, cleanup } = tempHome();
  try {
    write(paths.configFile, 'listen = "127.0.0.1:5000"\n\n[upstream.deepseek]\napi_key = { env = "DEEPSEEK_API_KEY" }\n\n[failover]\nenabled = true\n');
    const cfg = loadConfig(paths);
    assert.equal(listenAddress(cfg).port, 5000);
    assert.deepEqual(cfg.upstream.deepseek.api_key, { env: 'DEEPSEEK_API_KEY' });
    assert.equal(cfg.upstream.deepseek.base_url, 'https://api.deepseek.com');
    assert.equal(cfg.failover.enabled, true);
    assert.equal(cfg.failover.model, 'deepseek-flash');
    saveConfig(cfg, paths);
    assert.deepEqual(loadConfig(paths), cfg);
  } finally { cleanup(); }
});

test('resolveDeepSeekKey honours env and keychain sources', async () => {
  const envCfg = { upstream: { deepseek: { api_key: { env: 'MY_KEY' } } } };
  assert.equal(await resolveDeepSeekKey(envCfg, { env: { MY_KEY: 'abc' } }), 'abc');
  assert.equal(await resolveDeepSeekKey(envCfg, { env: {} }), null);
  const kcCfg = { upstream: { deepseek: { api_key: { keychain: 'agents-switchboard/deepseek' } } } };
  assert.equal(await resolveDeepSeekKey(kcCfg, { env: {}, getSecret: async (n) => (n === 'agents-switchboard/deepseek' ? 'kc' : null) }), 'kc');
  assert.equal(await resolveDeepSeekKey(kcCfg, { env: { DEEPSEEK_API_KEY: 'fallback' }, getSecret: async () => null }), 'fallback');
});

test('delegation block upsert is idempotent and removable', () => {
  const once = upsertDelegation('# Rules\n');
  assert.equal(upsertDelegation(once), once);
  assert.equal(removeDelegation(once), '# Rules\n');
  assert.equal(removeDelegation('nothing here\n'), 'nothing here\n');
  const stale = once.replace('every non-trivial diff', 'OLD TEXT');
  assert.equal(upsertDelegation(stale), once, 'an older block is replaced');
  assert.match(upsertDelegation(''), /^<!-- agents-switchboard delegation policy -->/);
});

test('paths honour CODEX_HOME and CLAUDE_CONFIG_DIR', () => {
  const p = resolvePaths({ CODEX_HOME: '/x/codex', CLAUDE_CONFIG_DIR: '/x/claude' }, '/home/u');
  assert.equal(p.codexHome, '/x/codex');
  assert.equal(p.claudeHome, '/x/claude');
  assert.equal(p.switchboardHome, '/home/u/.agents-switchboard');
  assert.match(backupStamp(new Date(2026, 8, 14, 16, 5, 9, 7)), /^20260914-160509-007$/);
});
