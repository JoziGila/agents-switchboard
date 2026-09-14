// `switchboard doctor`: a data-driven list of health checks with one line of output each.
import fs from 'node:fs';
import path from 'node:path';
import { probeProvider } from '../adapters/probe.js';
import { buildProviders } from '../providers.js';
import { loadConfig, listenAddress, resolveProviderKey, PROVIDER_KEY_ENV } from '../config.js';
import { baseUrlFor as claudeUrl } from '../install/claude.js';
import { baseUrlFor as codexUrl } from '../install/codex.js';
import { detectClients } from '../install/index.js';
import { ROLE_NAMES, CLAUDE_ROLE_NAMES } from '../install/roles.js';
import { serviceStatus } from '../install/service.js';
import { resolvePaths } from '../paths.js';

const MIN_NODE = '22.15.0';
const MIN_CODEX = '0.150.0';
const MIN_CLAUDE = '2.1.181';
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

/** Everything the checks read, gathered once. */
async function gatherContext(opts) {
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  const { host, port } = listenAddress(cfg);
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
  const claudeSettings = readJson(path.join(paths.claudeHome, 'settings.json'));
  return {
    opts, paths, cfg, host, port, pkg,
    service: await serviceStatus(),
    detected: await detectClients(paths),
    codexToml: fs.existsSync(path.join(paths.codexHome, 'config.toml')) ? fs.readFileSync(path.join(paths.codexHome, 'config.toml'), 'utf8') : '',
    claudeSettings,
    providers: await Promise.all(buildProviders(cfg, async () => null).map(async (p) => ({ provider: p, key: await resolveProviderKey(cfg.upstream[p.name], PROVIDER_KEY_ENV[p.name]) }))),
  };
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
  { name: `${provider.name} responses API`, when: () => key && !c.opts.offline, run: async () => { c.probes ??= {}; c.probes[provider.name] = await probeProvider(provider, key); return { ok: c.probes[provider.name].responses.ok, detail: c.probes[provider.name].responses.error ?? '' }; } },
  { name: `${provider.name} messages API`, when: () => key && !c.opts.offline, run: () => ({ ok: c.probes[provider.name].messages.ok, detail: c.probes[provider.name].messages.error ?? '' }) },
]);

const CHECKS = [
  { name: `node >= ${MIN_NODE.replace(/\.0$/, '')}`, run: () => ({ ok: semverGte(process.versions.node, MIN_NODE), detail: process.versions.node }) },
  { name: 'switchboard config', run: (c) => ({ ok: fs.existsSync(c.paths.configFile), detail: c.paths.configFile }) },
  { name: 'login service', run: (c) => ({ ok: c.service.installed && c.service.running, detail: !c.service.installed ? 'not installed' : c.service.running ? `running${c.service.pid ? ` pid ${c.service.pid}` : ''}` : 'installed, not running' }) },
  { name: (c) => `router reachable on ${c.host}:${c.port}`, run: async (c) => { try { return (await fetch(`http://${c.host}:${c.port}/switchboard/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok; } catch { return false; } } },

  { name: 'codex version in range', when: (c) => c.detected.codex.present, run: (c) => ({ ok: !c.detected.codex.version || semverGte(c.detected.codex.version, MIN_CODEX), detail: `${c.detected.codex.version ?? 'unknown'} (supported ${c.pkg.switchboard.codexRange})` }) },
  { name: 'codex openai_base_url points at router', when: (c) => c.detected.codex.present, run: (c) => c.codexToml.includes(`openai_base_url = "${codexUrl(c.port)}"`) },
  { name: 'codex default_subagent_model set', when: (c) => c.detected.codex.present, run: (c) => /default_subagent_model\s*=\s*"deepseek-/.test(c.codexToml) },
  { name: 'codex logged in (ChatGPT)', when: (c) => c.detected.codex.present, run: (c) => fs.existsSync(path.join(c.paths.codexHome, 'auth.json')) },
  { name: 'codex models cache served by the router', when: (c) => c.detected.codex.present, run: (c) => {
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(`${c.paths.codexHome}/models_cache.json`, 'utf8')); } catch { return { ok: false, detail: 'no models cache yet; start a Codex session' }; }
    const viaRouter = /\+sb[0-9a-f]{8}"$/.test(cache.etag ?? '');
    const v2Parent = (cache.models ?? []).some((m) => m.multi_agent_version === 'v2' && !/^deepseek-|\//.test(m.slug));
    if (viaRouter && !v2Parent) return true;
    return { ok: false, detail: 'a Codex process started before install (usually the desktop app) is still talking to chatgpt.com directly and rewrites this cache; quit and reopen the Codex app' };
  } },
  { name: 'codex role files', when: (c) => c.detected.codex.present, run: (c) => roleFilesExist(path.join(c.paths.codexHome, 'agents'), '.toml') },

  { name: 'claude version in range', when: (c) => c.detected.claude.present, run: (c) => ({ ok: !c.detected.claude.version || semverGte(c.detected.claude.version, MIN_CLAUDE), detail: `${c.detected.claude.version ?? 'unknown'} (supported ${c.pkg.switchboard.claudeRange})` }) },
  { name: 'claude ANTHROPIC_BASE_URL points at router', when: (c) => c.detected.claude.present, run: (c) => c.claudeSettings.env?.ANTHROPIC_BASE_URL === claudeUrl(c.port) },
  { name: 'claude subagent model set', when: (c) => c.detected.claude.present, run: (c) => /^deepseek-/.test(c.claudeSettings.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? '') },
  { name: 'claude has no API-key credential (subscription stays active)', when: (c) => c.detected.claude.present, run: (c) => !c.claudeSettings.env?.ANTHROPIC_API_KEY && !c.claudeSettings.env?.ANTHROPIC_AUTH_TOKEN && !c.claudeSettings.apiKeyHelper && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN },
  { name: 'claude role files', when: (c) => c.detected.claude.present, run: (c) => roleFilesExist(path.join(c.paths.claudeHome, 'agents'), '.md', CLAUDE_ROLE_NAMES) },

  { name: 'chatgpt.com reachable', when: (c) => !c.opts.offline, run: (c) => reachable(c.cfg.upstream.openai.base_url, REACH_TIMEOUT_MS) },
  { name: 'api.anthropic.com reachable', when: (c) => !c.opts.offline, run: (c) => reachable(c.cfg.upstream.anthropic.base_url, REACH_TIMEOUT_MS) },
];

/**
 * Run every applicable check. Prints one line per check (all of them, or only when something failed with `quiet`).
 * @param {{ offline?: boolean, quiet?: boolean }} [opts]
 * @returns {Promise<number>} exit code: 0 when all checks pass
 */
export async function doctor(opts = {}) {
  const ctx = await gatherContext(opts);
  const results = [];
  for (const check of [...CHECKS, ...providerChecks(ctx)]) {
    if (check.when && !check.when(ctx)) continue;
    const outcome = await check.run(ctx);
    const { ok, detail = '' } = typeof outcome === 'object' ? outcome : { ok: outcome };
    results.push({ name: typeof check.name === 'function' ? check.name(ctx) : check.name, ok, detail });
  }
  const failed = results.filter((r) => !r.ok);
  if (!opts.quiet || failed.length) {
    for (const r of results) process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}\n`);
  }
  process.stdout.write(failed.length ? `\n${failed.length} check(s) failed\n` : 'all checks passed\n');
  return failed.length ? 1 : 0;
}
