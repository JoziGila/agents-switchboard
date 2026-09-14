import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';
import { DEFAULT_PORT, loadConfig, saveConfig, listenAddress } from '../config.js';
import { setSecret, keychainAvailable } from '../secrets.js';
import { installCodex, uninstallCodex } from './codex.js';
import { installClaude, uninstallClaude } from './claude.js';

const run = promisify(execFile);

async function version(bin, args = ['--version']) {
  try {
    const { stdout } = await run(bin, args, { timeout: 10_000 });
    const m = stdout.match(/(\d+\.\d+\.\d+[-\w.]*)/);
    return m ? m[1] : stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Which clients are installed on this machine.
 * @param {import('../paths.js').Paths} [paths]
 */
export async function detectClients(paths = resolvePaths(), env = process.env) {
  const codex = codexPresent(paths, env);
  const claude = claudePresent(paths, env);
  return {
    codex: { present: codex, home: paths.codexHome, ...(codex ? { version: await version('codex') } : {}) },
    claude: { present: claude, home: paths.claudeHome, ...(claude ? { version: await version('claude') } : {}) },
  };
}

/**
 * Configure the selected clients. Does not touch the login service (the CLI does that after this succeeds).
 * @param {{ codex?: boolean, claude?: boolean, port?: number, pro?: boolean, dryRun?: boolean, deepseekKey?: string, paths?: import('../paths.js').Paths }} opts
 */
export async function runInstall(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const detected = await detectClients(paths);
  const wantCodex = opts.codex ?? detected.codex.present;
  const wantClaude = opts.claude ?? detected.claude.present;
  const report = { detected, codex: null, claude: null, warnings: [], port: opts.port || DEFAULT_PORT, keyStored: false };

  if (!opts.dryRun) {
    const cfg = loadConfig(paths);
    if (opts.port) cfg.listen = `127.0.0.1:${opts.port}`;
    report.port = listenAddress(cfg).port;
    if (opts.deepseekKey) {
      if (keychainAvailable() && cfg.upstream.deepseek.api_key.keychain) {
        await setSecret(cfg.upstream.deepseek.api_key.keychain, opts.deepseekKey);
        report.keyStored = true;
      } else {
        report.warnings.push('No OS keychain available; set DEEPSEEK_API_KEY in the service environment and use api_key = { env = "DEEPSEEK_API_KEY" } in the switchboard config.');
      }
    }
    saveConfig(cfg, paths);
  }

  if (wantCodex) {
    if (!detected.codex.present) report.warnings.push('Codex not detected; configuring anyway.');
    report.codex = await installCodex({ paths, port: report.port, pro: opts.pro, dryRun: opts.dryRun });
  }
  if (wantClaude) {
    if (!detected.claude.present) report.warnings.push('Claude Code not detected; configuring anyway.');
    report.claude = await installClaude({ paths, port: report.port, pro: opts.pro, dryRun: opts.dryRun });
    report.warnings.push(...report.claude.warnings);
  }
  return report;
}

/**
 * Undo runInstall for the selected clients.
 * @param {{ codex?: boolean, claude?: boolean, paths?: import('../paths.js').Paths }} opts
 */
export async function runUninstall(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const report = { codex: null, claude: null };
  if (opts.codex ?? true) report.codex = await uninstallCodex({ paths });
  if (opts.claude ?? true) report.claude = await uninstallClaude({ paths });
  return report;
}
