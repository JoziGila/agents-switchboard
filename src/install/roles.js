/**
 * Role definitions shared by both clients (SPEC §10.1–§10.3).
 * The instruction text is identical across clients so every role shares a prefix shape.
 */

export const MANAGED_TOML = '# managed by agents-switchboard';
export const MANAGED_MD = '<!-- managed by agents-switchboard -->';

const INSTRUCTIONS = {
  explorer: "You are an explorer. Answer the parent's question about the codebase with file paths and line references. Do not modify files. Do not speculate beyond what you read. Be brief.",
  worker: 'You are a worker. Implement exactly the task the parent specified, run the relevant tests, and report the diff summary and test output. If the task is under-specified or you are blocked, stop and say what you need instead of guessing.',
  reviewer: 'You are a reviewer. Read the diff and the surrounding code. Report concrete defects with file and line, ranked by severity. Do not restate the diff. Say clearly when you find nothing.',
  senior: "You are the senior engineer. You receive tasks a faster model could not complete. Read the previous attempt's report first, then solve the task end to end.",
};

/**
 * @param {{ pro?: boolean }} [opts] `pro` moves reviewer and senior to deepseek-v4-pro.
 */
export function codexRoles({ pro = false } = {}) {
  return {
    explorer: {
      description: 'Fast, read-only codebase exploration on DeepSeek Flash: find files, trace call paths, summarise modules, answer questions about existing code.',
      model: 'deepseek-flash', effort: 'low', sandbox: 'read-only',
    },
    worker: {
      description: 'Implementation on DeepSeek Flash for bounded, fully specified changes: a function, a test, a migration, a refactor within one module.',
      model: 'deepseek-flash', effort: 'high', sandbox: 'workspace-write',
    },
    reviewer: {
      description: pro
        ? 'Independent review on DeepSeek V4 Pro: check a diff for bugs, missing tests and spec mismatches before the parent accepts it.'
        : 'Independent review on DeepSeek Flash: check a diff for bugs, missing tests and spec mismatches before the parent accepts it.',
      model: pro ? 'deepseek-v4-pro' : 'deepseek-flash', effort: 'high', sandbox: 'read-only',
    },
    senior: {
      description: pro
        ? 'Escalation on DeepSeek V4 Pro. Use only after a Flash worker failed twice, or for cross-module design work.'
        : 'Escalation on a frontier GPT model. Use only after a Flash worker failed twice, or for cross-module design work.',
      model: pro ? 'deepseek-v4-pro' : 'gpt-5.5', effort: 'high', sandbox: 'workspace-write',
    },
  };
}

/** Render one Codex role file. */
export function renderCodexRole(name, role) {
  return [
    MANAGED_TOML,
    `name = "${name}"`,
    `description = "${role.description}"`,
    `model = "${role.model}"`,
    `model_reasoning_effort = "${role.effort}"`,
    `sandbox_mode = "${role.sandbox}"`,
    'developer_instructions = """',
    INSTRUCTIONS[name],
    '"""',
    '',
  ].join('\n');
}

/**
 * @param {{ pro?: boolean }} [opts]
 */
export function claudeRoles({ pro = false } = {}) {
  const readOnly = 'Read, Grep, Glob, Bash';
  return {
    explorer: {
      description: 'Fast, read-only codebase exploration on DeepSeek Flash. Use for finding files, tracing call paths, summarising modules, answering questions about existing code.',
      model: 'deepseek-flash[1m]', tools: readOnly,
    },
    worker: {
      description: 'Implementation on DeepSeek Flash for bounded, fully specified changes: a function, a test, a migration, a refactor within one module.',
      model: 'deepseek-flash[1m]',
    },
    reviewer: {
      description: `Independent review on DeepSeek ${pro ? 'V4 Pro' : 'Flash'}. Use to check a diff for bugs, missing tests and spec mismatches before the parent accepts it.`,
      model: pro ? 'deepseek-v4-pro' : 'deepseek-flash[1m]', tools: readOnly,
    },
    senior: {
      description: pro
        ? 'Escalation on DeepSeek V4 Pro. Use only after a Flash worker failed twice, or for cross-module design work.'
        : "Escalation on the session's frontier model. Use only after a Flash worker failed twice, or for cross-module design work.",
      model: pro ? 'deepseek-v4-pro' : 'inherit',
    },
  };
}

/** Render one Claude Code subagent file. */
export function renderClaudeRole(name, role) {
  const fm = ['---', `name: ${name}`, `description: ${role.description}`, `model: ${role.model}`];
  if (role.tools) fm.push(`tools: ${role.tools}`);
  fm.push('---');
  return [...fm, MANAGED_MD, INSTRUCTIONS[name], ''].join('\n');
}

export const DELEGATION_START = '<!-- agents-switchboard delegation policy -->';
export const DELEGATION_END = '<!-- /agents-switchboard -->';

export const DELEGATION_BLOCK = [
  DELEGATION_START,
  '## Delegation',
  '',
  "Subagents run on DeepSeek Flash by default: fast, 1M context, roughly 50x cheaper than this session's model. Use them freely for bounded work; keep judgement here.",
  '',
  '- explorer: any question about existing code. Spawn several in parallel for independent questions. Trust their file references; verify only what you change.',
  '- worker: implementation that fits in one message: exact files, exact behaviour, how to test. Split larger tasks first.',
  '- reviewer: every non-trivial diff before you accept it.',
  "- senior: only after a worker failed twice on the same task, or for cross-module design decisions. Pass the failed attempt's report.",
  '',
  'Do not delegate: choosing an approach, resolving ambiguity with the user, anything that depends on screenshots or images unless you describe them in text first.',
  DELEGATION_END,
].join('\n');

/**
 * Insert or replace the delegation block in a markdown document. Idempotent.
 * @param {string} text existing document ('' when missing)
 */
export function upsertDelegation(text) {
  const stripped = removeDelegation(text);
  const base = stripped.length && !stripped.endsWith('\n') ? stripped + '\n' : stripped;
  const sep = base.length ? (base.endsWith('\n\n') ? '' : '\n') : '';
  return `${base}${sep}${DELEGATION_BLOCK}\n`;
}

/** Remove the delegation block. Returns the text unchanged when absent. */
export function removeDelegation(text) {
  const start = text.indexOf(DELEGATION_START);
  if (start === -1) return text;
  const end = text.indexOf(DELEGATION_END, start);
  if (end === -1) return text;
  let before = text.slice(0, start);
  let after = text.slice(end + DELEGATION_END.length);
  after = after.replace(/^\n/, '');
  before = before.replace(/\n+$/, before.length ? '\n' : '');
  return before + after;
}
