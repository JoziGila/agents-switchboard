import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInstall, runUninstall, detectClients } from '../install/index.js';
import { installService, uninstallService, serviceStatus } from '../install/service.js';
import { resolvePaths } from '../paths.js';
import { loadConfig, saveConfig, listenAddress, resolveDeepSeekKey } from '../config.js';
import { setSecret, deleteSecret, keychainAvailable } from '../secrets.js';
import { probeDeepSeek } from '../deepseek-probe.js';
import { baseUrlFor as codexUrl } from '../install/codex.js';
import { baseUrlFor as claudeUrl } from '../install/claude.js';

const entryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'switchboard.js');
const out = (s) => process.stdout.write(s + '\n');

function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

async function waitHealthy(host, port, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://${host}:${port}/switchboard/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function runQuiet(cmd, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let output = ''; child.stdout.on('data', (d) => (output += d)); child.stderr.on('data', (d) => (output += d));
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, output }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, output: e.message }); });
  });
}

/** Prove a client can complete a real turn through the router using only an env/flag override. Nothing is written. */
async function verifyClient(client, port) {
  if (client === 'claude') {
    const r = await runQuiet('claude', ['-p', 'Reply with the single word OK.', '--model', 'haiku'], { ANTHROPIC_BASE_URL: claudeUrl(port) }, 120_000);
    return { ok: r.code === 0 && /\bOK\b/.test(r.output), output: r.output };
  }
  const r = await runQuiet('codex', ['exec', '--skip-git-repo-check', '-C', process.cwd(), '-c', `openai_base_url="${codexUrl(port)}"`, '-c', 'model_reasoning_effort="low"', 'Reply with the single word OK.'], {}, 180_000);
  return { ok: r.code === 0 && /\bOK\b/.test(r.output), output: r.output };
}

export async function install(opts) {
  const paths = resolvePaths();
  const detected = await detectClients(paths);
  const wantCodex = opts.codex ? true : opts.claude ? false : detected.codex.present;
  const wantClaude = opts.claude ? true : opts.codex ? false : detected.claude.present;
  out(`Codex: ${detected.codex.present ? `found${detected.codex.version ? ` (${detected.codex.version})` : ''}` : 'not found'}   Claude Code: ${detected.claude.present ? `found${detected.claude.version ? ` (${detected.claude.version})` : ''}` : 'not found'}`);
  if (!wantCodex && !wantClaude) { out('Neither client detected. Install Codex or Claude Code first, or pass --codex / --claude.'); return 1; }

  // 1. Switchboard config and key. Nothing client-facing is touched yet.
  const cfg = loadConfig(paths);
  if (opts.port) cfg.listen = `127.0.0.1:${Number(opts.port)}`;
  const { host, port } = listenAddress(cfg);
  let key = opts.key || process.env.DEEPSEEK_API_KEY || (await resolveDeepSeekKey(cfg));
  if (!key && !opts['dry-run']) key = await askHidden('DeepSeek API key (from platform.deepseek.com, hidden; leave empty to add later): ');
  if (key) {
    const probe = await probeDeepSeek(key, cfg.upstream.deepseek.base_url);
    out(`DeepSeek: responses ${probe.responses.ok ? 'ok' : `FAILED (${probe.responses.error})`} · messages ${probe.messages.ok ? 'ok' : `FAILED (${probe.messages.error})`}`);
    if (!probe.responses.ok && !probe.messages.ok && !opts.force) { out('Key rejected on both dialects; not installing. Re-run with --force to install anyway.'); return 1; }
  } else out('No DeepSeek key yet: DeepSeek-bound requests will fail with a clear message until you run `switchboard install` again with a key.');
  if (opts['dry-run']) {
    const report = await runInstall({ codex: wantCodex, claude: wantClaude, port, pro: !!opts.pro, dryRun: true, paths });
    for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
    out('dry run: nothing written.'); return 0;
  }
  saveConfig(cfg, paths);
  if (key && key !== (await resolveDeepSeekKey(cfg))) {
    if (keychainAvailable() && cfg.upstream.deepseek.api_key?.keychain) { await setSecret(cfg.upstream.deepseek.api_key.keychain, key); out('DeepSeek key stored in the OS keychain.'); }
    else out(`warning: no OS keychain; put DEEPSEEK_API_KEY in the service environment and set api_key = { env = "DEEPSEEK_API_KEY" } in ${paths.configFile}`);
  }

  // 2. The router must be running and healthy before any client is pointed at it.
  const svc = await installService({ nodePath: process.execPath, entryPath, logFile: path.join(paths.switchboardHome, 'service.log') });
  out(`service: ${svc.kind}${svc.file ? ` (${svc.file})` : ''}`);
  if (!(await waitHealthy(host, port))) {
    out(`The router did not come up on ${host}:${port} within 15 s. No client configuration was changed. Check ${path.join(paths.switchboardHome, 'service.log')}.`);
    return 1;
  }
  out(`router healthy on http://${host}:${port}`);

  // 3. Prove each client can complete a real turn through the router, using only an override. Still nothing written.
  const verified = {};
  if (!opts['skip-verify']) {
    for (const [client, wanted] of [['claude', wantClaude], ['codex', wantCodex]]) {
      if (!wanted) continue;
      out(`verifying ${client} through the router…`);
      const v = await verifyClient(client, port);
      verified[client] = v.ok;
      out(`${client}: ${v.ok ? 'round trip OK' : 'FAILED'}`);
      if (!v.ok) { out(v.output.split('\n').slice(-8).join('\n')); }
    }
    if (Object.values(verified).some((ok) => !ok) && !opts.force) { out('A client could not complete a turn through the router, so no client configuration was changed. Fix the cause (see `switchboard doctor`) or pass --force.'); return 1; }
  }

  // 4. Now, and only now, point the clients at the router.
  const report = await runInstall({ codex: wantCodex, claude: wantClaude, port, pro: !!opts.pro, paths });
  for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
  for (const w of report.warnings) out(`warning: ${w}`);
  out('\nDone. Sessions already open keep their old connection; new Codex and Claude Code sessions go through the router. Restart the desktop apps once so they refetch models.');
  const { doctor } = await import('./doctor.js');
  return doctor({ quiet: true });
}

export async function uninstall(opts) {
  const paths = resolvePaths();
  // Clients first, so nothing points at a router that is about to stop.
  const report = await runUninstall({ paths });
  for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
  const svc = await uninstallService();
  out(`service: ${svc.removed ? 'removed' : 'not installed'}`);
  if (opts.purge) {
    const cfg = loadConfig(paths);
    if (cfg.upstream.deepseek.api_key?.keychain) await deleteSecret(cfg.upstream.deepseek.api_key.keychain);
    fs.rmSync(paths.switchboardHome, { recursive: true, force: true });
    out('purged switchboard home and keychain entry');
  }
  out('Sessions already open keep the router connection until restarted.');
  return 0;
}

function summarize(r) {
  if (!r) return 'skipped';
  if (typeof r === 'string') return r;
  return Object.entries(r).filter(([k, v]) => k !== 'warnings' && v != null).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}
