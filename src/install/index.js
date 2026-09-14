// Installer orchestration: detect clients, store the key, and run each client installer.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_PORT, baseUrlFor, ensureAccessToken, loadConfig, saveConfig, listenAddress } from '../config.js';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';
import { installClaude, uninstallClaude, readSettings, findConflicts as claudeConflicts } from './claude.js';
import { installCodex, uninstallCodex, applyCodexConfig } from './codex.js';
import { readState, readTextOr } from './files.js';
import path from 'node:path';

const run = promisify(execFile);

/** `x.y.z` from a client's `--version` output, or undefined when the binary cannot be run. */
async function clientVersion(bin) {
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 10_000 });
    return stdout.match(/(\d+\.\d+\.\d+[-\w.]*)/)?.[1] ?? stdout.trim();
  } catch {
    // Present on disk but not runnable from here (broken shim, PATH differences): version stays unknown.
    return undefined;
  }
}

/**
 * Which clients are installed on this machine, with versions when obtainable.
 * @param {import('../paths.js').Paths} [paths]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ codex: { present: boolean, home: string, version?: string }, claude: { present: boolean, home: string, version?: string } }>}
 */
export async function detectClients(paths = resolvePaths(), env = process.env) {
  const codex = codexPresent(paths, env);
  const claude = claudePresent(paths, env);
  return {
    codex: { present: codex, home: paths.codexHome, ...(codex ? { version: await clientVersion('codex') } : {}) },
    claude: { present: claude, home: paths.claudeHome, ...(claude ? { version: await clientVersion('claude') } : {}) },
  };
}

/**
 * Check both clients' configs for anything the installer would refuse, before anything is mutated.
 * Throws the same messages the installers would, so a Claude-side conflict aborts with Codex untouched.
 * @param {{ codex: boolean, claude: boolean, port: number, token?: string, paths: import('../paths.js').Paths }} opts
 */
export function preflight({ codex, claude, port, token, paths }) {
  if (codex) {
    // Run the writer's own pure operation: it is the single validity authority, so preflight catches
    // exactly what the write would (including a misplaced [agents] or a marker inside a multiline string).
    const file = path.join(paths.codexHome, 'config.toml');
    try { applyCodexConfig(readTextOr(file), port, { token }); }
    catch (e) { throw new Error(e.message.replace(/^config\.toml/, file)); }
  }
  if (claude) {
    const settings = readSettings(path.join(paths.claudeHome, 'settings.json'));
    const conflicts = claudeConflicts(settings, baseUrlFor(port, token, '/anthropic'), readState(paths.stateFile).claude || {});
    if (conflicts.length) throw new Error(`settings.json has settings the switchboard cannot coexist with: ${conflicts.join(', ')}. Remove them (they would bypass the router or bill an API key instead of your subscription) and re-run.`);
  }
}

/**
 * Configure the selected clients. Does not touch the login service; the CLI brings the router up first.
 * @param {{ codex?: boolean, claude?: boolean, port?: number, token?: string, pro?: boolean, dryRun?: boolean, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ codex: object|null, claude: object|null, warnings: string[], port: number }>}
 */
export async function runInstall(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const detected = await detectClients(paths);
  const wantCodex = opts.codex ?? detected.codex.present;
  const wantClaude = opts.claude ?? detected.claude.present;
  const report = { codex: null, claude: null, warnings: [], port: opts.port || DEFAULT_PORT };
  let clientToken = opts.token;
  if (opts.dryRun) {
    const cfg = loadConfig(paths);
    if (!opts.port) report.port = listenAddress(cfg).port;
    clientToken ??= cfg.access_token ?? 'dry-run-token';
  }

  if (!opts.dryRun) {
    const cfg = loadConfig(paths);
    if (opts.port) cfg.listen = `127.0.0.1:${opts.port}`;
    if (opts.token && !cfg.access_token) cfg.access_token = opts.token;
    ensureAccessToken(cfg);
    clientToken = cfg.access_token;
    report.port = listenAddress(cfg).port;
    saveConfig(cfg, paths);
  }

  if (wantCodex) {
    if (!detected.codex.present) report.warnings.push('Codex not detected; configuring anyway.');
    report.codex = await installCodex({ paths, port: report.port, token: clientToken, pro: opts.pro, dryRun: opts.dryRun });
    report.warnings.push(...report.codex.warnings);
  }
  if (wantClaude) {
    if (!detected.claude.present) report.warnings.push('Claude Code not detected; configuring anyway.');
    report.claude = await installClaude({ paths, port: report.port, token: clientToken, pro: opts.pro, dryRun: opts.dryRun });
    report.warnings.push(...report.claude.warnings);
  }
  return report;
}

/**
 * Undo runInstall for the selected clients (both by default). Every selected revert is attempted even when
 * an earlier one throws, so a Claude-side failure cannot claim a Codex revert that already happened did not
 * (nor leave it unreported): the thrown message is the per-client outcome line, e.g.
 * `codex: restored · claude: FAILED — <reason>`.
 * @param {{ codex?: boolean, claude?: boolean, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ codex: object|null, claude: object|null }>}
 * @throws {Error} after both reverts were attempted, when any of them failed
 */
export async function runUninstall(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const report = { codex: null, claude: null };
  const outcome = {};
  for (const [client, revert] of [['codex', uninstallCodex], ['claude', uninstallClaude]]) {
    if (!(opts[client] ?? true)) { outcome[client] = 'skipped'; continue; }
    try { report[client] = await revert({ paths }); outcome[client] = 'restored'; }
    catch (e) { outcome[client] = `FAILED — ${e.message}`; }
  }
  if (Object.values(outcome).some((o) => o.startsWith('FAILED'))) {
    throw new Error(`${Object.entries(outcome).map(([c, o]) => `${c}: ${o}`).join(' · ')}\nThe router is still running; fix the client above and re-run \`switchboard uninstall\`.`);
  }
  return report;
}
