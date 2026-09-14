import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderPlist, renderUnit, renderWindowsWrapper } from '../src/install/service.js';
import { preflight } from '../src/install/index.js';
import { tempHome, write } from './helpers.js';

const base = { nodePath: '/usr/bin/node', entryPath: '/x/bin/switchboard.js', logFile: '/x/log', pathEnv: '/usr/bin' };

test('service definitions carry PATH plus any provider key env, escaped', () => {
  const plist = renderPlist({ ...base, env: { DEEPSEEK_API_KEY: 'sk-a<b>&c' } });
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/bin<\/string>/);
  assert.match(plist, /<key>DEEPSEEK_API_KEY<\/key><string>sk-a&lt;b&gt;&amp;c<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  const unit = renderUnit({ ...base, env: { OPENROUTER_API_KEY: 'k"q' } });
  assert.match(unit, /^Environment="PATH=\/usr\/bin"$/m);
  assert.match(unit, /^Environment="OPENROUTER_API_KEY=k\\"q"$/m);
  assert.match(unit, /Restart=always/);
  assert.doesNotMatch(renderPlist(base), /DEEPSEEK/, 'no env → no extra keys');
  assert.match(renderWindowsWrapper({ nodePath: 'C:\\node.exe', entryPath: 'C:\\sb.js', envFile: 'C:\\env.cmd' }), /if exist "C:\\env.cmd" call "C:\\env.cmd"/);
});

test('preflight refuses a Claude-side conflict before anything else runs', () => {
  const { paths, cleanup } = tempHome();
  try {
    write(path.join(paths.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
    write(path.join(paths.claudeHome, 'settings.json'), '{ "env": { "ANTHROPIC_API_KEY": "sk" } }');
    assert.throws(() => preflight({ codex: true, claude: true, port: 4141, paths }), /ANTHROPIC_API_KEY/);
    write(path.join(paths.claudeHome, 'settings.json'), '{ oops');
    assert.throws(() => preflight({ codex: true, claude: true, port: 4141, paths }), /settings\.json is not valid JSON/);
    write(path.join(paths.claudeHome, 'settings.json'), '{}');
    write(path.join(paths.codexHome, 'config.toml'), 'profile = "work"\n');
    assert.throws(() => preflight({ codex: true, claude: true, port: 4141, paths }), /profile/);
    write(path.join(paths.codexHome, 'config.toml'), 'model = \n');
    assert.throws(() => preflight({ codex: true, claude: false, port: 4141, paths }), /config\.toml is not valid TOML/);
    write(path.join(paths.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
    assert.doesNotThrow(() => preflight({ codex: true, claude: true, port: 4141, paths }));
  } finally { cleanup(); }
});
