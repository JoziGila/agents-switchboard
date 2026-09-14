// Claude Code installer: merged settings.json keys, subagent files, and the CLAUDE.md delegation block (SPEC §10.2, §10.3).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT } from '../config.js';
import { resolvePaths } from '../paths.js';
import { backupFile, readTextOr, readState, writeState, writeRoleFiles, removeRoleFiles, upsertDelegationFile, removeDelegationFile } from './files.js';
import { claudeRoles, renderClaudeRole, MANAGED_MD, ROLE_NAMES } from './roles.js';

/** The `modelSettings` entry the installer owns. */
const MODEL_SETTINGS_KEY = 'deepseek-flash';
const MODEL_SETTINGS_VALUE = Object.freeze({ effort: 'high' });
/** Credential-bearing env vars that would switch billing off the subscription (SPEC §10). */
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * The `ANTHROPIC_BASE_URL` for the switchboard's Anthropic-format prefix.
 * @param {number} port
 * @returns {string}
 */
export function baseUrlFor(port) {
  return `http://127.0.0.1:${port}/anthropic`;
}

/**
 * The env keys the installer owns (SPEC §10.2).
 * @param {number} port
 * @returns {Record<string, string>}
 */
export function managedEnv(port) {
  return {
    ANTHROPIC_BASE_URL: baseUrlFor(port),
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-flash[1m]',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek Flash',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'DeepSeek V4.1 Flash · 1M context · via switchboard',
  };
}

/**
 * Settings that would switch billing off the subscription or bypass the switchboard. Pure.
 * @param {object} settings parsed settings.json
 * @param {string} ourUrl
 * @param {object} [state] previously recorded installer state for this client
 * @returns {string[]} human-readable conflict descriptions, empty when none
 */
export function findConflicts(settings, ourUrl, state = {}) {
  const env = settings.env || {};
  const conflicts = [];
  for (const key of CREDENTIAL_ENV) if (env[key] !== undefined) conflicts.push(`env.${key}`);
  if (settings.apiKeyHelper !== undefined) conflicts.push('apiKeyHelper');
  const weOwnUrl = state.env?.ANTHROPIC_BASE_URL !== undefined;
  if (env.ANTHROPIC_BASE_URL !== undefined && env.ANTHROPIC_BASE_URL !== ourUrl && !weOwnUrl) {
    conflicts.push(`env.ANTHROPIC_BASE_URL = "${env.ANTHROPIC_BASE_URL}"`);
  }
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_CODE_USE_')) conflicts.push(`env.${key}`);
  return conflicts;
}

/**
 * Merge the managed keys into a settings object. Pure.
 * The returned `state` records each previous value (null when the key was absent) so revert is exact.
 * @param {object} settings
 * @param {number} port
 * @param {object} [prevState] state.claude from a previous install
 * @returns {{ settings: object, state: object }}
 * @throws {Error} when settings.json contains settings the switchboard cannot coexist with
 */
export function applyClaudeSettings(settings, port, prevState = {}) {
  const conflicts = findConflicts(settings, baseUrlFor(port), prevState);
  if (conflicts.length) {
    throw new Error(`settings.json has settings the switchboard cannot coexist with: ${conflicts.join(', ')}. Remove them (they would bypass the router or bill an API key instead of your subscription) and re-run.`);
  }
  const next = structuredClone(settings);
  next.env = { ...(next.env || {}) };
  const state = { env: { ...(prevState.env || {}) }, modelSettings: prevState.modelSettings };
  for (const [key, value] of Object.entries(managedEnv(port))) {
    if (!(key in state.env)) state.env[key] = settings.env?.[key] ?? null;
    next.env[key] = value;
  }
  next.modelSettings = { ...(next.modelSettings || {}) };
  if (state.modelSettings === undefined) state.modelSettings = settings.modelSettings?.[MODEL_SETTINGS_KEY] ?? null;
  next.modelSettings[MODEL_SETTINGS_KEY] = { ...MODEL_SETTINGS_VALUE };
  return { settings: next, state };
}

/**
 * Undo applyClaudeSettings using the recorded state. Pure.
 * @param {object} settings
 * @param {object} [state]
 * @returns {object}
 */
export function revertClaudeSettings(settings, state = {}) {
  const next = structuredClone(settings);
  if (next.env) {
    for (const [key, previous] of Object.entries(state.env || {})) {
      if (previous === null) delete next.env[key]; else next.env[key] = previous;
    }
    if (!Object.keys(next.env).length) delete next.env;
  }
  if (next.modelSettings && state.modelSettings !== undefined) {
    if (state.modelSettings === null) delete next.modelSettings[MODEL_SETTINGS_KEY];
    else next.modelSettings[MODEL_SETTINGS_KEY] = state.modelSettings;
    if (!Object.keys(next.modelSettings).length) delete next.modelSettings;
  }
  return next;
}

const renderSettings = (settings) => JSON.stringify(settings, null, 2) + '\n';

function readSettings(file) {
  const text = readTextOr(file);
  return text.trim() ? JSON.parse(text) : {};
}

const roleSpec = (claudeHome, pro) => ({
  dir: path.join(claudeHome, 'agents'), extension: '.md', marker: MANAGED_MD, afterFrontmatter: true,
  roles: claudeRoles({ pro }), render: renderClaudeRole, names: ROLE_NAMES,
});

/**
 * Install the Claude Code side.
 * @param {{ claudeHome?: string, port?: number, dryRun?: boolean, pro?: boolean, paths?: import('../paths.js').Paths, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ settingsFile: string, settingsChanged: boolean, backup: string|null, roles: object, claudeMd: boolean, warnings: string[], dryRun: boolean }>}
 */
export async function installClaude(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const claudeHome = opts.claudeHome || paths.claudeHome;
  const port = opts.port || DEFAULT_PORT;
  const processEnv = opts.env || process.env;
  const settingsFile = path.join(claudeHome, 'settings.json');
  const allState = readState(paths.stateFile);
  const { settings: next, state } = applyClaudeSettings(readSettings(settingsFile), port, allState.claude || {});
  const nextText = renderSettings(next);
  const report = { settingsFile, settingsChanged: nextText !== readTextOr(settingsFile), backup: null, roles: {}, claudeMd: false, warnings: [], dryRun: !!opts.dryRun };
  for (const key of CREDENTIAL_ENV) {
    if (processEnv[key]) report.warnings.push(`${key} is set in your shell environment; it overrides the subscription login and bypasses the switchboard for sessions started from that shell.`);
  }
  if (opts.dryRun) return report;

  if (report.settingsChanged) {
    report.backup = backupFile(settingsFile, paths.backupsDir, 'claude-settings.json');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsFile, nextText);
  }
  writeState(paths.stateFile, { ...allState, claude: state });
  report.roles = writeRoleFiles(roleSpec(claudeHome, opts.pro));
  report.claudeMd = upsertDelegationFile(path.join(claudeHome, 'CLAUDE.md'));
  return report;
}

/**
 * Remove everything installClaude added, restoring overwritten values from state.
 * @param {{ claudeHome?: string, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ settingsFile: string, settingsChanged: boolean, roles: object, claudeMd: boolean }>}
 */
export async function uninstallClaude(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const claudeHome = opts.claudeHome || paths.claudeHome;
  const settingsFile = path.join(claudeHome, 'settings.json');
  const allState = readState(paths.stateFile);
  const report = { settingsFile, settingsChanged: false, roles: {}, claudeMd: false };

  if (fs.existsSync(settingsFile) && allState.claude) {
    const current = fs.readFileSync(settingsFile, 'utf8');
    const nextText = renderSettings(revertClaudeSettings(JSON.parse(current), allState.claude));
    if (nextText !== current) {
      backupFile(settingsFile, paths.backupsDir, 'claude-settings.json');
      fs.writeFileSync(settingsFile, nextText);
      report.settingsChanged = true;
    }
  }
  const { claude: _recorded, ...remainingState } = allState;
  writeState(paths.stateFile, remainingState);
  report.roles = removeRoleFiles(roleSpec(claudeHome, false));
  report.claudeMd = removeDelegationFile(path.join(claudeHome, 'CLAUDE.md'));
  return report;
}
