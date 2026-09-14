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

/**
 * Whether a logged role proves the request came from a subagent. Codex sets `x-openai-subagent` to the
 * role name (explorer, worker, reviewer, senior) on children only, so any other value is the parent
 * session; Claude Code marks children with `x-claude-code-agent-id`, which the route logs as `subagent`.
 * @param {'codex'|'claude'} client
 * @param {string|null|undefined} role
 */
function isSubagentRole(client, role) {
  return client === 'claude' ? role === 'subagent' : typeof role === 'string' && role !== '' && role !== 'main';
}

/** A request the provider actually served: the router records the upstream status when the response ends. */
function isServed(hit) {
  return typeof hit.status === 'number' && hit.status >= 200 && hit.status < 300;
}

/**
 * The hits that prove a subagent ran on the provider: right client, subagent role, 2xx upstream. A
 * DeepSeek request the parent made, or one DeepSeek rejected, is not evidence the child ran there.
 * @param {object[]} hits
 * @param {'codex'|'claude'} client
 */
export function provenHits(hits, client) {
  return hits.filter((h) => isSubagentRole(client, h.role) && isServed(h));
}

/** The child's answer to the PROMPT's 2+2 is 4, and only 4. A stray 42 is a different question. */
const CHILD_ANSWER = /\b4\b|four/i;

function runClient({ command, args }, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args(), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${e.message}\n` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Run the proof for every detected client (or the one selected with `--codex` / `--claude`).
 * A client passes only when all three hold: the client exited 0, its output carries the child's answer,
 * and the router log shows a successful DeepSeek request from a subagent role. Nothing else counts — a
 * DeepSeek request the parent session made, a request DeepSeek rejected, or a session that died before
 * the child answered are all reported as FAIL rather than as optimistic evidence.
 * @param {{ codex?: boolean, claude?: boolean }} [opts]
 * @param {{ present?: Record<string, boolean>, run?: (client: object, timeoutMs: number) => Promise<{code: number|null, output: string}>, readLog?: () => string, write?: (text: string) => void }} [deps]
 *   injection seams for tests; production callers pass only `opts`.
 * @returns {Promise<number>} exit code
 */
export async function testCommand(opts = {}, deps = {}) {
  const paths = resolvePaths();
  const present = deps.present ?? { codex: codexPresent(paths), claude: claudePresent(paths) };
  const run = deps.run ?? runClient;
  const readLog = deps.readLog ?? (() => (fs.existsSync(paths.logFile) ? fs.readFileSync(paths.logFile, 'utf8') : ''));
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const selected = Object.keys(CLIENTS).filter((name) => present[name] && (opts.codex || opts.claude ? opts[name] : true));
  if (!selected.length) { write('no client detected\n'); return 1; }

  let allPassed = true;
  for (const name of selected) {
    const since = new Date().toISOString();
    write(`${name}: spawning a subagent through a real session…\n`);
    const result = await run(CLIENTS[name], CLIENT_TIMEOUT_MS);
    const hits = deepseekHits(readLog(), { client: name, since });
    // Evidence must come from both ends: the router saw the provider serve a child request AND the client
    // finished cleanly with the child's answer on stdout. stderr is diagnostics: a version banner or a
    // warning there is not the child replying.
    const proven = provenHits(hits, name);
    const completed = result.code === 0;
    const answered = CHILD_ANSWER.test(result.stdout);
    const passed = proven.length > 0 && completed && answered;
    allPassed &&= passed;
    const ignored = hits.length - proven.length;
    write(`${name}: ${passed ? 'PASS' : 'FAIL'} — ${describeHits(proven)}${ignored ? `; ${ignored} DeepSeek hit(s) ignored: no subagent role or not 2xx` : ''}; child answer ${answered ? 'received' : 'MISSING'}; client exit ${result.code ?? 'error'}\n`);
    if (!passed) write((result.stdout + result.stderr).split('\n').slice(-12).join('\n') + '\n');
  }
  return allPassed ? 0 : 1;
}
