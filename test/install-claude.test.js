import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyClaudeSettings, revertClaudeSettings, installClaude, uninstallClaude } from '../src/install/claude.js';
import { tempHome, read, write } from './helpers.js';

test('managed env keys are merged and recorded', () => {
  const { settings, state } = applyClaudeSettings({ env: { FOO: '1' }, model: 'claude-fable-5-1' }, 4141);
  assert.equal(settings.env.FOO, '1');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141/anthropic');
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash[1m]');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'deepseek-flash[1m]');
  assert.equal(settings.model, 'claude-fable-5-1');
  assert.deepEqual(settings.modelSettings['deepseek-flash'], { effort: 'high' });
  assert.equal(state.env.ANTHROPIC_BASE_URL, null, 'null records "we added it"');
  assert.equal(state.modelSettings, null);
});

test('overwritten values are restored on revert', () => {
  const original = { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, modelSettings: { 'deepseek-flash': { effort: 'low' }, 'claude-opus-5': { effort: 'max' } } };
  const { settings, state } = applyClaudeSettings(original, 4141);
  assert.equal(state.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
  assert.deepEqual(state.modelSettings, { effort: 'low' });
  assert.deepEqual(revertClaudeSettings(settings, state), original);
});

test('revert of a clean install removes only our keys', () => {
  const { settings, state } = applyClaudeSettings({}, 4141);
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
    assert.throws(() => applyClaudeSettings(s, 4141), new RegExp(needle));
  }
  // our own earlier url on another port is not a conflict when state says we own it
  const prev = { env: { ANTHROPIC_BASE_URL: null } };
  assert.doesNotThrow(() => applyClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000/anthropic' } }, 4141, prev));
});

test('installClaude writes settings, roles and CLAUDE.md; uninstall restores', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const home = paths.claudeHome;
    const original = '{\n  "env": {\n    "CLAUDE_CODE_SCROLL_SPEED": "1"\n  },\n  "model": "claude-fable-5-1"\n}\n';
    write(path.join(home, 'settings.json'), original);
    write(path.join(home, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nmine\n');
    write(path.join(home, 'CLAUDE.md'), '# Global\n');

    const r1 = await installClaude({ paths, port: 4141, env: {} });
    assert.equal(r1.settingsChanged, true);
    assert.equal(read(r1.backup), original);
    const s = JSON.parse(read(path.join(home, 'settings.json')));
    assert.equal(s.env.CLAUDE_CODE_SCROLL_SPEED, '1');
    assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141/anthropic');
    assert.equal(s.model, 'claude-fable-5-1');
    assert.match(read(path.join(home, 'settings.json')), /^\{\n  "env": \{\n/, '2-space indent preserved');
    assert.equal(r1.roles.reviewer, 'skipped');
    assert.equal(read(path.join(home, 'agents', 'reviewer.md')), '---\nname: reviewer\n---\nmine\n');
    const explorer = read(path.join(home, 'agents', 'explorer.md'));
    assert.match(explorer, /^---\nname: explorer\n/);
    assert.match(explorer, /\nmodel: deepseek-flash\[1m\]\ntools: Read, Grep, Glob, Bash\neffort: low\n---\n<!-- managed by agents-switchboard -->\nYou are an explorer\./);
    assert.match(read(path.join(home, 'agents', 'senior.md')), /\nmodel: inherit\n/);
    assert.doesNotMatch(read(path.join(home, 'agents', 'worker.md')), /\ntools:/);
    assert.match(read(path.join(home, 'CLAUDE.md')), /^# Global\n\n<!-- agents-switchboard delegation policy -->/);
    assert.ok(fs.existsSync(paths.stateFile));

    const r2 = await installClaude({ paths, port: 4141, env: {} });
    assert.equal(r2.settingsChanged, false);
    assert.equal(r2.roles.explorer, 'unchanged');
    assert.equal(r2.claudeMd, false);

    const warn = await installClaude({ paths, port: 4141, env: { ANTHROPIC_API_KEY: 'sk' } });
    assert.equal(warn.warnings.length, 1);

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
    const r = await installClaude({ paths, port: 4141, env: {} });
    assert.equal(r.settingsChanged, true);
    assert.equal(r.backup, null);
    const s = JSON.parse(read(path.join(paths.claudeHome, 'settings.json')));
    assert.equal(Object.keys(s.env).length, 5);
  } finally {
    cleanup();
  }
});
