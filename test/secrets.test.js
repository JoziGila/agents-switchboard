import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setSecret } from '../src/secrets.js';

const onDarwin = process.platform === 'darwin';

/**
 * A stand-in `security`. It records the argv and stdin it was given, parses the interactive command
 * line with the two escaping rules the real tokenizer applies inside double quotes, and stores the
 * result. `SB_FAKE_EXIT` makes it fail, `SB_FAKE_MODE=truncate` makes it store fewer bytes than
 * asked — the ways the real tool could hand back something other than what we sent.
 */
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const write = (file, text) => fs.writeFileSync(file, text);

/** Mirror \`security -i\`: double-quoted tokens, where only \\\\ and \\" are escapes. */
function tokenize(line) {
  const out = [];
  const re = /"((?:\\\\[\\\\"]|[^"])*)"|(\\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] === undefined ? m[2] : m[1].replace(/\\\\([\\\\"])/g, '$1'));
  return out;
}

const command = argv[0];
if (command === '-i') {
  // Only interactive mode reads stdin; reading it elsewhere would block on a pipe nobody closes.
  const stdin = (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } })();
  write(process.env.SB_FAKE_ARGV, JSON.stringify(argv));
  write(process.env.SB_FAKE_STDIN, stdin);
  const tokens = tokenize(stdin.split('\\n')[0]);
  const value = tokens[tokens.indexOf('-w') + 1];
  if (value !== undefined) {
    write(process.env.SB_FAKE_STORE, process.env.SB_FAKE_MODE === 'truncate' ? value.slice(0, 8) : value);
  }
  const code = Number(process.env.SB_FAKE_EXIT || 0);
  if (code) {
    // Deliberately echo the value, the worst case for the error path we are testing.
    process.stderr.write('security: SecKeychainAddGenericPassword: failed for ' + value + '\\n');
    process.exit(code);
  }
  process.exit(0);
}
if (command === 'find-generic-password') {
  process.stdout.write(fs.existsSync(process.env.SB_FAKE_STORE) ? fs.readFileSync(process.env.SB_FAKE_STORE, 'utf8') + '\\n' : '');
  process.exit(fs.existsSync(process.env.SB_FAKE_STORE) ? 0 : 44);
}
if (command === 'delete-generic-password') {
  fs.appendFileSync(process.env.SB_FAKE_LOG, 'delete\\n');
  fs.rmSync(process.env.SB_FAKE_STORE, { force: true });
  process.exit(0);
}
process.exit(1);
`;

/** Put the fake first on PATH and hand back the files it writes. */
function fakeSecurity(t, { mode = 'ok', exit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fake-security-'));
  const files = {
    argv: path.join(dir, 'argv.json'),
    stdin: path.join(dir, 'stdin.txt'),
    store: path.join(dir, 'store.txt'),
    log: path.join(dir, 'delete.log'),
  };
  fs.writeFileSync(path.join(dir, 'security'), FAKE_SECURITY, { mode: 0o755 });
  const previous = { PATH: process.env.PATH };
  process.env.PATH = `${dir}:${previous.PATH}`;
  process.env.SB_FAKE_ARGV = files.argv;
  process.env.SB_FAKE_STDIN = files.stdin;
  process.env.SB_FAKE_STORE = files.store;
  process.env.SB_FAKE_LOG = files.log;
  process.env.SB_FAKE_MODE = mode;
  process.env.SB_FAKE_EXIT = String(exit);
  t.after(() => {
    process.env.PATH = previous.PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return files;
}

// Every character class a naive quoting or shell-escaping route would mangle: spaces, a double
// quote, a single quote, `$`, shell metacharacters, a backslash and a backtick.
const KEY = `sk-a b$"';&|\\\``;
const LONG_KEY = `sk-or-v1-${'0123456789abcdef'.repeat(16)}`;

test('the key reaches the keychain on stdin, never in argv', { skip: !onDarwin }, async (t) => {
  const f = fakeSecurity(t);
  assert.equal(await setSecret('agents-switchboard/deepseek', KEY), true);

  assert.deepEqual(JSON.parse(fs.readFileSync(f.argv, 'utf8')), ['-i'], 'security is invoked in interactive mode, with nothing else in argv');
  const stdin = fs.readFileSync(f.stdin, 'utf8');
  assert.ok(stdin.startsWith('add-generic-password -U '), 'the command line arrives on stdin');
  assert.ok(stdin.includes('-w "'), 'the value is passed as a quoted token on stdin');
  assert.equal(fs.readFileSync(f.store, 'utf8'), KEY, 'the stored value is byte-exact');
});

test('a key longer than the getpass prompt limit is stored whole', { skip: !onDarwin }, async (t) => {
  const f = fakeSecurity(t);
  assert.equal(LONG_KEY.length > 128, true, 'the fixture must exceed the 128-character prompt limit');
  assert.equal(await setSecret('agents-switchboard/openrouter', LONG_KEY), true);
  assert.equal(fs.readFileSync(f.store, 'utf8'), LONG_KEY);
});

test('a failing security rejects without printing the key', { skip: !onDarwin }, async (t) => {
  fakeSecurity(t, { exit: 3 });
  const error = await setSecret('agents-switchboard/deepseek', KEY).then(
    () => assert.fail('setSecret must reject when the command fails'),
    (e) => e,
  );
  assert.match(error.message, /exited 3/, 'the exit status is reported');
  assert.ok(!error.message.includes(KEY), 'the key must not appear in the error');
  assert.ok(!error.message.includes('sk-a'), 'no part of the key may appear in the error');
});

test('a value that cannot be read back is reported, and the item is left alone', { skip: !onDarwin }, async (t) => {
  const f = fakeSecurity(t, { mode: 'truncate' });
  const error = await setSecret('agents-switchboard/deepseek', KEY).then(
    () => assert.fail('setSecret must reject when the stored value differs'),
    (e) => e,
  );
  assert.match(error.message, /did not store .* as given/);
  assert.ok(!error.message.includes(KEY), 'the key must not appear in the error');
  assert.ok(fs.existsSync(f.store), 'the stored item must survive a readback mismatch');
  assert.equal(fs.existsSync(f.log), false, 'no delete may be issued on a readback mismatch');
});

test('a value with a newline is refused before anything is spawned', { skip: !onDarwin }, async (t) => {
  const f = fakeSecurity(t);
  const error = await setSecret('agents-switchboard/deepseek', `sk-two\nlines`).then(
    () => assert.fail('setSecret must reject a value it cannot carry'),
    (e) => e,
  );
  assert.match(error.message, /newline/);
  assert.ok(!error.message.includes('sk-two'), 'the key must not appear in the error');
  assert.equal(fs.existsSync(f.argv), false, 'security must not be invoked at all');
});
