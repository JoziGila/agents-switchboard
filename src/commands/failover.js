// `switchboard failover on|off|reset`: toggle quota failover in the config and clear its live state.
import { loadConfig, saveConfig, listenAddress } from '../config.js';
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
        const r = await fetch(`http://${host}:${port}/switchboard/failover/reset`, { method: 'POST' });
        process.stdout.write(JSON.stringify(await r.json()) + '\n');
        return 0;
      } catch (e) {
        process.stderr.write(`router not reachable on ${host}:${port} (${e.message}); run \`switchboard doctor\`\n`);
        return 1;
      }
    }
    default:
      process.stderr.write('usage: switchboard failover on|off|reset\n');
      return 2;
  }
}
