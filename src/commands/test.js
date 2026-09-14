import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';

function runClient(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

function logEntriesSince(file, since) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.ts >= since);
}

const PROMPT = 'Spawn one explorer subagent and ask it: what is 2+2? Report exactly what the subagent answered, then stop. Do not answer yourself.';

export async function testCommand(opts = {}) {
  const paths = resolvePaths();
  const results = [];
  const out = (s) => process.stdout.write(s + '\n');
  if (codexPresent(paths) && !opts.claude) {
    const since = new Date().toISOString();
    out('codex: spawning an explorer through a real session…');
    const r = await runClient('codex', ['exec', '--skip-git-repo-check', '-C', process.cwd(), PROMPT], 240_000);
    const hits = logEntriesSince(paths.logFile, since).filter((e) => e.client === 'codex' && e.upstream === 'deepseek');
    const ok = hits.length > 0 && r.code === 0;
    results.push(ok);
    out(`codex: ${ok ? 'PASS' : 'FAIL'} — ${hits.length} DeepSeek request(s) via the router${hits[0] ? ` (model ${hits[0].model}, role ${hits[0].role ?? 'default'}, ${hits[0].usage?.input ?? '?'} in / ${hits[0].usage?.cached ?? '?'} cached / ${hits[0].usage?.output ?? '?'} out)` : ''}; exit ${r.code}`);
    if (!ok) out(r.out.split('\n').slice(-12).join('\n'));
  }
  if (claudePresent(paths) && !opts.codex) {
    const since = new Date().toISOString();
    out('claude: spawning an explorer through a real session…');
    const r = await runClient('claude', ['-p', PROMPT, '--permission-mode', 'bypassPermissions'], 240_000);
    const hits = logEntriesSince(paths.logFile, since).filter((e) => e.client === 'claude' && e.upstream === 'deepseek');
    const ok = hits.length > 0 && r.code === 0;
    results.push(ok);
    out(`claude: ${ok ? 'PASS' : 'FAIL'} — ${hits.length} DeepSeek request(s) via the router${hits[0] ? ` (model ${hits[0].model}, role ${hits[0].role}, ${hits[0].usage?.input ?? '?'} in / ${hits[0].usage?.cached ?? '?'} cached)` : ''}; exit ${r.code}`);
    if (!ok) out(r.out.split('\n').slice(-12).join('\n'));
  }
  if (!results.length) { out('no client detected'); return 1; }
  return results.every(Boolean) ? 0 : 1;
}
