import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { applyCodexConfig, stripManaged, installCodex, uninstallCodex, findWarnings, hasManaged } from '../src/install/codex.js';
import { tempHome, read, write } from './helpers.js';

const URL = 'http://127.0.0.1:4141/backend-api/codex';

test('empty config gets base url, agents and features blocks', () => {
  const out = applyCodexConfig('', 4141);
  const cfg = parse(out);
  assert.equal(cfg.openai_base_url, URL);
  assert.equal(cfg.agents.default_subagent_model, 'deepseek-flash');
  assert.equal(cfg.agents.default_subagent_reasoning_effort, 'high');
  assert.equal(cfg.agents.max_concurrent_threads_per_session, 8);
  assert.equal(cfg.features.multi_agent_v2, false);
  assert.match(out, /# >>> agents-switchboard >>>/);
});

test('top-level key lands before the first table header', () => {
  const original = 'model = "gpt-6-astra"\n\n[features]\nhooks = true\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  const out = applyCodexConfig(original, 4242);
  const lines = out.split('\n');
  const urlIdx = lines.findIndex((l) => l.startsWith('openai_base_url'));
  const firstHeader = lines.findIndex((l) => /^\[/.test(l));
  assert.ok(urlIdx !== -1 && urlIdx < firstHeader, 'openai_base_url must precede the first table');
  const cfg = parse(out);
  assert.equal(cfg.openai_base_url, 'http://127.0.0.1:4242/backend-api/codex');
  assert.equal(cfg.model, 'gpt-6-astra');
  assert.equal(cfg.projects['/x'].trust_level, 'trusted');
});

test('existing [features] and [agents] tables are merged into, not duplicated', () => {
  const original = 'model = "gpt-6-astra"\n\n[features]\nhooks = true\ncontext_management.experimental_mode = true\n\n[agents]\nmax_threads = 4\n\n[agents.reviewer]\ndescription = "x"\nconfig_file = "~/.codex/agents/reviewer.toml"\n\n[mcp_servers.foo]\nurl = "http://x"\n';
  const out = applyCodexConfig(original, 4141);
  assert.equal((out.match(/^\[features\]/gm) || []).length, 1);
  assert.equal((out.match(/^\[agents\]/gm) || []).length, 1);
  const cfg = parse(out);
  assert.equal(cfg.features.hooks, true);
  assert.equal(cfg.features.multi_agent_v2, false);
  assert.equal(cfg.agents.max_threads, 4);
  assert.equal(cfg.agents.default_subagent_model, 'deepseek-flash');
  assert.equal(cfg.agents.reviewer.description, 'x', 'sub-table must be untouched');
  assert.equal(cfg.mcp_servers.foo.url, 'http://x');
  // merged keys are tagged so uninstall can find them
  assert.match(out, /default_subagent_model = "deepseek-flash" # agents-switchboard/);
  assert.match(out, /multi_agent_v2 = false # agents-switchboard/);
  assert.doesNotMatch(out, /# >>> agents-switchboard >>>/, 'no block needed when both tables exist');
});

test('idempotent: applying twice yields identical text', () => {
  const original = 'model = "gpt-5.5"\n\n[features]\nhooks = true\n';
  const once = applyCodexConfig(original, 4141);
  const twice = applyCodexConfig(once, 4141);
  assert.equal(twice, once);
});

test('changing the port rewrites our url rather than conflicting', () => {
  const once = applyCodexConfig('model = "gpt-5.5"\n', 4141);
  const moved = applyCodexConfig(once, 5000);
  assert.equal(parse(moved).openai_base_url, 'http://127.0.0.1:5000/backend-api/codex');
  assert.equal((moved.match(/openai_base_url/g) || []).length, 1);
});

test('stripManaged returns the original text', () => {
  const original = 'model = "gpt-5.5"\n\n[features]\nhooks = true\n\n[agents]\nmax_threads = 2\n';
  const applied = applyCodexConfig(original, 4141);
  assert.equal(stripManaged(applied).trim(), original.trim());
});

test('conflicts are reported and nothing is produced', () => {
  for (const [text, needle] of [
    ['profile = "work"\n', 'profile'],
    ['oss_provider = "ollama"\n', 'oss_provider'],
    ['model_provider = "sakana"\n', 'model_provider'],
    ['model_catalog_json = "~/.codex/models.json"\n', 'model_catalog_json'],
    ['openai_base_url = "https://other.example/v1"\n', 'openai_base_url'],
    ['[agents]\ndefault_subagent_model = "gpt-5.5"\n', 'agents.default_subagent_model'],
    ['agents = { max_threads = 4 }\n', 'agents written as an inline table'],
    ['features = "on"\n', 'features written as an inline table'],
  ]) {
    assert.throws(() => applyCodexConfig(text, 4141), new RegExp(needle), text);
  }
  // model_provider = "openai" is fine
  assert.doesNotThrow(() => applyCodexConfig('model_provider = "openai"\n', 4141));
});

test('installCodex writes config, roles and AGENTS.md; uninstall restores', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const home = paths.codexHome;
    const original = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n\n[features]\nhooks = true\n\n[projects."/a"]\ntrust_level = "trusted"\n';
    write(path.join(home, 'config.toml'), original);
    write(path.join(home, 'agents', 'worker.toml'), 'name = "worker"\ndescription = "mine"\ndeveloper_instructions = "keep"\n');
    write(path.join(home, 'AGENTS.md'), '# My rules\n\nBe nice.\n');

    const r1 = await installCodex({ paths, port: 4141 });
    assert.equal(r1.configChanged, true);
    assert.ok(r1.backup && fs.existsSync(r1.backup));
    assert.equal(read(r1.backup), original);
    assert.equal(r1.roles.explorer, 'written');
    assert.equal(r1.roles.worker, 'skipped', 'unmanaged role file must not be clobbered');
    assert.equal(read(path.join(home, 'agents', 'worker.toml')), 'name = "worker"\ndescription = "mine"\ndeveloper_instructions = "keep"\n');
    const explorer = read(path.join(home, 'agents', 'explorer.toml'));
    assert.match(explorer, /^# managed by agents-switchboard\n/);
    assert.equal(parse(explorer).model, 'deepseek-flash');
    assert.equal(parse(explorer).model_reasoning_effort, 'high');
    assert.equal(parse(read(path.join(home, 'agents', 'senior.toml'))).model, 'gpt-5.5');
    const md = read(path.join(home, 'AGENTS.md'));
    assert.match(md, /^# My rules\n\nBe nice\.\n\n<!-- agents-switchboard delegation policy -->/);
    assert.match(md, /<!-- \/agents-switchboard -->\n$/);

    const snapshot = { config: read(path.join(home, 'config.toml')), md, explorer };
    const r2 = await installCodex({ paths, port: 4141 });
    assert.equal(r2.configChanged, false);
    assert.equal(r2.roles.explorer, 'unchanged');
    assert.equal(r2.agentsMd, false);
    assert.equal(read(path.join(home, 'config.toml')), snapshot.config);
    assert.equal(read(path.join(home, 'AGENTS.md')), snapshot.md);

    const pro = await installCodex({ paths, port: 4141, pro: true });
    assert.equal(pro.roles.senior, 'written');
    assert.equal(parse(read(path.join(home, 'agents', 'senior.toml'))).model, 'deepseek-v4-pro');

    const u = await uninstallCodex({ paths });
    assert.equal(u.configChanged, true);
    assert.equal(read(path.join(home, 'config.toml')), original);
    assert.equal(u.roles.explorer, 'removed');
    assert.equal(u.roles.worker, 'kept');
    assert.equal(fs.existsSync(path.join(home, 'agents', 'explorer.toml')), false);
    assert.equal(read(path.join(home, 'AGENTS.md')), '# My rules\n\nBe nice.\n');
  } finally {
    cleanup();
  }
});

test('dryRun writes nothing but previews roles and the block', async () => {
  const { paths, cleanup } = tempHome();
  try {
    write(path.join(paths.codexHome, 'agents', 'worker.toml'), 'name = "worker"\n');
    const r = await installCodex({ paths, port: 4141, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.roles.explorer, 'written');
    assert.equal(r.roles.worker, 'skipped');
    assert.equal(r.agentsMd, true);
    assert.equal(fs.existsSync(path.join(paths.codexHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(paths.codexHome, 'agents', 'explorer.toml')), false);
  } finally {
    cleanup();
  }
});

test('invalid TOML is reported by name, not as a parser stack', () => {
  assert.throws(() => applyCodexConfig('model = \n', 4141), /config\.toml is not valid TOML/);
});

test('role files carry no sandbox_mode: Codex ignores it', async () => {
  const { paths, cleanup } = tempHome();
  try {
    await installCodex({ paths, port: 4141 });
    for (const name of ['explorer', 'worker', 'reviewer', 'senior']) {
      const text = read(path.join(paths.codexHome, 'agents', `${name}.toml`));
      assert.doesNotMatch(text, /sandbox_mode/);
      assert.ok(parse(text).developer_instructions.length > 50);
    }
    assert.match(read(path.join(paths.codexHome, 'agents', 'worker.toml')), /never revert, reformat or clean up code you did not write/);
  } finally { cleanup(); }
});

test('warnings: context_management.experimental_mode costs cache hits', () => {
  assert.deepEqual(findWarnings(''), []);
  assert.deepEqual(findWarnings('model = "x"\n'), []);
  assert.match(findWarnings('[features]\ncontext_management.experimental_mode = true\n')[0], /experimental_mode/);
  assert.match(findWarnings('[context_management]\nexperimental_mode = true\n')[0], /experimental_mode/);
});

test('uninstall is a byte-exact no-op on a file the installer never touched', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const original = 'model = "gpt-5.5"\n\n\n\n[features]\nhooks = true\n';
    write(path.join(paths.codexHome, 'config.toml'), original);
    assert.equal(hasManaged(original), false);
    const u = await uninstallCodex({ paths });
    assert.equal(u.configChanged, false);
    assert.equal(read(path.join(paths.codexHome, 'config.toml')), original, 'blank runs preserved, nothing rewritten');
    assert.equal(fs.existsSync(paths.backupsDir), false, 'no backup taken');
  } finally { cleanup(); }
});

test('install then uninstall round-trips the original bytes, including a file with no tables', async () => {
  for (const original of [
    'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n\n[features]\nhooks = true\n\n[projects."/a"]\ntrust_level = "trusted"\n',
    'model = "gpt-5.5"\n',
    '',
    '# comment only\n\n[mcp_servers.x]\nurl = "http://x"\n',
  ]) {
    const { paths, cleanup } = tempHome();
    try {
      write(path.join(paths.codexHome, 'config.toml'), original);
      await installCodex({ paths, port: 4141 });
      assert.equal(hasManaged(read(path.join(paths.codexHome, 'config.toml'))), true);
      await uninstallCodex({ paths });
      assert.equal(read(path.join(paths.codexHome, 'config.toml')), original, JSON.stringify(original));
    } finally { cleanup(); }
  }
});
