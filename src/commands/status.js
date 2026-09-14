export async function status(opts) {
  const { loadConfig, listenAddress } = await import('../config.js');
  const config = loadConfig();
  if (opts.port) config.listen = `127.0.0.1:${opts.port}`;
  const { host, port } = listenAddress(config);
  let j;
  try { j = await (await fetch(`http://${host}:${port}/switchboard/status`)).json(); }
  catch (e) { process.stderr.write(`switchboard is not reachable on ${host}:${port} (${e.message}). Start it with \`switchboard serve\` or check \`switchboard doctor\`.\n`); return 1; }
  if (opts.json) { process.stdout.write(JSON.stringify(j, null, 2) + '\n'); return 0; }
  const fmt = (n) => (n == null ? '-' : typeof n === 'number' && !Number.isInteger(n) ? n.toFixed(4) : String(n));
  const lines = [`agents-switchboard on ${j.listen} · up ${j.uptimeSec}s · DeepSeek pricing now: ${j.peakNow ? 'peak' : 'off-peak'}`, `DeepSeek models: ${j.deepseekModels.join(', ')}`, `failover: ${j.failover.enabled ? `enabled → ${j.failover.model}` : 'disabled'}${j.failover.active ? ` · ACTIVE until ${j.failover.active}` : ''}`, ''];
  lines.push('model                requests     input    cached    output  hit-ratio   est.USD');
  for (const [m, v] of Object.entries(j.models)) lines.push(`${m.padEnd(20)} ${fmt(v.requests).padStart(8)} ${fmt(v.input).padStart(9)} ${fmt(v.cached).padStart(9)} ${fmt(v.output).padStart(9)} ${fmt(v.cacheHitRatio).padStart(10)} ${fmt(v.usd).padStart(9)}`);
  if (!Object.keys(j.models).length) lines.push('  (no requests yet)');
  lines.push('', 'role                 requests     input    cached  hit-ratio');
  for (const [r, v] of Object.entries(j.roles)) lines.push(`${r.padEnd(20)} ${fmt(v.requests).padStart(8)} ${fmt(v.input).padStart(9)} ${fmt(v.cached).padStart(9)} ${fmt(v.cacheHitRatio).padStart(10)}`);
  lines.push('', 'upstream             last ok                    last error');
  for (const [u, v] of Object.entries(j.upstreams)) lines.push(`${u.padEnd(20)} ${String(v.lastOk ?? '-').padEnd(26)} ${v.lastError ?? '-'}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
