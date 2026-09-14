import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runInstall, runUninstall, detectClients } from '../install/index.js';
import { installService, uninstallService } from '../install/service.js';
import { resolvePaths } from '../paths.js';
import { loadConfig, resolveDeepSeekKey } from '../config.js';
import { getSecret, deleteSecret, keychainAvailable } from '../secrets.js';
import { probeDeepSeek } from '../deepseek-probe.js';

const entryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'switchboard.js');

function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onKey = () => {};
    process.stdout.write(question);
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
    rl._writeToOutput = onKey; // hide echo
  });
}

export async function install(opts) {
  const paths = resolvePaths();
  const detected = await detectClients(paths);
  const selectCodex = opts.codex ? true : opts.claude ? false : undefined;
  const selectClaude = opts.claude ? true : opts.codex ? false : undefined;
  const out = (s) => process.stdout.write(s + '\n');
  out(`Codex: ${detected.codex.present ? `found${detected.codex.version ? ` (${detected.codex.version})` : ''}` : 'not found'}   Claude Code: ${detected.claude.present ? `found${detected.claude.version ? ` (${detected.claude.version})` : ''}` : 'not found'}`);
  if (!detected.codex.present && !detected.claude.present && !opts.codex && !opts.claude) { out('Neither client detected. Install Codex or Claude Code first, or pass --codex / --claude to configure anyway.'); return 1; }

  // DeepSeek key: --key, env, existing keychain entry, or prompt.
  const cfg = loadConfig(paths);
  let key = opts.key || process.env.DEEPSEEK_API_KEY || (await resolveDeepSeekKey(cfg));
  if (!key && !opts['dry-run']) {
    key = await askHidden('DeepSeek API key (from platform.deepseek.com, hidden; leave empty to add later): ');
  }
  let probe = null;
  if (key) {
    probe = await probeDeepSeek(key, cfg.upstream.deepseek.base_url);
    out(`DeepSeek: responses ${probe.responses.ok ? 'ok' : `FAILED (${probe.responses.error})`} · messages ${probe.messages.ok ? 'ok' : `FAILED (${probe.messages.error})`}`);
    if (!probe.responses.ok && !probe.messages.ok && !opts.force) { out('Key rejected on both dialects; not installing. Re-run with --force to install anyway.'); return 1; }
  } else out('No DeepSeek key yet: routing is installed, DeepSeek-bound requests will fail with a clear message until you run `switchboard install` again with a key.');

  const report = await runInstall({ codex: selectCodex, claude: selectClaude, port: opts.port ? Number(opts.port) : undefined, pro: !!opts.pro, dryRun: !!opts['dry-run'], deepseekKey: key && !(await getSecret(cfg.upstream.deepseek.api_key?.keychain ?? '')) ? key : undefined, paths });
  for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
  for (const w of report.warnings) out(`warning: ${w}`);
  if (opts['dry-run']) { out('dry run: nothing written.'); return 0; }
  if (key && !keychainAvailable()) out('warning: no OS keychain; put DEEPSEEK_API_KEY in the service environment and set api_key = { env = "DEEPSEEK_API_KEY" } in ' + paths.configFile);

  if (!opts['no-service']) {
    const svc = await installService({ nodePath: process.execPath, entryPath, logFile: path.join(paths.switchboardHome, 'service.log') });
    out(`service: ${svc.installed ? 'installed' : 'not installed'}${svc.running ? ', running' : ''}${svc.note ? ` (${svc.note})` : ''}`);
  }
  out('\nRestart the Codex and Claude Code apps once so they reload their config and refetch models. Then run `switchboard doctor`.');
  const { doctor } = await import('./doctor.js');
  return doctor({ quiet: true });
}

export async function uninstall(opts) {
  const paths = resolvePaths();
  const report = await runUninstall({ paths });
  for (const c of ['codex', 'claude']) if (report[c]) process.stdout.write(`${c}: ${summarize(report[c])}\n`);
  const svc = await uninstallService();
  process.stdout.write(`service: ${svc.removed ? 'removed' : 'not installed'}\n`);
  if (opts.purge) {
    const cfg = loadConfig(paths);
    if (cfg.upstream.deepseek.api_key?.keychain) await deleteSecret(cfg.upstream.deepseek.api_key.keychain);
    fs.rmSync(paths.switchboardHome, { recursive: true, force: true });
    process.stdout.write('purged switchboard home and keychain entry\n');
  }
  return 0;
}

function summarize(r) {
  if (!r) return 'skipped';
  if (typeof r === 'string') return r;
  const parts = [];
  for (const [k, v] of Object.entries(r)) if (k !== 'warnings' && v !== undefined && v !== null) parts.push(`${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v}`);
  return parts.join(' ');
}
