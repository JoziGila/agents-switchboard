import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusPage } from '../src/status-page.js';

const base = {
  listen: '127.0.0.1:8787', uptimeSec: 12, peakNow: false, deepseekModels: ['deepseek-flash'],
  failover: { enabled: false, model: null, active: {} },
  models: {}, roles: {}, upstreams: {}, inflight: [], stalled: 0,
};

test('renders an empty in-flight table and a zero stalled count when nothing is happening', () => {
  const html = renderStatusPage(base);
  assert.match(html, /In flight \(0\)/);
  assert.match(html, /none right now/);
  assert.match(html, /stalled requests \(lifetime\): 0/);
});

test('renders in-flight rows and a nonzero stalled count', () => {
  const html = renderStatusPage({
    ...base,
    inflight: [{ client: 'codex', model: 'deepseek-flash', role: 'main', upstream: 'deepseek', ageMs: 45_000 }],
    stalled: 3,
  });
  assert.match(html, /In flight \(1\)/);
  assert.match(html, /<td>codex<\/td>/);
  assert.match(html, /<td>45 s<\/td>/);
  assert.match(html, /stalled requests \(lifetime\): 3/);
});
