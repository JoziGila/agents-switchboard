import { resolvePaths } from '../paths.js';
import { loadConfig, saveConfig, listenAddress } from '../config.js';

export async function failover(opts = {}) {
  const [action] = opts._;
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  if (action === 'on' || action === 'off') {
    cfg.failover.enabled = action === 'on';
    saveConfig(cfg, paths);
    process.stdout.write(`failover ${action} (fallback model ${cfg.failover.model}). Restart the service to apply: switchboard install --no-service is not needed; run \`switchboard serve\` or restart the login service.\n`);
    return 0;
  }
  if (action === 'reset') {
    const { host, port } = listenAddress(cfg);
    try { const r = await fetch(`http://${host}:${port}/switchboard/failover/reset`, { method: 'POST' }); process.stdout.write(JSON.stringify(await r.json()) + '\n'); return 0; }
    catch (e) { process.stderr.write(`router not reachable: ${e.message}\n`); return 1; }
  }
  process.stderr.write('usage: switchboard failover on|off|reset\n');
  return 2;
}
