import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ensureAccessToken, loadConfig, newAccessToken, readCapability, resolveProviderKey, routerBaseUrl, saveConfig, listenAddress, DEFAULT_CONFIG } from '../src/config.js';
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

test('access token is explicit config, preserved, and writes user-only', () => {
  const { paths, cleanup } = tempHome();
  try {
    const token = newAccessToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const cfg = ensureAccessToken(loadConfig(paths));
    assert.match(cfg.access_token, /^[A-Za-z0-9_-]{43}$/);
    saveConfig(cfg, paths);
    assert.equal(loadConfig(paths).access_token, cfg.access_token);
    assert.equal((fs.statSync(paths.configFile).mode & 0o777), 0o600);
    const existing = loadConfig(paths);
    ensureAccessToken(existing);
    assert.equal(existing.access_token, cfg.access_token);
  } finally { cleanup(); }
});

test('routerBaseUrl requires the access token and returns the protected base', () => {
  assert.throws(() => routerBaseUrl({ listen: '127.0.0.1:4141' }), /missing access_token.*switchboard install/);
  assert.equal(routerBaseUrl({ listen: '127.0.0.1:5000', access_token: 'tok' }), 'http://127.0.0.1:5000/_switchboard/tok');
  // Clients are always configured with the literal loopback address, so `localhost` normalizes to it and
  // every exact-URL check (doctor, conflicts, uninstall) agrees on one spelling of the same listener.
  assert.equal(routerBaseUrl({ listen: 'localhost:4141', access_token: 'tok' }), 'http://127.0.0.1:4141/_switchboard/tok');
  // The segment is used verbatim (no percent-encoding), so a malformed token is refused instead.
  assert.throws(() => routerBaseUrl({ listen: '127.0.0.1:4141', access_token: 'a/b' }), /base64url/);
  assert.throws(() => routerBaseUrl({ listen: '127.0.0.1:4141', access_token: '' }), /missing access_token/);
});

test('ensureAccessToken rejects a malformed existing token instead of silently replacing it', () => {
  assert.throws(() => ensureAccessToken({ access_token: 'not a token' }), /base64url/);
  const kept = ensureAccessToken({ access_token: 'tok-A' });
  assert.equal(kept.access_token, 'tok-A');
});

test('resolveProviderKey honours env and keychain sources', async () => {
  const envSection = { api_key: { env: 'MY_KEY' } };
  assert.equal(await resolveProviderKey(envSection, 'DEEPSEEK_API_KEY', { env: { MY_KEY: 'abc' } }), 'abc');
  assert.equal(await resolveProviderKey(envSection, 'DEEPSEEK_API_KEY', { env: {} }), null);
  const kcSection = { api_key: { keychain: 'agents-switchboard/deepseek' } };
  assert.equal(await resolveProviderKey(kcSection, 'DEEPSEEK_API_KEY', { env: {}, getSecret: async (n) => (n === 'agents-switchboard/deepseek' ? 'kc' : null) }), 'kc');
  assert.equal(await resolveProviderKey(kcSection, 'DEEPSEEK_API_KEY', { env: { DEEPSEEK_API_KEY: 'fallback' }, getSecret: async () => null }), 'fallback');
  assert.equal(await resolveProviderKey({}, 'DEEPSEEK_API_KEY', { env: { DEEPSEEK_API_KEY: 'plain' } }), 'plain');
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

test('readCapability splits the capability segment from the local path', () => {
  assert.deepEqual(readCapability('/_switchboard/tok/anthropic/v1/messages'), { url: '/anthropic/v1/messages', supplied: 'tok' });
  assert.deepEqual(readCapability('/anthropic/v1/messages'), { url: '/anthropic/v1/messages', supplied: null });
  assert.deepEqual(readCapability('/_switchboard/'), { url: '/', supplied: '' });
  assert.deepEqual(readCapability('/_switchboard/tok'), { url: '/', supplied: '' });
  assert.deepEqual(readCapability('/_switchboard/tok/'), { url: '/', supplied: 'tok' });
});

test('paths honour CODEX_HOME and CLAUDE_CONFIG_DIR', () => {
  const p = resolvePaths({ CODEX_HOME: '/x/codex', CLAUDE_CONFIG_DIR: '/x/claude' }, '/home/u');
  assert.equal(p.codexHome, '/x/codex');
  assert.equal(p.claudeHome, '/x/claude');
  assert.equal(p.switchboardHome, '/home/u/.agents-switchboard');
  assert.match(backupStamp(new Date(2026, 8, 14, 16, 5, 9, 7)), /^20260914-160509-007$/);
});
