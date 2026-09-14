import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderPlist, renderUnit, renderWindowsWrapper, installService } from '../src/install/service.js';
import { preflight, runUninstall } from '../src/install/index.js';
import { installCodex } from '../src/install/codex.js';
import { tempHome, read, write } from './helpers.js';

const base = { nodePath: '/usr/bin/node', entryPath: '/x/bin/switchboard.js', logFile: '/x/log', pathEnv: '/usr/bin' };

/** A launchctl that can be told to lose the bootstrap race, to keep the old job loaded for N polls, or to predate bootstrap. */
function fakeLaunchctl({ bootstrapFailures = 0, bootstrapError = 'Bootstrap failed: 5: Input/output error', printLoaded = 0 } = {}) {
  const calls = [];
  let bootstraps = 0;
  let prints = 0;
  const run = async (_cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'print') { if (++prints <= printLoaded) return { stdout: 'pid = 1', stderr: '' }; throw Object.assign(new Error('Could not find service "dev.agents-switchboard"'), { stderr: 'Could not find service "dev.agents-switchboard"' }); }
    if (args[0] === 'bootstrap') { if (++bootstraps <= bootstrapFailures) throw Object.assign(new Error(`Command failed: launchctl bootstrap\n${bootstrapError}`), { stderr: bootstrapError }); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  return { run, calls, bootstraps: () => bootstraps, prints: () => prints };
}
const svcOpts = (home, run) => ({ home, platform: 'darwin', entryPath: '/x/bin/switchboard.js', logFile: path.join(home, 'service.log'), run });

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

test('a Claude revert that fails reports both clients, and leaves Codex reverted', async () => {
  const { paths, cleanup } = tempHome();
  try {
    const configFile = path.join(paths.codexHome, 'config.toml');
    const original = 'model = "gpt-6-astra"\n';
    write(configFile, original);
    await installCodex({ paths, port: 4141, token: 'tok-A' });
    assert.match(read(configFile), /agents-switchboard/, 'Codex is installed before the uninstall');
    // Claude points at the router with no state.json recording what it replaced, so its revert must refuse.
    write(path.join(paths.claudeHome, 'settings.json'), `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4141/_switchboard/tok-A/anthropic' } })}\n`);

    await assert.rejects(() => runUninstall({ paths }), (e) => {
      assert.match(e.message, /^codex: restored · claude: FAILED — /);
      assert.match(e.message, /state\.json/, 'the reason for the Claude failure is in the same line');
      assert.match(e.message, /router is still running/);
      return true;
    });
    assert.equal(read(configFile), original, 'Codex stays reverted even though the Claude revert failed');
  } finally { cleanup(); }
});

test('preflight refuses a Claude-side conflict before anything else runs', () => {
  const { paths, cleanup } = tempHome();
  try {
    write(path.join(paths.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
    write(path.join(paths.claudeHome, 'settings.json'), '{ "env": { "ANTHROPIC_API_KEY": "sk" } }');
    assert.throws(() => preflight({ codex: true, claude: true, port: 4141, token: 'tok-A', paths }), /ANTHROPIC_API_KEY/);
    write(path.join(paths.claudeHome, 'settings.json'), '{ oops');
    assert.throws(() => preflight({ codex: true, claude: true, port: 4141, token: 'tok-A', paths }), /settings\.json is not valid JSON/);
    write(path.join(paths.claudeHome, 'settings.json'), '{}');
    write(path.join(paths.codexHome, 'config.toml'), 'profile = "work"\n');
    assert.throws(() => preflight({ codex: true, claude: true, port: 4141, token: 'tok-A', paths }), /profile/);
    write(path.join(paths.codexHome, 'config.toml'), 'model = \n');
    assert.throws(() => preflight({ codex: true, claude: false, port: 4141, token: 'tok-A', paths }), /config\.toml is not valid TOML/);
    write(path.join(paths.codexHome, 'config.toml'), 'model = "gpt-5.5"\n');
    assert.doesNotThrow(() => preflight({ codex: true, claude: true, port: 4141, token: 'tok-A', paths }));
  } finally { cleanup(); }
});

test('preflight catches the same Codex configs the writer refuses, before any mutation', () => {
  const { paths, cleanup } = tempHome();
  try {
    const file = path.join(paths.codexHome, 'config.toml');
    // A token routes through the capability prefix, so preflight must judge against that exact url.
    write(file, 'model = "gpt-5.5"\n');
    assert.doesNotThrow(() => preflight({ codex: true, claude: false, port: 4141, token: 'tok-A', paths }));
    write(file, 'openai_base_url = "https://other.example/v1"\n');
    assert.throws(() => preflight({ codex: true, claude: false, port: 4141, token: 'tok-A', paths }), /openai_base_url/);

    // A [agents] header inside a multiline string is what the writer refuses; preflight must agree.
    const masked = 'model = "gpt-5.5"\n\ndescription = """\n[agents]\nnot a table\n"""\n';
    write(file, masked);
    assert.throws(() => preflight({ codex: true, claude: false, port: 4141, token: 'tok-A', paths }), /cannot be edited safely/);
    assert.equal(read(file), masked, 'preflight writes nothing');
  } finally { cleanup(); }
});

test('a bootstrap that loses the unload race is retried, never falling back to legacy load', async () => {
  const { home, cleanup } = tempHome();
  try {
    const fake = fakeLaunchctl({ bootstrapFailures: 1 });
    const svc = await installService(svcOpts(home, fake.run));
    assert.equal(svc.kind, 'launchd');
    assert.equal(svc.file, path.join(home, 'Library', 'LaunchAgents', 'dev.agents-switchboard.plist'));
    assert.ok(fs.existsSync(svc.file), 'the plist ends up installed');
    assert.equal(fake.bootstraps(), 2, 'the raced bootstrap was retried');
    assert.ok(!fake.calls.includes('load'), 'the legacy load path was not taken');
  } finally { cleanup(); }
});

test('bootstrap waits for the old job to leave launchd before it runs', async () => {
  const { home, cleanup } = tempHome();
  try {
    const fake = fakeLaunchctl({ printLoaded: 2 });
    await installService(svcOpts(home, fake.run));
    assert.equal(fake.prints(), 3, 'polled launchctl print until the job was gone');
    assert.ok(fake.calls.lastIndexOf('print') < fake.calls.indexOf('bootstrap'), 'unload precedes bootstrap');
  } finally { cleanup(); }
});

test('a generic bootstrap failure is raised with launchctl stderr; only an unsupported subcommand falls back', async () => {
  const { home, cleanup } = tempHome();
  try {
    await assert.rejects(installService(svcOpts(home, fakeLaunchctl({ bootstrapFailures: Infinity }).run)), /launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error/);
    const legacy = fakeLaunchctl({ bootstrapFailures: Infinity, bootstrapError: 'Usage: launchctl bootstrap <domain-target> [service-path]' });
    const svc = await installService(svcOpts(home, legacy.run));
    assert.equal(svc.kind, 'launchd');
    assert.ok(legacy.calls.includes('load'), 'an older launchctl falls back to load');
  } finally { cleanup(); }
});
