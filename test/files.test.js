import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backupFile, latestBackup, readTextOr, writeRoleFiles, removeRoleFiles, upsertDelegationFile, removeDelegationFile, readState, writeState } from '../src/install/files.js';
import { DELEGATION_START } from '../src/install/roles.js';
import { tempHome, read, write } from './helpers.js';

test('backupFile and latestBackup', () => {
  const { home, paths, cleanup } = tempHome();
  try {
    const src = path.join(home, 'x.toml');
    assert.equal(backupFile(src, paths.backupsDir, 'x.toml'), null, 'missing source → no backup');
    write(src, 'v1');
    const b1 = backupFile(src, paths.backupsDir, 'x.toml', '20260101-000000-000');
    write(src, 'v2');
    const b2 = backupFile(src, paths.backupsDir, 'x.toml', '20260102-000000-000');
    assert.equal(read(b1), 'v1');
    assert.equal(read(b2), 'v2');
    assert.equal(latestBackup(paths.backupsDir, 'x.toml'), b2);
    assert.equal(latestBackup(paths.backupsDir, 'other'), null);
    assert.equal(latestBackup(path.join(home, 'nope'), 'x.toml'), null);
  } finally { cleanup(); }
});

test('role files respect the managed marker', () => {
  const { home, cleanup } = tempHome();
  try {
    const dir = path.join(home, 'agents');
    write(path.join(dir, 'b.md'), '---\nname: b\n---\nmine\n');
    const spec = { dir, extension: '.md', marker: '<!-- m -->', afterFrontmatter: true, roles: { a: {}, b: {} }, render: (name) => `---\nname: ${name}\n---\n<!-- m -->\nbody\n` };
    assert.deepEqual(writeRoleFiles(spec), { a: 'written', b: 'skipped' });
    assert.deepEqual(writeRoleFiles(spec), { a: 'unchanged', b: 'skipped' });
    assert.deepEqual(removeRoleFiles({ ...spec, names: ['a', 'b', 'c'] }), { a: 'removed', b: 'kept', c: 'kept' });
    assert.equal(read(path.join(dir, 'b.md')), '---\nname: b\n---\nmine\n');
  } finally { cleanup(); }
});

test('delegation file helpers create, refresh and remove the block', () => {
  const { home, cleanup } = tempHome();
  try {
    const file = path.join(home, 'AGENTS.md');
    assert.equal(upsertDelegationFile(file), true, 'created');
    assert.match(read(file), new RegExp(`^${DELEGATION_START}`));
    assert.equal(upsertDelegationFile(file), false, 'idempotent');
    assert.equal(removeDelegationFile(file), true);
    assert.equal(read(file), '');
    assert.equal(removeDelegationFile(path.join(home, 'missing.md')), false);
  } finally { cleanup(); }
});

test('state and readTextOr', () => {
  const { home, paths, cleanup } = tempHome();
  try {
    assert.deepEqual(readState(paths.stateFile), {});
    writeState(paths.stateFile, { claude: { env: {} } });
    assert.deepEqual(readState(paths.stateFile), { claude: { env: {} } });
    assert.equal((fs.statSync(paths.stateFile).mode & 0o777), 0o600);
    assert.equal(readTextOr(path.join(home, 'nope'), 'x'), 'x');
  } finally { cleanup(); }
});
