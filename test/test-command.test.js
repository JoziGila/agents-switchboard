import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepseekHits, describeHits } from '../src/commands/test.js';
import { semverGte } from '../src/commands/doctor.js';

const log = [
  JSON.stringify({ ts: '2026-09-14T14:00:00.000Z', client: 'codex', upstream: 'deepseek', model: 'deepseek-flash', role: 'collab_spawn' }),
  JSON.stringify({ ts: '2026-09-14T14:05:00.000Z', client: 'codex', upstream: 'openai', model: 'gpt-5.5' }),
  JSON.stringify({ ts: '2026-09-14T14:06:00.000Z', client: 'codex', upstream: 'deepseek', model: 'deepseek-flash', role: 'collab_spawn', usage: { input: 100, cached: 90, output: 5 } }),
  JSON.stringify({ ts: '2026-09-14T14:07:00.000Z', client: 'claude', upstream: 'deepseek', model: 'deepseek-flash', role: 'subagent' }),
  '{"ts":"2026-09-14T14:08:00.000Z","client":"codex","upstream":"deepsee', // torn last line
].join('\n');

test('deepseekHits filters by client, upstream and time', () => {
  const codex = deepseekHits(log, { client: 'codex', since: '2026-09-14T14:01:00.000Z' });
  assert.equal(codex.length, 1);
  assert.equal(codex[0].usage.cached, 90);
  assert.equal(deepseekHits(log, { client: 'codex', since: '2026-09-14T00:00:00.000Z' }).length, 2);
  assert.equal(deepseekHits(log, { client: 'claude', since: '2026-09-14T00:00:00.000Z' }).length, 1);
  assert.equal(deepseekHits('', { client: 'codex', since: '2026-01-01T00:00:00.000Z' }).length, 0);
});

test('describeHits summarises the first hit', () => {
  assert.equal(describeHits([]), '0 DeepSeek requests via the router');
  const hits = deepseekHits(log, { client: 'codex', since: '2026-09-14T14:01:00.000Z' });
  assert.equal(describeHits(hits), '1 DeepSeek request(s) via the router (model deepseek-flash, role collab_spawn, 100 in / 90 cached / 5 out)');
  assert.match(describeHits([{ model: 'm' }]), /role default\)$/);
});

test('semverGte', () => {
  assert.equal(semverGte('24.18.0', '22.15.0'), true);
  assert.equal(semverGte('v22.15.0', '22.15.0'), true);
  assert.equal(semverGte('22.14.9', '22.15.0'), false);
  assert.equal(semverGte('0.154.0-alpha.6.2', '0.150.0'), true);
  assert.equal(semverGte('2.1.270', '2.1.181'), true);
});
