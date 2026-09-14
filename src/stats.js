import fs from 'node:fs';
import path from 'node:path';

/** USD per 1M tokens: [offPeak, peak]. Peak: 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri. */
export const PRICING = {
  'deepseek-flash': { miss: [0.15, 0.30], hit: [0.003, 0.006], out: [0.60, 1.20] },
  'deepseek-v4-pro': { miss: [0.66, 1.32], hit: [0.022, 0.044], out: [1.98, 3.96] },
};

export function isPeak(date = new Date()) {
  const d = date.getUTCDay(), h = date.getUTCHours();
  if (d === 0 || d === 6) return false;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function estimateUsd(model, { input = 0, cached = 0, output = 0 }, date = new Date()) {
  const p = PRICING[model]; if (!p) return 0;
  const i = isPeak(date) ? 1 : 0;
  const miss = Math.max(0, input - cached);
  return (miss * p.miss[i] + cached * p.hit[i] + output * p.out[i]) / 1e6;
}

export function createStats({ logFile } = {}) {
  const startedAt = Date.now();
  const models = {};   // model -> { requests, input, cached, output, usd }
  const roles = {};    // role -> { requests, input, cached }
  const upstreams = {}; // name -> { lastOk, lastError }
  let stream = null;
  if (logFile) {
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); stream = fs.createWriteStream(logFile, { flags: 'a' }); } catch {}
  }

  function record(entry) {
    const { model, role, usage } = entry;
    if (model) {
      const m = (models[model] ??= { requests: 0, input: 0, cached: 0, output: 0, usd: 0 });
      m.requests++;
      if (usage) { m.input += usage.input; m.cached += usage.cached; m.output += usage.output; m.usd += estimateUsd(model, usage); }
    }
    if (role) {
      const r = (roles[role] ??= { requests: 0, input: 0, cached: 0 });
      r.requests++; if (usage) { r.input += usage.input; r.cached += usage.cached; }
    }
    if (entry.upstream) {
      const u = (upstreams[entry.upstream] ??= { lastOk: null, lastError: null });
      if (entry.status && entry.status < 500) u.lastOk = new Date().toISOString(); else u.lastError = `${entry.status ?? entry.error} @ ${new Date().toISOString()}`;
    }
    if (stream) stream.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }
  function snapshot() {
    const withRatio = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, cacheHitRatio: v.input ? +(v.cached / v.input).toFixed(3) : null }]));
    return { uptimeSec: Math.round((Date.now() - startedAt) / 1000), peakNow: isPeak(), models: withRatio(models), roles: withRatio(roles), upstreams };
  }
  return { record, snapshot };
}
