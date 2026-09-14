import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseRelay } from '../src/sse.js';

async function relay(chunks, opts) {
  const r = createSseRelay(opts);
  const out = [];
  r.on('data', (d) => out.push(d.toString('utf8')));
  for (const c of chunks) r.write(c);
  r.end();
  await new Promise((res) => r.on('end', res));
  return out.join('');
}

test('multi-byte characters split across chunks survive the relay byte-exact', async () => {
  const text = 'data: {"delta":"héllo → 世界 🚀"}\n\n';
  const bytes = Buffer.from(text, 'utf8');
  for (const cut of [bytes.indexOf(Buffer.from('é')) + 1, bytes.indexOf(Buffer.from('🚀')) + 2]) {
    const out = await relay([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal(out, text);
  }
});

test('mapData rewrites payloads and onEvent sees parsed JSON; ping is emitted on silence', async () => {
  const seen = [];
  const out = await relay(['event: x\ndata: {"a":1}\n\n', 'data: [DONE]\n\n'], { mapData: (d) => d.replace('1', '2'), onEvent: (j) => seen.push(j) });
  assert.equal(out, 'event: x\ndata: {"a":2}\n\ndata: [DONE]\n\n');
  assert.deepEqual(seen, [{ a: 1 }]);
  const r = createSseRelay({ pingMs: 30 });
  const got = [];
  r.on('data', (d) => got.push(d.toString()));
  await new Promise((res) => setTimeout(res, 80));
  r.end();
  assert.ok(got.some((g) => g.includes('event: ping')));
});
