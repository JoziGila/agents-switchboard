import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deepseekHits, describeHits, provenHits, testCommand } from '../src/commands/test.js';
import { rangeBounds, rangeVerdict, semverGte, versionInRange } from '../src/commands/doctor.js';
import { formatStatus } from '../src/commands/status.js';

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

test('provenHits keeps only served subagent requests, per client convention', () => {
  const codex = [
    { role: 'explorer', status: 200 },
    { role: 'worker', status: 200 },
    { role: 'explorer', status: 502 },   // DeepSeek rejected it
    { role: 'explorer' },                // 502 with no status recorded: the router logged an error
    { role: null, status: 200 },         // the parent ran on DeepSeek: no x-openai-subagent
    { role: 'main', status: 200 },       // main-model traffic
  ];
  assert.deepEqual(provenHits(codex, 'codex'), [codex[0], codex[1]]);
  const claude = [{ role: 'subagent', status: 200 }, { role: 'main', status: 200 }];
  assert.deepEqual(provenHits(claude, 'claude'), [claude[0]]);
});

/** One `testCommand` run against an injected client and log, returning the exit code and printed text. */
async function runTest(client, entries, result = { code: 0, stdout: 'The subagent answered 4.', stderr: '' }) {
  let out = '';
  const code = await testCommand({ [client]: true }, {
    present: { codex: client === 'codex', claude: client === 'claude' },
    run: async () => result,
    readLog: () => entries.map((e) => JSON.stringify({ ts: new Date().toISOString(), client, upstream: 'deepseek', model: 'deepseek-flash', ...e })).join('\n'),
    write: (text) => { out += text; },
  });
  return { code, out };
}

test('testCommand passes on a served subagent request, a clean exit and the child answer', async () => {
  const ok = await runTest('codex', [{ role: 'explorer', status: 200, usage: { input: 900, cached: 800, output: 5 } }]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /codex: PASS — 1 DeepSeek request\(s\) via the router \(model deepseek-flash, role explorer, 900 in \/ 800 cached \/ 5 out\); child answer received; client exit 0/);
});

test('testCommand fails on a parent-session, rejected, or unanswered run, and on a nonzero exit', async () => {
  const parent = await runTest('codex', [{ role: null, status: 200 }]);
  assert.equal(parent.code, 1);
  assert.match(parent.out, /codex: FAIL — 0 DeepSeek requests via the router; 1 DeepSeek hit\(s\) ignored: no subagent role or not 2xx/);

  const rejected = await runTest('codex', [{ role: 'explorer', status: 502 }]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.out, /1 DeepSeek hit\(s\) ignored/);

  const silent = await runTest('codex', [{ role: 'explorer', status: 200 }], { code: 0, stdout: 'done', stderr: '' });
  assert.equal(silent.code, 1);
  assert.match(silent.out, /child answer MISSING/);

  const crashed = await runTest('codex', [{ role: 'explorer', status: 200 }], { code: 1, stdout: '4', stderr: '' });
  assert.equal(crashed.code, 1);
  assert.match(crashed.out, /client exit 1/);
});

test('testCommand accepts a Claude subagent and rejects its main-role traffic', async () => {
  const ok = await runTest('claude', [{ role: 'subagent', status: 200 }]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /claude: PASS/);

  const main = await runTest('claude', [{ role: 'main', status: 200 }]);
  assert.equal(main.code, 1);
  assert.match(main.out, /claude: FAIL/);
});

test('the child answer is 4 for this prompt, and 42 is not accepted', async () => {
  for (const answer of ['The subagent answered 4.', 'four', 'Subagent said: 4\n']) {
    const r = await runTest('codex', [{ role: 'explorer', status: 200 }], { code: 0, stdout: answer, stderr: '' });
    assert.equal(r.code, 0, answer);
  }
  // 42 answers a different question (my live harness asked 17+25); it must not pass this PROMPT.
  for (const missing of ['The subagent answered 42.', 'Subagent: 42\n', 'The subagent said 43.', 'client 0.154.0 started']) {
    const r = await runTest('codex', [{ role: 'explorer', status: 200 }], { code: 0, stdout: missing, stderr: '' });
    assert.equal(r.code, 1, missing);
    assert.match(r.out, /child answer MISSING/);
  }
});

test('stderr is diagnostics, not the child answer', async () => {
  const banner = await runTest('codex', [{ role: 'explorer', status: 200 }], { code: 0, stdout: 'done', stderr: 'the child said 4\n' });
  assert.equal(banner.code, 1);
  assert.match(banner.out, /child answer MISSING/);
  assert.match(banner.out, /the child said 4/, 'failure diagnostics still show stderr');

  const real = await runTest('codex', [{ role: 'explorer', status: 200 }], { code: 0, stdout: '4\n', stderr: 'warning: noisy banner\n' });
  assert.equal(real.code, 0);
  assert.match(real.out, /child answer received/);
});

test('status renders failover per client and never the active object', () => {
  const base = {
    listen: '127.0.0.1:4141', uptimeSec: 3, peakNow: false, deepseekModels: ['deepseek-flash'],
    models: {}, roles: {}, upstreams: {}, failover: { enabled: true, model: 'deepseek-flash', active: {} },
  };
  const idle = formatStatus(base);
  assert.match(idle, /failover: enabled → deepseek-flash\n/);
  assert.doesNotMatch(idle, /ACTIVE|\[object Object\]/);

  const one = formatStatus({ ...base, failover: { ...base.failover, active: { codex: { until: '2026-09-14T15:00:00.000Z', reason: 'usage_limit_reached' } } } });
  assert.match(one, /failover: enabled → deepseek-flash · codex ACTIVE until 2026-09-14T15:00:00\.000Z \(usage_limit_reached\)\n/);

  const both = formatStatus({ ...base, failover: { ...base.failover, active: { codex: { until: '2026-09-14T15:00:00.000Z', reason: 'a' }, claude: { until: '2026-09-14T16:00:00.000Z', reason: 'b' } } } });
  assert.match(both, /codex ACTIVE until 2026-09-14T15:00:00\.000Z \(a\) · claude ACTIVE until 2026-09-14T16:00:00\.000Z \(b\)\n/);

  assert.match(formatStatus({ ...base, failover: { enabled: false, model: null, active: {} } }), /failover: disabled\n/);
});

test('semverGte', () => {
  assert.equal(semverGte('24.18.0', '22.15.0'), true);
  assert.equal(semverGte('v22.15.0', '22.15.0'), true);
  assert.equal(semverGte('22.14.9', '22.15.0'), false);
  assert.equal(semverGte('0.154.0-alpha.6.2', '0.150.0'), true);
  assert.equal(semverGte('2.1.270', '2.1.181'), true);
});

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));

test('version ranges are parsed from package.json and both bounds are checked', () => {
  assert.deepEqual(rangeBounds('>=0.150.0 <0.156.0'), { min: '0.150.0', max: '0.156.0' });
  assert.deepEqual(rangeBounds(pkg.switchboard.claudeRange), { min: '2.1.181', max: null });
  assert.throws(() => rangeBounds('^1.2.3'), /cannot read/);
  const range = pkg.switchboard.codexRange;
  assert.equal(versionInRange('0.155.9', range), true);
  assert.equal(versionInRange(rangeBounds(range).min, range), true, 'the lower bound itself is supported');
  assert.equal(versionInRange(rangeBounds(range).max, range), false, 'a version above the upper bound fails');
  assert.equal(versionInRange('0.156.1', range), false);
  assert.equal(versionInRange('99.0.0', pkg.switchboard.claudeRange), true, 'no upper bound means no ceiling');
  assert.equal(versionInRange('2.1.180', pkg.switchboard.claudeRange), false);
  assert.equal(versionInRange(undefined, range), true, 'an unrunnable binary is not a version failure');
  assert.deepEqual(rangeBounds(pkg.engines.node), { min: '22.15', max: null });
});

test('an unparseable package.json range fails one check, it does not throw', async () => {
  // The forms npm allows that this parser does not read. install.js imports doctor after the client configs
  // are written, so any of these must fail its own check, never the import.
  const bad = { engines: { node: '~1.2.3' }, switchboard: { codexRange: '^22.15.0', claudeRange: 'a || b' } };
  for (const key of ['engines.node', 'switchboard.codexRange', 'switchboard.claudeRange']) {
    const verdict = rangeVerdict('1.0.0', key, undefined, bad);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, new RegExp(key.replace('.', '\\.')), `the failure names package.json ${key}`);
  }
  // The declared ranges this build ships with still decide the check the normal way.
  assert.deepEqual(rangeVerdict('1.0.0', 'switchboard.codexRange'), { ok: false, detail: '1.0.0 (supported >=0.150.0 <0.156.0)' });
  assert.equal(rangeVerdict(process.versions.node, 'engines.node').ok, true);
  await assert.doesNotReject(() => import('../src/commands/doctor.js'), 'importing doctor cannot throw for range reasons');
});
