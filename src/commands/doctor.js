// `switchboard doctor`: a data-driven list of health checks with one line of output each.
import fs from 'node:fs';
import path from 'node:path';
import { probeDeepSeek } from '../adapters/probe.js';
import { loadConfig, listenAddress, resolveDeepSeekKey } from '../config.js';
import { baseUrlFor as claudeUrl } from '../install/claude.js';
import { baseUrlFor as codexUrl } from '../install/codex.js';
import { detectClients } from '../install/index.js';
import { ROLE_NAMES } from '../install/roles.js';
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
    key: await resolveDeepSeekKey(cfg),
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

const roleFilesExist = (dir, extension) => ROLE_NAMES.every((name) => fs.existsSync(path.join(dir, `${name}${extension}`)));

/**
 * Each check: `name` (string or function of ctx), `when` (optional gate), `run` returning a boolean or `{ ok, detail }`.
 * Adding a check is one entry here.
 */
const CHECKS = [
  { name: `node >= ${MIN_NODE.replace(/\.0$/, '')}`, run: () => ({ ok: semverGte(process.versions.node, MIN_NODE), detail: process.versions.node }) },
  { name: 'switchboard config', run: (c) => ({ ok: fs.existsSync(c.paths.configFile), detail: c.paths.configFile }) },
  { name: 'login service', run: (c) => ({ ok: c.service.installed && c.service.running, detail: !c.service.installed ? 'not installed' : c.service.running ? `running${c.service.pid ? ` pid ${c.service.pid}` : ''}` : 'installed, not running' }) },
  { name: (c) => `router reachable on ${c.host}:${c.port}`, run: async (c) => { try { return (await fetch(`http://${c.host}:${c.port}/switchboard/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok; } catch { return false; } } },

  { name: 'codex version in range', when: (c) => c.detected.codex.present, run: (c) => ({ ok: !c.detected.codex.version || semverGte(c.detected.codex.version, MIN_CODEX), detail: `${c.detected.codex.version ?? 'unknown'} (supported ${c.pkg.switchboard.codexRange})` }) },
  { name: 'codex openai_base_url points at router', when: (c) => c.detected.codex.present, run: (c) => c.codexToml.includes(`openai_base_url = "${codexUrl(c.port)}"`) },
  { name: 'codex default_subagent_model set', when: (c) => c.detected.codex.present, run: (c) => /default_subagent_model\s*=\s*"deepseek-/.test(c.codexToml) },
  { name: 'codex logged in (ChatGPT)', when: (c) => c.detected.codex.present, run: (c) => fs.existsSync(path.join(c.paths.codexHome, 'auth.json')) },
  { name: 'codex role files', when: (c) => c.detected.codex.present, run: (c) => roleFilesExist(path.join(c.paths.codexHome, 'agents'), '.toml') },

  { name: 'claude version in range', when: (c) => c.detected.claude.present, run: (c) => ({ ok: !c.detected.claude.version || semverGte(c.detected.claude.version, MIN_CLAUDE), detail: `${c.detected.claude.version ?? 'unknown'} (supported ${c.pkg.switchboard.claudeRange})` }) },
  { name: 'claude ANTHROPIC_BASE_URL points at router', when: (c) => c.detected.claude.present, run: (c) => c.claudeSettings.env?.ANTHROPIC_BASE_URL === claudeUrl(c.port) },
  { name: 'claude subagent model set', when: (c) => c.detected.claude.present, run: (c) => /^deepseek-/.test(c.claudeSettings.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? '') },
  { name: 'claude has no API-key credential (subscription stays active)', when: (c) => c.detected.claude.present, run: (c) => !c.claudeSettings.env?.ANTHROPIC_API_KEY && !c.claudeSettings.env?.ANTHROPIC_AUTH_TOKEN && !c.claudeSettings.apiKeyHelper && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN },
  { name: 'claude role files', when: (c) => c.detected.claude.present, run: (c) => roleFilesExist(path.join(c.paths.claudeHome, 'agents'), '.md') },

  { name: 'deepseek key present', run: (c) => ({ ok: !!c.key, detail: c.key ? 'keychain/env' : 'run `switchboard install` with a key' }) },
  { name: 'deepseek responses API', when: (c) => c.key && !c.opts.offline, run: async (c) => { const p = await probeDeepSeek(c.key, c.cfg.upstream.deepseek.base_url); c.probe = p; return { ok: p.responses.ok, detail: p.responses.error ?? '' }; } },
  { name: 'deepseek messages API', when: (c) => c.key && !c.opts.offline, run: (c) => ({ ok: c.probe.messages.ok, detail: c.probe.messages.error ?? '' }) },
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
  for (const check of CHECKS) {
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
