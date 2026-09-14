// `switchboard test`: spawn a real subagent in each client and prove from the router log that it ran on DeepSeek.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';

const PROMPT = 'Spawn one explorer subagent and ask it: what is 2+2? Report exactly what the subagent answered, then stop. Do not answer yourself.';
const CLIENT_TIMEOUT_MS = 240_000;

const CLIENTS = {
  codex: { command: 'codex', args: () => ['exec', '--skip-git-repo-check', '-C', process.cwd(), PROMPT] },
  claude: { command: 'claude', args: () => ['-p', PROMPT, '--permission-mode', 'bypassPermissions'] },
};

/**
 * Parse the JSONL request log and keep the DeepSeek-bound entries for one client since a timestamp. Pure.
 * @param {string} text  log file contents
 * @param {{ client: 'codex'|'claude', since: string }} filter  `since` is an ISO timestamp
 * @returns {object[]}
 */
export function deepseekHits(text, { client, since }) {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) // a torn last line is not a hit
    .filter((e) => e.ts >= since && e.client === client && e.upstream === 'deepseek');
}

/**
 * One-line evidence summary for a client's hits.
 * @param {object[]} hits
 * @returns {string}
 */
export function describeHits(hits) {
  if (!hits.length) return '0 DeepSeek requests via the router';
  const first = hits[0];
  const usage = first.usage ? `, ${first.usage.input ?? '?'} in / ${first.usage.cached ?? '?'} cached / ${first.usage.output ?? '?'} out` : '';
  return `${hits.length} DeepSeek request(s) via the router (model ${first.model}, role ${first.role ?? 'default'}${usage})`;
}

function runClient({ command, args }, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args(), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, output: `${e.message}\n` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/**
 * Run the proof for every detected client (or the one selected with `--codex` / `--claude`).
 * A client passes when at least one DeepSeek request went through the router during its run;
 * the client's exit code is reported but does not decide the result, since Codex may exit non-zero
 * for reasons unrelated to routing (interrupted MCP servers, deprecated config keys).
 * @param {{ codex?: boolean, claude?: boolean }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function testCommand(opts = {}) {
  const paths = resolvePaths();
  const present = { codex: codexPresent(paths), claude: claudePresent(paths) };
  const selected = Object.keys(CLIENTS).filter((name) => present[name] && (opts.codex || opts.claude ? opts[name] : true));
  if (!selected.length) { process.stdout.write('no client detected\n'); return 1; }

  let allPassed = true;
  for (const name of selected) {
    const since = new Date().toISOString();
    process.stdout.write(`${name}: spawning an explorer through a real session…\n`);
    const result = await runClient(CLIENTS[name], CLIENT_TIMEOUT_MS);
    const hits = deepseekHits(fs.existsSync(paths.logFile) ? fs.readFileSync(paths.logFile, 'utf8') : '', { client: name, since });
    // Evidence must come from both ends: the router saw a provider request AND the parent reported the child's answer.
    const answered = /\b4\b|four/i.test(result.output);
    const passed = hits.length > 0 && answered;
    allPassed &&= passed;
    process.stdout.write(`${name}: ${passed ? 'PASS' : 'FAIL'} — ${describeHits(hits)}; child answer ${answered ? 'received' : 'MISSING'}; client exit ${result.code ?? 'error'}\n`);
    if (!passed) process.stdout.write(result.output.split('\n').slice(-12).join('\n') + '\n');
  }
  return allPassed ? 0 : 1;
}
