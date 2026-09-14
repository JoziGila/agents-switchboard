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

/**
 * @param {{ logFile?: string, log?: (line: string) => void }} [opts]
 *   `log` reports a log-file failure once, so a broken log file stays visible without taking the router down.
 */
export function createStats({ logFile, log = () => {} } = {}) {
  const startedAt = Date.now();
  const models = {};   // model -> { requests, input, cached, output, usd }
  const roles = {};    // role -> { requests, input, cached }
  const upstreams = {}; // name -> { lastOk, lastError }
  const inflight = new Map(); // id -> { client, model, role, upstream, startedAt }
  let stalled = 0;    // requests ended by the SSE watchdog (upstream stall), lifetime count
  let seq = 0;
  let stream = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stream = fs.createWriteStream(logFile, { flags: 'a' });
      // A failed write emits 'error', which is unhandled by default and would kill the process mid-request
      // (EACCES, EISDIR, ENOSPC). Report it once through the router's log, keep counting, stop writing.
      stream.on('error', (e) => {
        log(`request log disabled: ${logFile}: ${e.message}`);
        stream = null;
      });
    } catch (e) {
      log(`request log disabled: ${logFile}: ${e.message}`);
    }
  }

  function record(entry) {
    const { model, role, usage } = entry;
    if (model) {
      const m = (models[model] ??= { requests: 0, input: 0, cached: 0, output: 0, usd: 0 });
      m.requests++;
      // A provider-reported cost (OpenRouter's usage.cost) beats the bundled price table.
      if (usage) { m.input += usage.input; m.cached += usage.cached; m.output += usage.output; m.usd += usage.usd ?? estimateUsd(model, usage); }
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

  /**
   * Track a proxied request from arrival, so it shows up in `snapshot().inflight` for as long as it is
   * open — the gap the DeepSeek keep-alive stall exposed: `record` only ever sees completed requests, so
   * a hung upstream left `status` and the log with nothing to show while a client sat blocked.
   * `entry` is the same shape passed to `record` (minus the outcome fields); `handle.end(result)` removes
   * it from `inflight` and forwards `{ ...entry, ...result }` to `record`. A result carrying
   * `error: 'upstream stall'` also bumps the lifetime `stalled` counter.
   */
  function begin(entry) {
    const id = ++seq;
    inflight.set(id, { client: entry.client, model: entry.model, role: entry.role, upstream: entry.upstream, startedAt: Date.now() });
    return {
      end(result = {}) {
        inflight.delete(id);
        if (result.error === 'upstream stall') stalled++;
        record({ ...entry, ...result });
      },
    };
  }

  function snapshot() {
    const now = Date.now();
    const withRatio = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, cacheHitRatio: v.input ? +Math.min(1, v.cached / v.input).toFixed(3) : null }]));
    return {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000), peakNow: isPeak(),
      models: withRatio(models), roles: withRatio(roles), upstreams,
      inflight: [...inflight.values()].map((f) => ({ client: f.client, model: f.model, role: f.role, upstream: f.upstream, ageMs: now - f.startedAt })),
      stalled,
    };
  }
  return { record, begin, snapshot };
}
