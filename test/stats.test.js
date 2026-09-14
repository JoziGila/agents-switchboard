import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStats, estimateUsd, isPeak } from '../src/stats.js';
import { tempHome } from './helpers.js';

test('a log file that cannot be written is reported once and never kills the router', async () => {
  const { home, cleanup } = tempHome();
  try {
    const warnings = [];
    // A directory as the log path: opening it for append fails with EISDIR.
    const logFile = path.join(home, 'switchboard.log');
    fs.mkdirSync(logFile, { recursive: true });

    const stats = createStats({ logFile, log: (line) => warnings.push(line) });
    // Routing and counting must keep working after the write failure.
    stats.record({ model: 'deepseek-flash', role: 'explorer', status: 200, usage: { input: 100, cached: 50, output: 10 } });
    stats.record({ model: 'deepseek-flash', role: 'explorer', status: 200, usage: { input: 100, cached: 0, output: 10 } });
    await new Promise((r) => setTimeout(r, 50)); // the stream 'error' event is asynchronous

    const snap = stats.snapshot();
    assert.equal(snap.models['deepseek-flash'].requests, 2, 'counters keep working after a bad log file');
    assert.equal(snap.roles.explorer.requests, 2);
    assert.equal(snap.models['deepseek-flash'].cacheHitRatio, 0.25);
    assert.ok(warnings.length >= 1, 'the failure is reported, not swallowed');
    assert.match(warnings.join('\n'), /request log disabled.*switchboard\.log/);
    // The process is still alive here, after the error event: an unhandled 'error' would have exited.
    stats.record({ model: 'deepseek-flash', status: 200 });
    assert.equal(stats.snapshot().models['deepseek-flash'].requests, 3);
  } finally { cleanup(); }
});

test('a writable log file still gets metadata-only JSONL lines', () => {
  const { home, cleanup } = tempHome();
  try {
    const logFile = path.join(home, 'logs', 'switchboard.log');
    const stats = createStats({ logFile, log: () => assert.fail('no warning expected for a writable file') });
    stats.record({ model: 'deepseek-flash', status: 200 });
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          const line = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n')[0]);
          assert.equal(line.model, 'deepseek-flash');
          assert.equal(line.status, 200);
          resolve();
        } catch (e) { reject(e); }
      }, 30);
    });
  } finally { setTimeout(cleanup, 60); }
});

test('pricing helpers stay pure', () => {
  assert.equal(estimateUsd('unknown-model', { input: 1000 }), 0);
  assert.equal(typeof isPeak(new Date()), 'boolean');
});

test('begin/end tracks in-flight requests and clears them on completion', () => {
  const stats = createStats();
  const a = stats.begin({ client: 'codex', model: 'deepseek-flash', role: 'main', upstream: 'deepseek' });
  const b = stats.begin({ client: 'claude', model: 'deepseek-flash', role: 'subagent', upstream: 'deepseek' });
  let snap = stats.snapshot();
  assert.equal(snap.inflight.length, 2);
  assert.deepEqual(snap.inflight.map((f) => f.client).sort(), ['claude', 'codex']);
  assert.ok(snap.inflight.every((f) => typeof f.ageMs === 'number' && f.ageMs >= 0));
  assert.equal(snap.stalled, 0);

  a.end({ status: 200, ms: 5 });
  snap = stats.snapshot();
  assert.equal(snap.inflight.length, 1, 'a finished request leaves inflight');
  assert.equal(snap.models['deepseek-flash'].requests, 1, 'end() still records into the normal counters');

  b.end({ status: 504, error: 'upstream stall', ms: 30 });
  snap = stats.snapshot();
  assert.equal(snap.inflight.length, 0);
  assert.equal(snap.stalled, 1, 'a stalled completion bumps the lifetime counter');
  assert.match(snap.upstreams.deepseek.lastError, /^504 @ /, 'stall status feeds the upstream error the same as any other failure');
});
