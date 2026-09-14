import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInstall, runUninstall, detectClients, preflight } from '../install/index.js';
import { installService, uninstallService } from '../install/service.js';
import { resolvePaths } from '../paths.js';
import { ensureAccessToken, loadConfig, redact, saveConfig, listenAddress, resolveProviderKey, PROVIDER_KEY_ENV, routerBaseUrl } from '../config.js';
import { setSecret, deleteSecret, keychainAvailable } from '../secrets.js';
import { probeProvider } from '../adapters/probe.js';
import { buildProviders } from '../providers.js';

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

const HEALTH_TIMEOUT_MS = 30_000;
async function waitHealthy(host, port, ms = HEALTH_TIMEOUT_MS) {
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

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/** Prove a client can complete a real turn through the router without modifying client config. */
async function verifyClient(client, cfg) {
  const base = routerBaseUrl(cfg);
  if (client === 'claude') {
    const dir = makeTempDir('switchboard-claude-verify-');
    const settings = path.join(dir, 'settings.json');
    try {
      writePrivate(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${base}/anthropic` } }, null, 2) + '\n');
      const r = await runQuiet('claude', ['--setting-sources', '', '--settings', settings, '-p', 'Reply with the single word OK.', '--model', 'haiku'], { ANTHROPIC_BASE_URL: `${base}/anthropic` }, 120_000);
      return { ok: r.code === 0 && /\bOK\b/.test(r.output), output: redact(r.output, cfg) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = makeTempDir('switchboard-codex-verify-');
  try {
    writePrivate(path.join(dir, 'config.toml'), `openai_base_url = "${base}/backend-api/codex"\nmodel_reasoning_effort = "low"\n`);
    const authFile = path.join(resolvePaths().codexHome, 'auth.json');
    if (fs.existsSync(authFile)) fs.symlinkSync(authFile, path.join(dir, 'auth.json'));
    const r = await runQuiet('codex', ['exec', '--skip-git-repo-check', '-C', process.cwd(), '--ephemeral', '--model', 'gpt-5.5', 'Reply with the single word OK.'], { CODEX_HOME: dir }, 180_000);
    return { ok: r.code === 0 && /\bOK\b/.test(r.output), output: redact(r.output, cfg) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    out(redact(`${name}: responses ${probe.responses.ok ? 'ok' : `FAILED (${probe.responses.error})`} · messages ${probe.messages.ok ? 'ok' : `FAILED (${probe.messages.error})`}`, cfg, key));
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
  const previous = loadConfig(paths);
  const minted = !previous.access_token;
  const cfg = ensureAccessToken(structuredClone(previous));
  if (opts.port) cfg.listen = `127.0.0.1:${Number(opts.port)}`;
  const { host, port } = listenAddress(cfg);
  const keys = await collectProviderKeys(cfg, opts);
  if (opts['dry-run']) {
    const report = await runInstall({ codex: wantCodex, claude: wantClaude, port, token: cfg.access_token, pro: !!opts.pro, dryRun: true, paths });
    for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
    out('dry run: nothing written.'); return 0;
  }
  if (keys.abort) return 1;
  // Refuse early: a conflict in either client aborts before the config, the key store or the service are touched.
  try { preflight({ codex: wantCodex, claude: wantClaude, port, token: cfg.access_token, paths }); }
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
  const svcOpts = { nodePath: process.execPath, entryPath, logFile: path.join(paths.switchboardHome, 'service.log'), env: serviceEnv };
  const svc = await installService(svcOpts);
  out(`service: ${svc.kind}${svc.file ? ` (${svc.file})` : ''}`);
  // A freshly minted token that the not-yet-reconfigured clients do not send would 400 every request:
  // put the previous config back, so the running router and the clients pointing at it stay in step.
  const rollback = async () => {
    saveConfig(previous, paths);
    const prev = listenAddress(previous);
    await installService(svcOpts);
    const ok = await waitHealthy(prev.host, prev.port);
    out(ok ? 'Restored the router to its previous configuration; existing client sessions are unaffected.'
      : `The previous configuration did not come up on http://${prev.host}:${prev.port}; check ${path.join(paths.switchboardHome, 'service.log')}.`);
  };
  if (!(await waitHealthy(host, port))) {
    if (minted) await rollback();
    out(`The router did not come up on ${host}:${port} within ${HEALTH_TIMEOUT_MS / 1000} s. No client configuration was changed. Check ${path.join(paths.switchboardHome, 'service.log')}.`);
    return 1;
  }
  out(`router healthy on http://${host}:${port}`);

  // 3. Prove each client can complete a real turn through the router using private temporary overrides. Still no client config modified.
  const verified = {};
  if (!opts['skip-verify']) {
    for (const [client, wanted] of [['claude', wantClaude], ['codex', wantCodex]]) {
      if (!wanted) continue;
      out(`verifying ${client} through the router…`);
      const v = await verifyClient(client, cfg);
      verified[client] = v.ok;
      out(`${client}: ${v.ok ? 'round trip OK' : 'FAILED'}`);
      if (!v.ok) { out(v.output.split('\n').slice(-8).join('\n')); }
    }
    if (Object.values(verified).some((ok) => !ok) && !opts.force) {
      if (minted) await rollback();
      out('A client could not complete a turn through the router, so no client configuration was changed. Fix the cause (see `switchboard doctor`) or pass --force.');
      return 1;
    }
  }

  // 4. Now, and only now, point the clients at the router.
  const report = await runInstall({ codex: wantCodex, claude: wantClaude, port, token: cfg.access_token, pro: !!opts.pro, paths });
  for (const c of ['codex', 'claude']) if (report[c]) out(`${c}: ${summarize(report[c])}`);
  for (const w of report.warnings) out(`warning: ${w}`);
  out(minted
    ? '\nDone. The router now requires the local access token, so restart every open Codex and Claude Code session once; new sessions go through the router.'
    : '\nDone. Sessions already open keep their old connection; new Codex and Claude Code sessions go through the router. Restart the desktop apps once so they refetch models.');
  // The install itself succeeded; doctor's connectivity probes are informational and do not turn that into a failure.
  const { doctor } = await import('./doctor.js');
  const health = await doctor({ quiet: true, report: true });
  return health.failed.some((r) => !r.connectivity) ? 1 : 0;
}

export async function uninstall(opts) {
  const paths = resolvePaths();
  // Clients first, so nothing points at a router that is about to stop.
  let report;
  try { report = await runUninstall({ paths }); }
  catch (e) {
    // A client config we cannot restore exactly (e.g. state.json lost). Both reverts were still attempted,
    // so `e.message` names what came back and what did not; stop before the service goes away so nothing
    // is left pointing at a router that is gone, and the user gets one actionable line not a stack trace.
    out(e.message);
    return 1;
  }
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
