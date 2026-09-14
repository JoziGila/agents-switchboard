// `switchboard failover on|off|reset`: toggle quota failover in the config and clear its live state.
import { loadConfig, redact, saveConfig, listenAddress, routerBaseUrl } from '../config.js';
import { restartService } from '../install/service.js';
import { resolvePaths } from '../paths.js';

/**
 * @param {{ _: string[] }} opts positional action
 * @returns {Promise<number>} exit code
 */
export async function failover(opts = { _: [] }) {
  const [action] = opts._;
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  switch (action) {
    case 'on':
    case 'off': {
      cfg.failover.enabled = action === 'on';
      saveConfig(cfg, paths);
      const restarted = await restartService().catch(() => false); // no service manager, or not installed yet
      process.stdout.write(`failover ${action} (fallback model ${cfg.failover.model}); ${restarted ? 'service restarted' : 'restart `switchboard serve` to apply'}\n`);
      return 0;
    }
    case 'reset': {
      const { host, port } = listenAddress(cfg);
      try {
        const r = await fetch(`${routerBaseUrl(cfg)}/switchboard/failover/reset`, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          process.stderr.write(`reset failed: HTTP ${r.status} from ${host}:${port}${body?.error?.message ? ` (${redact(body.error.message, cfg)})` : ''}; run \`switchboard doctor\`\n`);
          return 1;
        }
        process.stdout.write(JSON.stringify(body) + '\n');
        return 0;
      } catch (e) {
        process.stderr.write(`router not reachable or not configured on ${host}:${port} (${redact(e.message, cfg)}); run \`switchboard doctor\`\n`);
        return 1;
      }
    }
    default:
      process.stderr.write('usage: switchboard failover on|off|reset\n');
      return 2;
  }
}
