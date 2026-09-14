import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInstall, runUninstall, detectClients, preflight } from '../install/index.js';
import { installService, uninstallService } from '../install/service.js';
import { resolvePaths } from '../paths.js';
import { loadConfig, saveConfig, listenAddress, resolveProviderKey, PROVIDER_KEY_ENV } from '../config.js';
import { setSecret, deleteSecret, keychainAvailable } from '../secrets.js';
import { probeProvider } from '../adapters/probe.js';
import { buildProviders } from '../providers.js';
import { baseUrlFor as codexUrl } from '../install/codex.js';
import { baseUrlFor as claudeUrl } from '../install/claude.js';

const entryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'switchboard.js');
const out = (s) => process.stdout.write(s + '\n');

/** Prompt on the terminal without echoing the typed characters. Resolves '' when stdin is not a TTY. */
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(question);
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
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

/**
 * DeepSeek is required for the default roles; OpenRouter is optional. Each key comes from a flag, the
 * env, an existing keychain entry, or a hidden prompt, and is probed on both dialects before use.
 */
async function collectProviderKeys(cfg, opts) {
  const result = { store: {}, abort: false };
  const providers = buildProviders(cfg, async () => null);
  for (const provider of providers) {
    const name = provider.name;
    const section = cfg.upstream[name];
    const existing = await resolveProviderKey(section, PROVIDER_KEY_ENV[name]);
    let key = opts[`${name}-key`] || (name === 'deepseek' ? opts.key : undefined) || process.env[PROVIDER_KEY_ENV[name]] || existing;
    if (!key && !opts['dry-run']) key = await askHidden(`${name === 'deepseek' ? 'DeepSeek' : 'OpenRouter'} API key (${name === 'deepseek' ? 'platform.deepseek.com' : 'openrouter.ai/keys, optional'}; hidden; leave empty to skip): `);
    if (!key) { out(`${name}: no key${name === 'deepseek' ? '; DeepSeek-bound requests will fail with a clear message until you add one' : '; OpenRouter routing stays available once you add one'}.`); continue; }
    const probe = await probeProvider(provider, key);
    out(`${name}: responses ${probe.responses.ok ? 'ok' : `FAILED (${probe.responses.error})`} · messages ${probe.messages.ok ? 'ok' : `FAILED (${probe.messages.error})`}`);
    if (!probe.responses.ok && !probe.messages.ok && !opts.force) { out(`${name} key rejected on both dialects; not installing. Fix the key or pass --force.`); result.abort = true; }
    if (key !== existing) result.store[name] = key;
  }
  return result;
}

export async function install(opts) {
  const paths = resolvePaths();
  const detected = await detectClients(paths);
  const wantCodex = opts.codex ? true : opts.claude ? false : detected.codex.present;
  const wantClaude = opts.claude ? true : opts.codex ? false : detected.claude.present;
  out(`Codex: ${detected.codex.present ? `found${detected.codex.version ? ` (${detected.codex.version})` : ''}` : 'not found'}   Claude Code: ${detected.claude.present ? `found${detected.claude.version ? ` (${detected.claude.version})` : ''}` : 'not found'}`);
  if (!wantCodex && !wantClaude) { out('Neither client detected. Install Codex or Claude Code first, or pass --codex / --claude.'); return 1; }

  // 1. Switchboard config and provider keys. Nothing client-facing is touched yet.
  const cfg = loadConfig(paths);
  if (opts.port) cfg.listen = `127.0.0.1:${Number(opts.port)}`;
  const { host, port } = listenAddress(cfg);
  const keys = await collectProviderKeys(cfg, opts);
  if (opts['dry-run']) {
    const report = await runInstall({ codex: wantCodex, claude: wantClaude, port, pro: !!opts.pro, dryRun: true, paths });
    for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
    out('dry run: nothing written.'); return 0;
  }
  if (keys.abort) return 1;
  // Refuse early: a conflict in either client aborts before the config, the key store or the service are touched.
  try { preflight({ codex: wantCodex, claude: wantClaude, port, paths }); }
  catch (e) { out(e.message); out('Nothing was changed.'); return 1; }

  // Without a keychain the key rides in the service definition's environment (user-only file, never printed).
  const serviceEnv = {};
  for (const [name, key] of Object.entries(keys.store)) {
    const section = cfg.upstream[name];
    if (keychainAvailable() && section.api_key?.keychain) { await setSecret(section.api_key.keychain, key); out(`${name} key stored in the OS keychain.`); }
    else {
      section.api_key = { env: PROVIDER_KEY_ENV[name] };
      serviceEnv[PROVIDER_KEY_ENV[name]] = key;
      out(`${name}: no OS keychain on this machine; the key is kept in the service definition's environment (${PROVIDER_KEY_ENV[name]}) and the switchboard config now reads it from there.`);
    }
  }
  saveConfig(cfg, paths);

  // 2. The router must be running and healthy before any client is pointed at it.
  const svc = await installService({ nodePath: process.execPath, entryPath, logFile: path.join(paths.switchboardHome, 'service.log'), env: serviceEnv });
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
  // The install itself succeeded; doctor's connectivity probes are informational and do not turn that into a failure.
  const { doctor } = await import('./doctor.js');
  const health = await doctor({ quiet: true, report: true });
  return health.failed.some((r) => !r.connectivity) ? 1 : 0;
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
    for (const [name, section] of Object.entries(cfg.upstream)) {
      if (section.api_key?.keychain && (await deleteSecret(section.api_key.keychain))) out(`removed ${name} key from the OS keychain`);
    }
    fs.rmSync(paths.switchboardHome, { recursive: true, force: true });
    out('purged switchboard home');
  }
  out('Sessions already open keep the router connection until restarted.');
  return 0;
}

function summarize(r) {
  if (!r) return 'skipped';
  if (typeof r === 'string') return r;
  return Object.entries(r).filter(([k, v]) => k !== 'warnings' && v != null).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}
