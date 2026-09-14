// Installer orchestration: detect clients, store the key, and run each client installer.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_PORT, loadConfig, saveConfig, listenAddress } from '../config.js';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';
import { setSecret, keychainAvailable } from '../secrets.js';
import { installClaude, uninstallClaude, readSettings, findConflicts as claudeConflicts, baseUrlFor as claudeUrl } from './claude.js';
import { installCodex, uninstallCodex, stripManaged, findConflicts as codexConflicts, inlineTablesIn, baseUrlFor as codexUrl } from './codex.js';
import { readState, readTextOr } from './files.js';
import path from 'node:path';
import { parse } from 'smol-toml';

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
 * @param {{ codex: boolean, claude: boolean, port: number, paths: import('../paths.js').Paths }} opts
 */
export function preflight({ codex, claude, port, paths }) {
  if (codex) {
    const text = readTextOr(path.join(paths.codexHome, 'config.toml'));
    const clean = stripManaged(text);
    let parsed = {};
    try { parsed = clean.trim() ? parse(clean) : {}; } catch (e) { throw new Error(`${path.join(paths.codexHome, 'config.toml')} is not valid TOML (${e.message}); fix it and re-run.`); }
    const conflicts = codexConflicts(parsed, codexUrl(port), inlineTablesIn(clean));
    if (conflicts.length) throw new Error(`config.toml has settings the switchboard cannot coexist with: ${conflicts.join(', ')}. Remove them (or move them to a profile you do not use with the switchboard) and re-run.`);
  }
  if (claude) {
    const settings = readSettings(path.join(paths.claudeHome, 'settings.json'));
    const conflicts = claudeConflicts(settings, claudeUrl(port), readState(paths.stateFile).claude || {});
    if (conflicts.length) throw new Error(`settings.json has settings the switchboard cannot coexist with: ${conflicts.join(', ')}. Remove them (they would bypass the router or bill an API key instead of your subscription) and re-run.`);
  }
}

/**
 * Configure the selected clients. Does not touch the login service; the CLI brings the router up first.
 * @param {{ codex?: boolean, claude?: boolean, port?: number, pro?: boolean, dryRun?: boolean, deepseekKey?: string, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ detected: object, codex: object|null, claude: object|null, warnings: string[], port: number, keyStored: boolean }>}
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
        report.warnings.push(`No OS keychain available; set DEEPSEEK_API_KEY in the service environment and use api_key = { env = "DEEPSEEK_API_KEY" } in ${paths.configFile}.`);
      }
    }
    saveConfig(cfg, paths);
  }

  if (wantCodex) {
    if (!detected.codex.present) report.warnings.push('Codex not detected; configuring anyway.');
    report.codex = await installCodex({ paths, port: report.port, pro: opts.pro, dryRun: opts.dryRun });
    report.warnings.push(...report.codex.warnings);
  }
  if (wantClaude) {
    if (!detected.claude.present) report.warnings.push('Claude Code not detected; configuring anyway.');
    report.claude = await installClaude({ paths, port: report.port, pro: opts.pro, dryRun: opts.dryRun });
    report.warnings.push(...report.claude.warnings);
  }
  return report;
}

/**
 * Undo runInstall for the selected clients (both by default).
 * @param {{ codex?: boolean, claude?: boolean, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ codex: object|null, claude: object|null }>}
 */
export async function runUninstall(opts = {}) {
  const paths = opts.paths || resolvePaths();
  return {
    codex: (opts.codex ?? true) ? await uninstallCodex({ paths }) : null,
    claude: (opts.claude ?? true) ? await uninstallClaude({ paths }) : null,
  };
}
