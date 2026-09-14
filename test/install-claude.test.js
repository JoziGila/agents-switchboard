import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyClaudeSettings, revertClaudeSettings, installClaude, uninstallClaude, findWarnings, readSettings } from '../src/install/claude.js';
import { tempHome, read, write } from './helpers.js';

const TOKEN = 'tok-A';

test('managed env keys are merged and recorded', () => {
  const { settings, state } = applyClaudeSettings({ env: { FOO: '1' }, model: 'claude-fable-5-1' }, 4141, {}, { token: TOKEN });
  assert.equal(settings.env.FOO, '1');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4141/_switchboard/${TOKEN}/anthropic`);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash[1m]');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'deepseek-flash[1m]');
  assert.equal(settings.model, 'claude-fable-5-1');
  assert.equal(settings.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, '1', 'effort must reach the unrecognised DeepSeek id');
  assert.deepEqual(settings.modelSettings['deepseek-flash'], { effortLevel: 'high' });
  assert.equal(state.env.ANTHROPIC_BASE_URL, null, 'null records "we added it"');
  assert.equal(state.modelSettings, null);
});

test('overwritten values are restored on revert; other modelSettings fields survive', () => {
  const original = { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, modelSettings: { 'deepseek-flash': { effortLevel: 'low', thinking: 'off' }, 'claude-opus-5': { effortLevel: 'max' } } };
  const { settings, state } = applyClaudeSettings(original, 4141, {}, { token: TOKEN });
  assert.equal(state.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
  assert.equal(state.modelSettings, 'low', 'only our field is recorded');
  assert.deepEqual(settings.modelSettings['deepseek-flash'], { effortLevel: 'high', thinking: 'off' }, 'merged, not replaced');
  assert.deepEqual(revertClaudeSettings(settings, state), original);
});

test('revert of a clean install removes only our keys', () => {
  const { settings, state } = applyClaudeSettings({}, 4141, {}, { token: TOKEN });
  assert.deepEqual(revertClaudeSettings(settings, state), {});
});

test('conflicts are reported', () => {
  for (const [s, needle] of [
    [{ env: { ANTHROPIC_API_KEY: 'x' } }, 'ANTHROPIC_API_KEY'],
    [{ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }, 'ANTHROPIC_AUTH_TOKEN'],
    [{ apiKeyHelper: 'cmd' }, 'apiKeyHelper'],
    [{ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }, 'ANTHROPIC_BASE_URL'],
    [{ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, 'CLAUDE_CODE_USE_BEDROCK'],
  ]) {
    assert.throws(() => applyClaudeSettings(s, 4141, {}, { token: TOKEN }), new RegExp(needle));
  }
  // our own earlier url on another port is not a conflict when state says we own it
  const prev = { env: { ANTHROPIC_BASE_URL: null } };
  assert.doesNotThrow(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000/anthropic' } }, 4141, prev, { token: TOKEN }));
  // ...and also when state.json was lost: the loopback + /anthropic shape is ours by construction
  assert.doesNotThrow(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000/anthropic' } }, 4141, {}, { token: TOKEN }));
  assert.throws(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000/other' } }, 4141, {}, { token: TOKEN }), /ANTHROPIC_BASE_URL/);
});

test('a capability url is recognised as ours, so a reinstall with a fresh token migrates', () => {
  const capability = (token) => `http://127.0.0.1:4141/_switchboard/${token}/anthropic`;
  // Ours by shape even with state.json gone, for both the new and the older tokenless form.
  assert.doesNotThrow(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: capability('old') } }, 4141, {}, { token: 'new' }));
  assert.doesNotThrow(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141/anthropic' } }, 4141, {}, { token: 'new' }));
  // Somebody else's gateway is still a conflict.
  assert.throws(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }, 4141, {}, { token: 'new' }), /ANTHROPIC_BASE_URL/);
  assert.throws(() => applyClaudeSettings({}, 4141, {}, { token: 'bad/token' }), /base64url/);

  const { settings } = applyClaudeSettings({}, 4141, {}, { token: 'tok-A' });
  assert.equal(settings.env.ANTHROPIC_BASE_URL, capability('tok-A'));
  assert.doesNotMatch(JSON.stringify(settings), /_switchboard\/tok-A.*_switchboard/, 'only one capability url is written');
});

test('warnings: shell credentials and the force variable, neither a hard conflict', () => {
  assert.deepEqual(findWarnings({}, {}), []);
  assert.equal(findWarnings({}, { ANTHROPIC_API_KEY: 'sk' }).length, 1);
  assert.match(findWarnings({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }, {})[0], /inherit/);
  assert.match(findWarnings({}, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })[0], /Explore and Plan/);
  assert.doesNotThrow(() => applyClaudeSettings({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } }, 4141, {}, { token: TOKEN }));
});

test('a missing capability token is refused instead of writing the url the router answers with 400', async () => {
  assert.throws(() => applyClaudeSettings({}, 4141), /access token required/);
  assert.throws(() => applyClaudeSettings({}, 4141, {}, { token: '' }), /access token required/);
  const { paths, cleanup } = tempHome();
  try {
    await assert.rejects(() => installClaude({ paths, port: 4141, env: {} }), /access token required/);
    assert.equal(fs.existsSync(path.join(paths.claudeHome, 'settings.json')), false, 'the refusal happens before any write');
  } finally { cleanup(); }
});

test('a corrupt settings.json is reported by name', () => {
  const { home, cleanup } = tempHome();
  try {
    const file = path.join(home, 'settings.json');
    write(file, '{ not json');
    assert.throws(() => readSettings(file), /settings\.json is not valid JSON/);
  } finally { cleanup(); }
});

test('installClaude writes settings, roles and CLAUDE.md; uninstall restores', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const home = paths.claudeHome;
    const original = '{\n  "env": {\n    "CLAUDE_CODE_SCROLL_SPEED": "1"\n  },\n  "model": "claude-fable-5-1"\n}\n';
    write(path.join(home, 'settings.json'), original);
    write(path.join(home, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nmine\n');
    write(path.join(home, 'CLAUDE.md'), '# Global\n');

    const r1 = await installClaude({ paths, port: 4141, token: TOKEN, env: {} });
    assert.equal(r1.settingsChanged, true);
    assert.equal(read(r1.backup), original);
    const s = JSON.parse(read(path.join(home, 'settings.json')));
    assert.equal(s.env.CLAUDE_CODE_SCROLL_SPEED, '1');
    assert.equal(s.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4141/_switchboard/${TOKEN}/anthropic`);
    assert.equal(s.model, 'claude-fable-5-1');
    assert.match(read(path.join(home, 'settings.json')), /^\{\n  "env": \{\n/, '2-space indent preserved');
    assert.equal(r1.roles.reviewer, 'skipped');
    assert.equal(read(path.join(home, 'agents', 'reviewer.md')), '---\nname: reviewer\n---\nmine\n');
    const explorer = read(path.join(home, 'agents', 'explorer.md'));
    assert.match(explorer, /^---\nname: explorer\n/);
    assert.match(explorer, /\nmodel: deepseek-flash\[1m\]\ntools: Read, Grep, Glob, Bash\neffort: high\n---\n<!-- managed by agents-switchboard -->\nYou are an explorer\./);
    assert.match(read(path.join(home, 'agents', 'senior.md')), /\nmodel: inherit\n/);
    assert.doesNotMatch(read(path.join(home, 'agents', 'worker.md')), /\ntools:/);
    assert.match(read(path.join(home, 'CLAUDE.md')), /^# Global\n\n<!-- agents-switchboard delegation policy -->/);
    assert.ok(fs.existsSync(paths.stateFile));

    const r2 = await installClaude({ paths, port: 4141, token: TOKEN, env: {} });
    assert.equal(r2.settingsChanged, false);
    assert.equal(r2.roles.explorer, 'unchanged');
    assert.equal(r2.claudeMd, false);

    const warn = await installClaude({ paths, port: 4141, token: TOKEN, env: { ANTHROPIC_API_KEY: 'sk' } });
    assert.equal(warn.warnings.length, 1);
    assert.ok(fs.existsSync(path.join(home, 'agents', 'Explore.md')), 'built-in Explore is overridden');
    assert.match(read(path.join(home, 'agents', 'Explore.md')), /\nmodel: deepseek-flash\[1m\]\n/);

    const u = await uninstallClaude({ paths });
    assert.equal(u.settingsChanged, true);
    assert.deepEqual(JSON.parse(read(path.join(home, 'settings.json'))), JSON.parse(original));
    assert.equal(u.roles.explorer, 'removed');
    assert.equal(u.roles.reviewer, 'kept');
    assert.equal(read(path.join(home, 'CLAUDE.md')), '# Global\n');
    assert.deepEqual(JSON.parse(read(paths.stateFile)), {});
  } finally {
    cleanup();
  }
});

test('installClaude on a machine without settings.json creates it', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const r = await installClaude({ paths, port: 4141, token: TOKEN, env: {} });
    assert.equal(r.settingsChanged, true);
    assert.equal(r.backup, null);
    const s = JSON.parse(read(path.join(paths.claudeHome, 'settings.json')));
    assert.equal(Object.keys(s.env).length, 6);
  } finally {
    cleanup();
  }
});

test('uninstall refuses to guess when state.json is gone but Claude is still routed', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const file = path.join(paths.claudeHome, 'settings.json');
    const original = '{"env":{"FOO":"1"}}\n';
    write(file, original);
    await installClaude({ paths, port: 4141, env: {}, token: 'tok-A' });
    assert.match(read(file), /_switchboard\/tok-A\/anthropic/);
    fs.rmSync(paths.stateFile, { force: true }); // e.g. the user removed ~/.agents-switchboard

    await assert.rejects(
      () => uninstallClaude({ paths }),
      /still routes Claude through agents-switchboard \(env\.ANTHROPIC_BASE_URL.*state\.json is missing/s,
    );
    assert.match(read(file), /_switchboard\/tok-A\/anthropic/, 'the routing key was left alone, not guessed away');
    assert.ok(fs.existsSync(path.join(paths.claudeHome, 'agents', 'explorer.md')), 'role files are left for a complete retry');
  } finally {
    cleanup();
  }
});

test('a user-chosen deepseek model is left alone when state.json is gone and no router url remains', async () => {
  const { paths, cleanup } = tempHome();
  try {
    write(path.join(paths.claudeHome, 'settings.json'), '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"deepseek-flash[1m]"},"modelSettings":{"deepseek-flash":{"effortLevel":"low"}}}\n');
    write(path.join(paths.claudeHome, 'agents', 'explorer.md'), '---\nname: explorer\n---\n<!-- managed by agents-switchboard -->\nYou are an explorer.\n');
    const u = await uninstallClaude({ paths });
    assert.equal(u.settingsChanged, false);
    assert.equal(read(path.join(paths.claudeHome, 'settings.json')), '{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"deepseek-flash[1m]"},"modelSettings":{"deepseek-flash":{"effortLevel":"low"}}}\n');
    assert.equal(u.roles.explorer, 'removed');
  } finally {
    cleanup();
  }
});

test('ownership is recorded before the settings write, so a failed write stays revertible', async () => {
  const { paths, cleanup } = tempHome();
  const file = path.join(paths.claudeHome, 'settings.json');
  try {
    const original = '{"env":{"FOO":"1"}}\n';
    write(file, original);
    fs.chmodSync(file, 0o400); // the config write fails; state.json lives elsewhere and still succeeds
    let failed = false;
    try { await installClaude({ paths, port: 4141, token: TOKEN, env: {} }); } catch { failed = true; }
    fs.chmodSync(file, 0o600);
    if (!failed) return; // root ignores file modes: there is no crash window to simulate

    assert.equal(read(file), original, 'the failed write left settings.json untouched');
    assert.ok(fs.existsSync(paths.stateFile), 'ownership was recorded before the write');
    const u = await uninstallClaude({ paths });
    assert.equal(u.settingsChanged, false);
    assert.equal(read(file), original, 'uninstall keeps the compact formatting it did not write');
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    cleanup();
  }
});

test('the uninstall command reports a lost-state routing key and leaves the service alone', async () => {
  const { spawn } = await import('node:child_process');
  const { paths, cleanup } = tempHome();
  try {
    const file = path.join(paths.claudeHome, 'settings.json');
    // Claude still routed by us, but no state.json to say what that replaced.
    const routed = `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141/_switchboard/tok-A/anthropic"\n  }\n}\n`;
    write(file, routed);

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['bin/switchboard.js', 'uninstall'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, HOME: paths.home, AGENTS_SWITCHBOARD_HOME: paths.switchboardHome, CODEX_HOME: paths.codexHome, CLAUDE_CONFIG_DIR: paths.claudeHome },
      });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });

    const said = result.out + result.err;
    assert.equal(result.code, 1, 'uninstall reports failure instead of claiming success');
    assert.match(said, /still routes Claude through agents-switchboard/, 'the reason is actionable prose');
    assert.match(said, /router is still running/, 'the user is told the service was preserved');
    assert.doesNotMatch(said, /^\s+at /m, 'no stack trace');
    assert.equal(read(file), routed, 'the config it cannot restore exactly is left untouched');
  } finally { cleanup(); }
});

test('dry run previews role files and the delegation block without writing', async () => {
  const { paths, cleanup } = tempHome();
  try {
    write(path.join(paths.claudeHome, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nmine\n');
    const r = await installClaude({ paths, port: 4141, token: TOKEN, dryRun: true, env: {} });
    assert.equal(r.roles.explorer, 'written');
    assert.equal(r.roles.reviewer, 'skipped');
    assert.equal(r.claudeMd, true);
    assert.equal(fs.existsSync(path.join(paths.claudeHome, 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(paths.claudeHome, 'agents', 'explorer.md')), false);
    assert.equal(fs.existsSync(path.join(paths.claudeHome, 'CLAUDE.md')), false);
  } finally { cleanup(); }
});
