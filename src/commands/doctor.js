import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePaths } from '../paths.js';
import { loadConfig, listenAddress, resolveDeepSeekKey } from '../config.js';
import { detectClients } from '../install/index.js';
import { serviceStatus } from '../install/service.js';
import { baseUrlFor as codexUrl } from '../install/codex.js';
import { baseUrlFor as claudeUrl } from '../install/claude.js';
import { probeDeepSeek } from '../deepseek-probe.js';

const exec = promisify(execFile);

function semverGte(v, min) {
  const a = String(v).replace(/^v/, '').split(/[.-]/).map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}

export async function doctor(opts = {}) {
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  const { host, port } = listenAddress(cfg);
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  add('node >= 22.15', semverGte(process.versions.node, '22.15.0'), process.versions.node);
  add('switchboard config', fs.existsSync(paths.configFile), paths.configFile);
  const svc = await serviceStatus();
  add('login service', svc.installed && svc.running, svc.installed ? (svc.running ? `running${svc.pid ? ` pid ${svc.pid}` : ''}` : 'installed, not running') : 'not installed');
  let health = false;
  try { health = (await fetch(`http://${host}:${port}/switchboard/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  add(`router reachable on ${host}:${port}`, health);

  const detected = await detectClients(paths);
  if (detected.codex.present) {
    add('codex version in range', !detected.codex.version || semverGte(detected.codex.version, '0.150.0'), `${detected.codex.version ?? 'unknown'} (supported ${pkg.switchboard.codexRange})`);
    const toml = fs.existsSync(`${paths.codexHome}/config.toml`) ? fs.readFileSync(`${paths.codexHome}/config.toml`, 'utf8') : '';
    add('codex openai_base_url points at router', toml.includes(`openai_base_url = "${codexUrl(port)}"`));
    add('codex default_subagent_model set', /default_subagent_model\s*=\s*"deepseek-/.test(toml));
    add('codex logged in (ChatGPT)', fs.existsSync(`${paths.codexHome}/auth.json`));
    add('codex role files', ['explorer', 'worker', 'reviewer', 'senior'].every((r) => fs.existsSync(`${paths.codexHome}/agents/${r}.toml`)));
  }
  if (detected.claude.present) {
    add('claude version in range', !detected.claude.version || semverGte(detected.claude.version, '2.1.181'), `${detected.claude.version ?? 'unknown'} (supported ${pkg.switchboard.claudeRange})`);
    let settings = {}; try { settings = JSON.parse(fs.readFileSync(`${paths.claudeHome}/settings.json`, 'utf8')); } catch {}
    add('claude ANTHROPIC_BASE_URL points at router', settings.env?.ANTHROPIC_BASE_URL === claudeUrl(port));
    add('claude subagent model set', /^deepseek-/.test(settings.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? ''));
    add('claude has no API-key credential (subscription stays active)', !settings.env?.ANTHROPIC_API_KEY && !settings.env?.ANTHROPIC_AUTH_TOKEN && !settings.apiKeyHelper && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN);
    add('claude role files', ['explorer', 'worker', 'reviewer', 'senior'].every((r) => fs.existsSync(`${paths.claudeHome}/agents/${r}.md`)));
  }

  const key = await resolveDeepSeekKey(cfg);
  add('deepseek key present', !!key, key ? 'keychain/env' : 'run `switchboard install` with a key');
  if (key && !opts.offline) {
    const p = await probeDeepSeek(key, cfg.upstream.deepseek.base_url);
    add('deepseek responses API', p.responses.ok, p.responses.error ?? '');
    add('deepseek messages API', p.messages.ok, p.messages.error ?? '');
  }
  if (!opts.offline) {
    for (const [name, url] of [['chatgpt.com', cfg.upstream.openai.base_url], ['api.anthropic.com', cfg.upstream.anthropic.base_url]]) {
      let ok = false; try { const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }); ok = r.status < 500; } catch {}
      add(`${name} reachable`, ok);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (!opts.quiet || failed.length) for (const c of checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}\n`);
  process.stdout.write(failed.length ? `\n${failed.length} check(s) failed\n` : 'all checks passed\n');
  return failed.length ? 1 : 0;
}
