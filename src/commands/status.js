// `switchboard status`: the router's counters as a table, or raw JSON with --json.
import { loadConfig, listenAddress } from '../config.js';

const number = (n) => (n == null ? '-' : typeof n === 'number' && !Number.isInteger(n) ? n.toFixed(4) : String(n));
const row = (cells) => cells.map(([value, width, align]) => (align === 'left' ? String(value).padEnd(width) : number(value).padStart(width))).join(' ');

/**
 * @param {{ port?: string|number, json?: boolean }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function status(opts = {}) {
  const config = loadConfig();
  if (opts.port) config.listen = `127.0.0.1:${opts.port}`;
  const { host, port } = listenAddress(config);
  let s;
  try {
    s = await (await fetch(`http://${host}:${port}/switchboard/status`)).json();
  } catch (e) {
    process.stderr.write(`switchboard is not reachable on ${host}:${port} (${e.message}). Start it with \`switchboard serve\` or check \`switchboard doctor\`.\n`);
    return 1;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    return 0;
  }
  const lines = [
    `agents-switchboard on ${s.listen} · up ${s.uptimeSec}s · DeepSeek pricing now: ${s.peakNow ? 'peak' : 'off-peak'}`,
    `DeepSeek models: ${s.deepseekModels.join(', ')}`,
    `failover: ${s.failover.enabled ? `enabled → ${s.failover.model}` : 'disabled'}${s.failover.active ? ` · ACTIVE until ${s.failover.active}` : ''}`,
    '',
    'model                requests     input    cached    output  hit-ratio   est.USD',
  ];
  for (const [model, v] of Object.entries(s.models)) lines.push(row([[model, 20, 'left'], [v.requests, 8], [v.input, 9], [v.cached, 9], [v.output, 9], [v.cacheHitRatio, 10], [v.usd, 9]]));
  if (!Object.keys(s.models).length) lines.push('  (no requests yet)');
  lines.push('', 'role                 requests     input    cached  hit-ratio');
  for (const [role, v] of Object.entries(s.roles)) lines.push(row([[role, 20, 'left'], [v.requests, 8], [v.input, 9], [v.cached, 9], [v.cacheHitRatio, 10]]));
  lines.push('', 'upstream             last ok                    last error');
  for (const [name, v] of Object.entries(s.upstreams)) lines.push(`${name.padEnd(20)} ${String(v.lastOk ?? '-').padEnd(26)} ${v.lastError ?? '-'}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
