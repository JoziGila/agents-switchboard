// `switchboard doctor`: a data-driven list of health checks with one line of output each.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { probeProvider } from '../adapters/probe.js';
import { buildProviders } from '../providers.js';
import { loadConfig, listenAddress, resolveProviderKey, PROVIDER_KEY_ENV, routerBaseUrl, redact } from '../config.js';
import { detectClients } from '../install/index.js';
import { ROLE_NAMES, CLAUDE_ROLE_NAMES } from '../install/roles.js';
import { serviceStatus } from '../install/service.js';
import { resolvePaths } from '../paths.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
const HEALTH_TIMEOUT_MS = 2000;
const REACH_TIMEOUT_MS = 5000;

/** `a >= b` on the first three dotted numeric components. */
export function semverGte(a, b) {
  const parts = (v) => String(v).replace(/^v/, '').split(/[.-]/).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) > (y[i] || 0)) return true;
    if ((x[i] || 0) < (y[i] || 0)) return false;
  }
  return true;
}

/**
 * The bounds of one of the `>=X.Y.Z <A.B.C` ranges the package declares; the upper bound is optional.
 * @param {string} range
 * @returns {{ min: string, max: string|null }}
 * @throws {Error} when the range is not of that shape
 */
export function rangeBounds(range) {
  const m = /^>=\s*(\S+)(?:\s+<(\S+))?$/.exec(String(range ?? '').trim());
  if (!m) throw new Error(`package.json declares a version range this check cannot read: ${range}`);
  return { min: m[1], max: m[2] ?? null };
}

/** Whether `version` sits inside `range`; an absent version passes, so an unrunnable binary is not a failure. */
export function versionInRange(version, range) {
  if (!version) return true;
  const { min, max } = rangeBounds(range);
  return semverGte(version, min) && !(max && semverGte(version, max));
}

/**
 * The verdict of one version check, against a range package.json declares. The range is read here, when the
 * check runs, never at import: a form this parser does not know (`^22.15.0`, `~1.2.3`, `a || b`) must fail
 * the one check that uses it instead of throwing, because install.js imports this module after it has
 * written the client configs — an import-time throw would turn a successful install into a crash.
 * @param {string|undefined} version  the version found on this machine; absent passes
 * @param {string} key  dotted package.json key holding the range, e.g. `switchboard.codexRange`
 * @param {(range: string) => string} [detail]
 * @param {object} [pkg]  the package.json to read, injectable for tests
 * @returns {{ ok: boolean, detail: string }}
 */
export function rangeVerdict(version, key, detail = (range) => `${version ?? 'unknown'} (supported ${range})`, pkg = PKG) {
  try {
    const range = key.split('.').reduce((v, k) => v?.[k], pkg);
    return { ok: versionInRange(version, range), detail: detail(range) };
  } catch (e) {
    return { ok: false, detail: `${e.message} (package.json ${key})` };
  }
}

/** The `node >= X` label; an `engines.node` this build cannot read leaves a generic label instead of throwing. */
function nodeCheckName() {
  try { return `node >= ${rangeBounds(PKG.engines?.node).min}`; } catch { return 'node version'; }
}

/** Everything the checks read, gathered once. */
async function gatherContext(opts) {
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  const { host, port } = listenAddress(cfg);
  const claudeSettings = readJson(path.join(paths.claudeHome, 'settings.json'));
  return {
    opts, paths, cfg, host, port,
    service: await serviceStatus(),
    detected: await detectClients(paths),
    codexToml: fs.existsSync(path.join(paths.codexHome, 'config.toml')) ? fs.readFileSync(path.join(paths.codexHome, 'config.toml'), 'utf8') : '',
    claudeSettings,
    providers: await Promise.all(buildProviders(cfg, async () => null).map(async (p) => ({ provider: p, key: await resolveProviderKey(cfg.upstream[p.name], PROVIDER_KEY_ENV[p.name]) }))),
  };
}

function protectedUrl(c, suffix) {
  try {
    return `${routerBaseUrl(c.cfg)}${suffix}`;
  } catch (e) {
    return { missing: e.message };
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or unparsable settings count as empty; the base-url check will then fail visibly.
    return {};
  }
}

async function reachable(url, timeoutMs) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 500;
  } catch {
    return false;
  }
}

const roleFilesExist = (dir, extension, names = ROLE_NAMES) => names.every((name) => fs.existsSync(path.join(dir, `${name}${extension}`)));

/**
 * Each check: `name` (string or function of ctx), `when` (optional gate), `run` returning a boolean or `{ ok, detail }`.
 * Adding a check is one entry here.
 */
const providerChecks = (c) => c.providers.flatMap(({ provider, key }) => [
  { name: `${provider.name} key present`, run: () => ({ ok: provider.name !== 'deepseek' || !!key, detail: key ? 'keychain/env' : provider.name === 'deepseek' ? 'run `switchboard install` with a key' : 'optional; add with `switchboard install --openrouter-key …`' }) },
  { name: `${provider.name} responses API`, connectivity: true, when: () => key && !c.opts.offline, run: async () => { c.probes ??= {}; c.probes[provider.name] = await probeProvider(provider, key); return { ok: c.probes[provider.name].responses.ok, detail: redact(c.probes[provider.name].responses.error ?? '', c.cfg, key) }; } },
  { name: `${provider.name} messages API`, connectivity: true, when: () => key && !c.opts.offline, run: () => ({ ok: c.probes[provider.name].messages.ok, detail: redact(c.probes[provider.name].messages.error ?? '', c.cfg, key) }) },
]);

const CHECKS = [
  { name: nodeCheckName, run: () => rangeVerdict(process.versions.node, 'engines.node', () => process.versions.node) },
  { name: 'switchboard config', run: (c) => ({ ok: fs.existsSync(c.paths.configFile), detail: c.paths.configFile }) },
  { name: 'switchboard access token configured', run: (c) => ({ ok: !!c.cfg.access_token, detail: c.cfg.access_token ? 'present' : 'missing; run `switchboard install` to mint protected client URLs' }) },
  { name: 'login service', run: (c) => ({ ok: c.service.installed && c.service.running, detail: !c.service.installed ? 'not installed' : c.service.running ? `running${c.service.pid ? ` pid ${c.service.pid}` : ''}` : 'installed, not running' }) },
  { name: (c) => `router reachable on ${c.host}:${c.port}`, run: async (c) => { try { return (await fetch(`http://${c.host}:${c.port}/switchboard/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok; } catch { return false; } } },

  { name: 'codex version in range', when: (c) => c.detected.codex.present, run: (c) => rangeVerdict(c.detected.codex.version, 'switchboard.codexRange') },
  { name: 'codex openai_base_url points at protected router', when: (c) => c.detected.codex.present, run: (c) => { const u = protectedUrl(c, '/backend-api/codex'); return u.missing ? { ok: false, detail: u.missing } : c.codexToml.includes(`openai_base_url = "${u}"`); } },
  { name: 'codex default_subagent_model set', when: (c) => c.detected.codex.present, run: (c) => /default_subagent_model\s*=\s*"deepseek-/.test(c.codexToml) },
  { name: 'codex logged in (ChatGPT)', when: (c) => c.detected.codex.present, run: (c) => fs.existsSync(path.join(c.paths.codexHome, 'auth.json')) },
  { name: 'no codex process predates the install', when: (c) => c.detected.codex.present && process.platform !== 'win32', run: (c) => {
    // A Codex app-server that started before the install still talks to the vendor directly and rewrites the shared models cache.
    let installedAt = 0;
    try { installedAt = fs.statSync(c.paths.stateFile).mtimeMs; } catch { return true; }
    const stale = [];
    try {
      const out = execFileSync('ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (!/codex.* app-server/.test(line) || /agents-switchboard/.test(line)) continue;
        const [pid, ...rest] = line.trim().split(/\s+/);
        const started = Date.parse(rest.slice(0, 5).join(' '));
        if (Number.isFinite(started) && started < installedAt) stale.push(pid);
      }
    } catch { return true; }
    return stale.length ? { ok: false, detail: `pid ${stale.join(', ')} started before the install; quit the Codex app and run: pkill -f 'codex.*app-server'` } : true;
  } },
  { name: 'codex models cache served by the router', when: (c) => c.detected.codex.present, run: (c) => {
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(`${c.paths.codexHome}/models_cache.json`, 'utf8')); } catch { return { ok: false, detail: 'no models cache yet; start a Codex session' }; }
    const viaRouter = /\+sb[0-9a-f]{8}"$/.test(cache.etag ?? '');
    const v2Parent = (cache.models ?? []).some((m) => m.multi_agent_version === 'v2' && !/^deepseek-|\//.test(m.slug));
    if (viaRouter && !v2Parent) return true;
    return { ok: false, detail: "a Codex process started before the install is still talking to chatgpt.com directly and rewrites this cache; quit the Codex app, run: pkill -f 'codex.*app-server', then start a new session" };
  } },
  { name: 'codex role files', when: (c) => c.detected.codex.present, run: (c) => roleFilesExist(path.join(c.paths.codexHome, 'agents'), '.toml') },

  { name: 'claude version in range', when: (c) => c.detected.claude.present, run: (c) => rangeVerdict(c.detected.claude.version, 'switchboard.claudeRange') },
  { name: 'claude ANTHROPIC_BASE_URL points at protected router', when: (c) => c.detected.claude.present, run: (c) => { const u = protectedUrl(c, '/anthropic'); return u.missing ? { ok: false, detail: u.missing } : c.claudeSettings.env?.ANTHROPIC_BASE_URL === u; } },
  { name: 'claude subagent model set', when: (c) => c.detected.claude.present, run: (c) => /^deepseek-/.test(c.claudeSettings.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? '') },
  { name: 'claude sends effort for the DeepSeek id (CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)', when: (c) => c.detected.claude.present, run: (c) => c.claudeSettings.env?.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === '1' },
  { name: 'claude has no API-key credential (subscription stays active)', when: (c) => c.detected.claude.present, run: (c) => !c.claudeSettings.env?.ANTHROPIC_API_KEY && !c.claudeSettings.env?.ANTHROPIC_AUTH_TOKEN && !c.claudeSettings.apiKeyHelper && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN },
  { name: 'claude role files', when: (c) => c.detected.claude.present, run: (c) => roleFilesExist(path.join(c.paths.claudeHome, 'agents'), '.md', CLAUDE_ROLE_NAMES) },

  { name: 'chatgpt.com reachable', connectivity: true, when: (c) => !c.opts.offline, run: (c) => reachable(c.cfg.upstream.openai.base_url, REACH_TIMEOUT_MS) },
  { name: 'api.anthropic.com reachable', connectivity: true, when: (c) => !c.opts.offline, run: (c) => reachable(c.cfg.upstream.anthropic.base_url, REACH_TIMEOUT_MS) },
];

/**
 * Run every applicable check. Prints one line per check (all of them, or only when something failed with `quiet`).
 * Checks tagged `connectivity` probe the network; callers that only care about the install can ignore those.
 * @param {{ offline?: boolean, quiet?: boolean, report?: boolean }} [opts]  `report` returns the results instead of an exit code
 * @returns {Promise<number|{ results: object[], failed: object[] }>} exit code 0 when all checks pass, or the report
 */
export async function doctor(opts = {}) {
  const ctx = await gatherContext(opts);
  const results = [];
  for (const check of [...CHECKS, ...providerChecks(ctx)]) {
    if (check.when && !check.when(ctx)) continue;
    const outcome = await check.run(ctx);
    const { ok, detail = '' } = typeof outcome === 'object' ? outcome : { ok: outcome };
    results.push({ name: typeof check.name === 'function' ? check.name(ctx) : check.name, ok, detail, connectivity: !!check.connectivity });
  }
  const failed = results.filter((r) => !r.ok);
  if (!opts.quiet || failed.length) {
    for (const r of results) process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}\n`);
  }
  process.stdout.write(failed.length ? `\n${failed.length} check(s) failed\n` : 'all checks passed\n');
  if (opts.report) return { results, failed };
  return failed.length ? 1 : 0;
}
