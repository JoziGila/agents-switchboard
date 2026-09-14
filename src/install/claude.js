import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../paths.js';
import { DEFAULT_PORT } from '../config.js';
import { backupFile, writeManaged, removeManaged, writeIfChanged, readState, writeState } from './files.js';
import { claudeRoles, renderClaudeRole, upsertDelegation, removeDelegation, MANAGED_MD } from './roles.js';

const ROLE_NAMES = ['explorer', 'worker', 'reviewer', 'senior'];

export function baseUrlFor(port) {
  return `http://127.0.0.1:${port}/anthropic`;
}

/** The env keys the installer owns (SPEC §10.2). */
export function managedEnv(port) {
  return {
    ANTHROPIC_BASE_URL: baseUrlFor(port),
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-flash[1m]',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek Flash',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'DeepSeek V4.1 Flash · 1M context · via switchboard',
  };
}

const MODEL_SETTINGS = { 'deepseek-flash': { effort: 'high' } };

/**
 * Settings that would switch billing off the subscription or bypass the switchboard. Pure.
 * @param {object} settings parsed settings.json
 * @param {string} ourUrl
 * @param {object} state previously recorded installer state for this client
 */
export function findConflicts(settings, ourUrl, state = {}) {
  const env = settings.env || {};
  const c = [];
  if (env.ANTHROPIC_API_KEY !== undefined) c.push('env.ANTHROPIC_API_KEY');
  if (env.ANTHROPIC_AUTH_TOKEN !== undefined) c.push('env.ANTHROPIC_AUTH_TOKEN');
  if (settings.apiKeyHelper !== undefined) c.push('apiKeyHelper');
  const ownedUrl = state.env?.ANTHROPIC_BASE_URL !== undefined;
  if (env.ANTHROPIC_BASE_URL !== undefined && env.ANTHROPIC_BASE_URL !== ourUrl && !ownedUrl) {
    c.push(`env.ANTHROPIC_BASE_URL = "${env.ANTHROPIC_BASE_URL}"`);
  }
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_USE_')) c.push(`env.${k}`);
  return c;
}

/**
 * Merge the managed keys into a settings object. Pure; returns the new settings and what was recorded.
 * @param {object} settings
 * @param {number} port
 * @param {object} prevState state.claude from a previous install, if any
 */
export function applyClaudeSettings(settings, port, prevState = {}) {
  const url = baseUrlFor(port);
  const conflicts = findConflicts(settings, url, prevState);
  if (conflicts.length) {
    throw new Error(`settings.json has settings the switchboard cannot coexist with: ${conflicts.join(', ')}`);
  }
  const next = structuredClone(settings);
  next.env = { ...(next.env || {}) };
  const state = { env: { ...(prevState.env || {}) }, modelSettings: prevState.modelSettings };
  for (const [k, v] of Object.entries(managedEnv(port))) {
    if (!(k in state.env)) state.env[k] = settings.env?.[k] === undefined ? null : settings.env[k];
    next.env[k] = v;
  }
  next.modelSettings = { ...(next.modelSettings || {}) };
  if (state.modelSettings === undefined) {
    state.modelSettings = settings.modelSettings?.['deepseek-flash'] === undefined ? null : settings.modelSettings['deepseek-flash'];
  }
  next.modelSettings['deepseek-flash'] = structuredClone(MODEL_SETTINGS['deepseek-flash']);
  return { settings: next, state };
}

/** Undo applyClaudeSettings using the recorded state. Pure. */
export function revertClaudeSettings(settings, state = {}) {
  const next = structuredClone(settings);
  if (next.env) {
    for (const [k, prev] of Object.entries(state.env || {})) {
      if (prev === null) delete next.env[k]; else next.env[k] = prev;
    }
    if (!Object.keys(next.env).length) delete next.env;
  }
  if (next.modelSettings && state.modelSettings !== undefined) {
    if (state.modelSettings === null) delete next.modelSettings['deepseek-flash'];
    else next.modelSettings['deepseek-flash'] = state.modelSettings;
    if (!Object.keys(next.modelSettings).length) delete next.modelSettings;
  }
  return next;
}

const render = (obj) => JSON.stringify(obj, null, 2) + '\n';

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}

/**
 * Install the Claude Code side (SPEC §10.2, §10.3).
 * @param {{ claudeHome?: string, port?: number, dryRun?: boolean, pro?: boolean, paths?: import('../paths.js').Paths, env?: NodeJS.ProcessEnv }} opts
 */
export async function installClaude(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const claudeHome = opts.claudeHome || paths.claudeHome;
  const port = opts.port || DEFAULT_PORT;
  const procEnv = opts.env || process.env;
  const settingsFile = path.join(claudeHome, 'settings.json');
  const allState = readState(paths.stateFile);
  const settings = readSettings(settingsFile);
  const { settings: next, state } = applyClaudeSettings(settings, port, allState.claude || {});
  const nextText = render(next);
  const currentText = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
  const report = { settingsFile, settingsChanged: nextText !== currentText, backup: null, roles: {}, claudeMd: false, warnings: [], dryRun: !!opts.dryRun };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (procEnv[k]) report.warnings.push(`${k} is set in your shell environment; it will override the subscription login and bypass the switchboard for sessions started from that shell.`);
  }
  if (opts.dryRun) return report;

  if (report.settingsChanged) {
    report.backup = backupFile(settingsFile, paths.backupsDir, 'claude-settings.json');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsFile, nextText);
  }
  writeState(paths.stateFile, { ...allState, claude: state });

  const roles = claudeRoles({ pro: opts.pro });
  for (const name of ROLE_NAMES) {
    const file = path.join(claudeHome, 'agents', `${name}.md`);
    report.roles[name] = writeManaged(file, renderClaudeRole(name, roles[name]), MANAGED_MD, true);
  }

  const claudeMd = path.join(claudeHome, 'CLAUDE.md');
  const md = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
  report.claudeMd = writeIfChanged(claudeMd, upsertDelegation(md));
  return report;
}

/**
 * Remove everything installClaude added, restoring overwritten values from state.
 * @param {{ claudeHome?: string, paths?: import('../paths.js').Paths }} opts
 */
export async function uninstallClaude(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const claudeHome = opts.claudeHome || paths.claudeHome;
  const settingsFile = path.join(claudeHome, 'settings.json');
  const allState = readState(paths.stateFile);
  const report = { settingsFile, settingsChanged: false, roles: {}, claudeMd: false };

  if (fs.existsSync(settingsFile) && allState.claude) {
    const current = fs.readFileSync(settingsFile, 'utf8');
    const nextText = render(revertClaudeSettings(JSON.parse(current), allState.claude));
    if (nextText !== current) {
      backupFile(settingsFile, paths.backupsDir, 'claude-settings.json');
      fs.writeFileSync(settingsFile, nextText);
      report.settingsChanged = true;
    }
  }
  const { claude: _dropped, ...rest } = allState;
  writeState(paths.stateFile, rest);

  for (const name of ROLE_NAMES) {
    report.roles[name] = removeManaged(path.join(claudeHome, 'agents', `${name}.md`), MANAGED_MD, true) ? 'removed' : 'kept';
  }

  const claudeMd = path.join(claudeHome, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    const md = fs.readFileSync(claudeMd, 'utf8');
    report.claudeMd = writeIfChanged(claudeMd, removeDelegation(md));
  }
  return report;
}
