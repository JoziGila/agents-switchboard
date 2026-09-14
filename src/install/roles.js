// Role definitions and the delegation policy shared by both clients (SPEC §10.1–§10.3).
// The instruction text is identical across clients so every role shares a prefix shape.

/** First line of a Codex role file the installer owns. */
export const MANAGED_TOML = '# managed by agents-switchboard';
/** First body line of a Claude Code subagent file the installer owns. */
export const MANAGED_MD = '<!-- managed by agents-switchboard -->';
/** Role files written for each client, in this order. */
export const ROLE_NAMES = ['explorer', 'worker', 'reviewer', 'senior'];
/** Claude Code also gets same-name overrides of its built-in Explore and Plan agents, which otherwise ignore CLAUDE_CODE_SUBAGENT_MODEL. */
export const CLAUDE_ROLE_NAMES = [...ROLE_NAMES, 'Explore', 'Plan'];

const INSTRUCTIONS = {
  Explore: 'You are a codebase explorer. Find the files, symbols and call paths the parent asked about. Report a direct answer first, then file:line evidence, at most a screenful. Do not modify files. Do not speculate beyond what you read.',
  Plan: 'You research the codebase so the parent can plan. Map the relevant modules, their contracts and the places a change would touch, with file:line references. Report a compact map, at most a screenful. Do not modify files.',
  explorer: "You are an explorer. Answer the parent's question about the codebase with file paths and line references. Read as much as you need; report only what the parent needs: a direct answer first, then the evidence, at most a screenful. Do not modify files. Do not speculate beyond what you read. Other explorers may be answering other questions in parallel; stay on yours.",
  worker: 'You are a worker. Implement exactly the task the parent specified, run the relevant tests, and report a short diff summary, the files you touched and the test result, at most a screenful; include failing output verbatim only for the failures. You own only the files the parent assigned to you. Other agents may be editing the same tree in parallel: never revert, reformat or clean up code you did not write, even if it looks wrong. If the task is under-specified or you are blocked, stop and say what you need instead of guessing.',
  reviewer: 'You are a reviewer. Read the diff and the surrounding code, run the tests if they exist. Report concrete defects with file and line, ranked by severity, each with a one-line fix suggestion. Do not restate the diff. Say clearly when you find nothing.',
  senior: "You are the senior engineer. You receive tasks a faster model could not complete. The failed attempt's report should be in your brief; if it is missing, say what you need instead of repeating work that already failed. Solve the task end to end and run the tests. Report what you changed, the files you touched, how you verified it, and what remains, at most a screenful.",
};

/**
 * Codex role definitions.
 * @param {{ pro?: boolean }} [opts] `pro` moves reviewer and senior to deepseek-v4-pro.
 * Codex applies a fixed whitelist of role fields (model, effort, instructions, ...); a role file cannot
 * restrict a child's sandbox, so read-only behaviour rests on the developer_instructions alone.
 * @returns {Record<string, { description: string, model: string, effort: string }>}
 */
export function codexRoles({ pro = false } = {}) {
  return {
    explorer: {
      description: 'Fast, read-only codebase exploration on DeepSeek Flash: find files, trace call paths, summarise modules, answer questions about existing code. Several explorers can run in parallel on independent questions.',
      model: 'deepseek-flash', effort: 'low',
    },
    worker: {
      description: 'Implementation on DeepSeek Flash for bounded, fully specified changes: a function, a test, a migration, a refactor within one module. Assign it ownership of specific files; other agents may edit the same tree in parallel, so it never reverts or reformats code it did not write, and it reports the files it touched.',
      model: 'deepseek-flash', effort: 'high',
    },
    reviewer: {
      description: pro
        ? 'Independent review on DeepSeek V4 Pro: check a diff for bugs, missing tests and spec mismatches before the parent accepts it.'
        : 'Independent review on DeepSeek Flash: check a diff for bugs, missing tests and spec mismatches before the parent accepts it.',
      model: pro ? 'deepseek-v4-pro' : 'deepseek-flash', effort: 'high',
    },
    senior: {
      description: pro
        ? 'Escalation on DeepSeek V4 Pro. Use only after a Flash worker failed twice, or for cross-module design work.'
        : 'Escalation on a frontier GPT model. Use only after a Flash worker failed twice, or for cross-module design work.',
      model: pro ? 'deepseek-v4-pro' : 'gpt-5.5', effort: 'high',
    },
  };
}

/**
 * Render one Codex role file (TOML).
 * @param {string} name
 * @param {{ description: string, model: string, effort: string }} role
 * @returns {string}
 */
export function renderCodexRole(name, role) {
  return [
    MANAGED_TOML,
    `name = "${name}"`,
    `description = "${role.description}"`,
    `model = "${role.model}"`,
    `model_reasoning_effort = "${role.effort}"`,
    'developer_instructions = """',
    INSTRUCTIONS[name],
    '"""',
    '',
  ].join('\n');
}

/**
 * Claude Code subagent definitions.
 * @param {{ pro?: boolean }} [opts] `pro` moves reviewer and senior to deepseek-v4-pro.
 * @returns {Record<string, { description: string, model: string, tools?: string }>}
 */
export function claudeRoles({ pro = false } = {}) {
  const readOnly = 'Read, Grep, Glob, Bash';
  return {
    explorer: {
      description: 'Fast, read-only codebase exploration on DeepSeek Flash. Use for finding files, tracing call paths, summarising modules, answering questions about existing code. Several explorers can run in parallel on independent questions.',
      model: 'deepseek-flash[1m]', tools: readOnly, effort: 'low',
    },
    worker: {
      description: 'Implementation on DeepSeek Flash for bounded, fully specified changes: a function, a test, a migration, a refactor within one module. Assign it ownership of specific files; other agents may edit the same tree in parallel, so it never reverts or reformats code it did not write, and it reports the files it touched.',
      model: 'deepseek-flash[1m]', effort: 'high',
    },
    reviewer: {
      description: `Independent review on DeepSeek ${pro ? 'V4 Pro' : 'Flash'}. Use to check a diff for bugs, missing tests and spec mismatches before the parent accepts it.`,
      model: pro ? 'deepseek-v4-pro' : 'deepseek-flash[1m]', tools: readOnly, effort: 'high',
    },
    // Same-name overrides of the built-in agents Claude reaches for on its own; the built-ins inherit the
    // main model and ignore CLAUDE_CODE_SUBAGENT_MODEL (sub-agents docs, "Built-in subagents").
    Explore: {
      description: 'Fast agent specialized for exploring codebases. Use for file discovery, code search, and codebase exploration. Runs on DeepSeek Flash.',
      model: 'deepseek-flash[1m]', tools: readOnly, effort: 'low',
    },
    Plan: {
      description: 'Codebase research for planning. Read-only. Runs on DeepSeek Flash.',
      model: 'deepseek-flash[1m]', tools: readOnly, effort: 'high',
    },
    senior: {
      description: pro
        ? 'Escalation on DeepSeek V4 Pro. Use only after a Flash worker failed twice, or for cross-module design work.'
        : "Escalation on the session's frontier model. Use only after a Flash worker failed twice, or for cross-module design work.",
      model: pro ? 'deepseek-v4-pro' : 'inherit',
    },
  };
}

/**
 * Render one Claude Code subagent file (markdown with YAML frontmatter).
 * @param {string} name
 * @param {{ description: string, model: string, tools?: string }} role
 * @returns {string}
 */
export function renderClaudeRole(name, role) {
  const frontmatter = ['---', `name: ${name}`, `description: ${role.description}`, `model: ${role.model}`];
  if (role.tools) frontmatter.push(`tools: ${role.tools}`);
  if (role.effort) frontmatter.push(`effort: ${role.effort}`);
  frontmatter.push('---');
  return [...frontmatter, MANAGED_MD, INSTRUCTIONS[name], ''].join('\n');
}

export const DELEGATION_START = '<!-- agents-switchboard delegation policy -->';
export const DELEGATION_END = '<!-- /agents-switchboard -->';

/** The delegation policy appended to AGENTS.md and CLAUDE.md (SPEC §10.3). */
export const DELEGATION_BLOCK = [
  DELEGATION_START,
  '## Delegation',
  '',
  "Subagents run on DeepSeek Flash: 1M context, roughly 50x cheaper than this session, and their context never enters yours. Every file you read, test you run, or log you scan in this session spends the expensive budget; done in a subagent it costs cents and returns a summary. Delegate by default, keep judgement here.",
  '',
  '- explorer: anything that means reading before deciding: where is X, how does Y work, what does this test output mean, what changed in this diff. Give one precise question per explorer and spawn several in parallel. Trust their file:line references; verify only what you change.',
  '- Keep the critical path here: if your very next action is blocked on the answer, read it yourself, then delegate the sidecar reading that can run while you work. Send a blocking question to Flash only when the answer replaces a large amount of reading you would otherwise do yourself.',
  '- Reuse before you respawn: for a related question about code an explorer or worker already read, continue that agent (Codex send_input or followup_task, Claude Code resuming the subagent) instead of spawning a new one; its context is already paid for. Respawn only when the question needs a clean read.',
  '- worker: implementation that fits in one message: exact files, exact behaviour, how to verify. Give it ownership of specific files; it runs the tests and reports the diff summary, the files it touched and the results. Split larger work into worker-sized pieces first.',
  '- reviewer: every non-trivial diff before you accept it, and before you tell the user it is done. Give it the base ref or commit to diff against and what "done" means; it starts with no history of this session.',
  "- senior: only after a worker failed twice on the same task, or for a decision that spans modules. Pass the failed attempt's report so it does not start from zero.",
  '',
  'Brief each subagent with the goal, the exact files or commands, and the shape of answer you want. Ask for at most a screenful back. Never paste large outputs into this session; ask an explorer to summarise them.',
  '',
  'Do not delegate: choosing an approach, resolving ambiguity with the user, anything that depends on screenshots or images unless you describe them in text first.',
  DELEGATION_END,
].join('\n');

/**
 * Insert or replace the delegation block in a markdown document. Idempotent.
 * @param {string} text existing document ('' when missing)
 * @returns {string}
 */
export function upsertDelegation(text) {
  const stripped = removeDelegation(text);
  const base = stripped.length && !stripped.endsWith('\n') ? stripped + '\n' : stripped;
  const sep = base.length ? (base.endsWith('\n\n') ? '' : '\n') : '';
  return `${base}${sep}${DELEGATION_BLOCK}\n`;
}

/**
 * Remove the delegation block. Returns the text unchanged when absent.
 * @param {string} text
 * @returns {string}
 */
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
