// Claude Code installer: merged settings.json keys, subagent files, and the CLAUDE.md delegation block (SPEC §10.2, §10.3).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT, baseUrlFor } from '../config.js';
import { resolvePaths } from '../paths.js';
import { backupFile, readTextOr, readState, writeState, writeRoleFiles, removeRoleFiles, previewRoles, upsertDelegationFile, removeDelegationFile } from './files.js';
import { claudeRoles, renderClaudeRole, MANAGED_MD, CLAUDE_ROLE_NAMES, upsertDelegation } from './roles.js';

/** The `modelSettings` field the installer owns; merged into the model's entry, never replacing it. */
const MODEL_SETTINGS_KEY = 'deepseek-flash';
const MODEL_SETTINGS_FIELD = 'effortLevel';
const MODEL_SETTINGS_VALUE = 'high';
/** Credential-bearing env vars that would switch billing off the subscription (SPEC §10). */
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
/** Forces every subagent, including senior's `inherit`, onto the subagent model; the Explore/Plan files are the intended mechanism instead. */
const FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
/**
 * Ours whatever the port or capability token, even when state.json was lost: the tokenless form older
 * releases wrote and the `_switchboard/<token>/` form this one writes, so a reinstall migrates.
 */
const OUR_URL_SHAPE = /^http:\/\/127\.0\.0\.1:\d+\/(?:_switchboard\/[^/]+\/)?anthropic\/?$/;

/**
 * The env keys the installer owns (SPEC §10.2).
 * @param {number} port
 * @param {string} [token] capability token the router will require
 * @returns {Record<string, string>}
 */
export function managedEnv(port, token) {
  return {
    ANTHROPIC_BASE_URL: baseUrlFor(port, token, '/anthropic'),
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-flash[1m]',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek Flash',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'DeepSeek V4.1 Flash · 1M context · via switchboard',
    // Claude Code only sends output_config.effort for models it recognises; this makes it send it for the DeepSeek id too.
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
  };
}

/**
 * Settings that do not block the install but change what the role files can do (SPEC §10.2).
 * @param {object} settings parsed settings.json
 * @param {NodeJS.ProcessEnv} [processEnv]
 * @returns {string[]}
 */
export function findWarnings(settings, processEnv = {}) {
  const warnings = [];
  for (const key of CREDENTIAL_ENV) {
    if (processEnv[key]) warnings.push(`${key} is set in your shell environment; it overrides the subscription login and bypasses the switchboard for sessions started from that shell.`);
  }
  if (settings.env?.[FORCE_ENV] || processEnv[FORCE_ENV]) {
    warnings.push(`${FORCE_ENV} is set; it collapses every subagent, including senior's model: inherit, onto CLAUDE_CODE_SUBAGENT_MODEL. The Explore and Plan agent files already put Claude's built-in agents on DeepSeek, so unset it unless you want no frontier escalation.`);
  }
  return warnings;
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
  const weOwnUrl = state.env?.ANTHROPIC_BASE_URL !== undefined || OUR_URL_SHAPE.test(String(env.ANTHROPIC_BASE_URL ?? ''));
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
 * @param {{ token?: string }} [opts] capability token the router will require
 * @returns {{ settings: object, state: object }}
 * @throws {Error} when settings.json contains settings the switchboard cannot coexist with
 */
export function applyClaudeSettings(settings, port, prevState = {}, opts = {}) {
  const conflicts = findConflicts(settings, baseUrlFor(port, opts.token, '/anthropic'), prevState);
  if (conflicts.length) {
    throw new Error(`settings.json has settings the switchboard cannot coexist with: ${conflicts.join(', ')}. Remove them (they would bypass the router or bill an API key instead of your subscription) and re-run.`);
  }
  const next = structuredClone(settings);
  next.env = { ...(next.env || {}) };
  const state = { env: { ...(prevState.env || {}) }, modelSettings: prevState.modelSettings };
  for (const [key, value] of Object.entries(managedEnv(port, opts.token))) {
    if (!(key in state.env)) state.env[key] = settings.env?.[key] ?? null;
    next.env[key] = value;
  }
  next.modelSettings = { ...(next.modelSettings || {}) };
  // Record the previous value of just our field, so a level the user saved with /effort or other fields survive.
  if (state.modelSettings === undefined) state.modelSettings = settings.modelSettings?.[MODEL_SETTINGS_KEY]?.[MODEL_SETTINGS_FIELD] ?? null;
  // `effort` was the key an earlier switchboard release wrote; Claude Code reads `effortLevel`.
  const { effort: legacy, ...current } = next.modelSettings[MODEL_SETTINGS_KEY] || {};
  next.modelSettings[MODEL_SETTINGS_KEY] = { ...current, ...(legacy !== undefined && legacy !== MODEL_SETTINGS_VALUE ? { effort: legacy } : {}), [MODEL_SETTINGS_FIELD]: MODEL_SETTINGS_VALUE };
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
  if (next.modelSettings?.[MODEL_SETTINGS_KEY] && state.modelSettings !== undefined) {
    const entry = { ...next.modelSettings[MODEL_SETTINGS_KEY] };
    if (state.modelSettings === null) delete entry[MODEL_SETTINGS_FIELD];
    else entry[MODEL_SETTINGS_FIELD] = state.modelSettings;
    if (Object.keys(entry).length) next.modelSettings[MODEL_SETTINGS_KEY] = entry;
    else delete next.modelSettings[MODEL_SETTINGS_KEY];
    if (!Object.keys(next.modelSettings).length) delete next.modelSettings;
  }
  return next;
}

const renderSettings = (settings) => JSON.stringify(settings, null, 2) + '\n';

/**
 * Whether `settings` still routes Claude at us while no state says what that replaced. Only our exact
 * loopback prefix counts: a user's own `deepseek-*` model choice is theirs to keep.
 * @param {object} settings parsed settings.json
 * @returns {boolean}
 */
function unclaimedRouterUrl(settings) {
  return OUR_URL_SHAPE.test(String(settings?.env?.ANTHROPIC_BASE_URL ?? ''));
}

/**
 * Parse settings.json, reporting a corrupt file by name instead of a raw SyntaxError.
 * @param {string} file
 * @returns {object}
 */
export function readSettings(file) {
  const text = readTextOr(file);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it and re-run.`);
  }
}

const roleSpec = (claudeHome, pro) => ({
  dir: path.join(claudeHome, 'agents'), extension: '.md', marker: MANAGED_MD, afterFrontmatter: true,
  roles: claudeRoles({ pro }), render: renderClaudeRole, names: CLAUDE_ROLE_NAMES,
});

/**
 * Install the Claude Code side.
 * @param {{ claudeHome?: string, port?: number, dryRun?: boolean, pro?: boolean, token?: string, paths?: import('../paths.js').Paths, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ settingsFile: string, settingsChanged: boolean, backup: string|null, roles: object, claudeMd: boolean, warnings: string[], dryRun: boolean }>}
 */
export async function installClaude(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const claudeHome = opts.claudeHome || paths.claudeHome;
  const port = opts.port || DEFAULT_PORT;
  const processEnv = opts.env || process.env;
  const settingsFile = path.join(claudeHome, 'settings.json');
  const allState = readState(paths.stateFile);
  const { settings: next, state } = applyClaudeSettings(readSettings(settingsFile), port, allState.claude || {}, { token: opts.token });
  const nextText = renderSettings(next);
  const report = { settingsFile, settingsChanged: nextText !== readTextOr(settingsFile), backup: null, roles: {}, claudeMd: false, warnings: findWarnings(readSettings(settingsFile), processEnv), dryRun: !!opts.dryRun };
  if (opts.dryRun) {
    const claudeMd = path.join(claudeHome, 'CLAUDE.md');
    return { ...report, roles: previewRoles(roleSpec(claudeHome, opts.pro)), claudeMd: upsertDelegation(readTextOr(claudeMd)) !== readTextOr(claudeMd) };
  }

  if (report.settingsChanged) report.backup = backupFile(settingsFile, paths.backupsDir, 'claude-settings.json');
  // Record what the managed keys replaced before writing them: a crash between the two writes leaves state
  // that still reverts exactly, where the reverse order leaves Claude pointed at the router with no record
  // of the values to put back.
  writeState(paths.stateFile, { ...allState, claude: state });
  if (report.settingsChanged) {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsFile, nextText);
  }
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

  if (fs.existsSync(settingsFile)) {
    const settings = readSettings(settingsFile);
    if (allState.claude) {
      const restored = revertClaudeSettings(settings, allState.claude);
      // Compare parsed values, not text, so a file we would not actually change keeps its own formatting.
      if (JSON.stringify(restored) !== JSON.stringify(settings)) {
        backupFile(settingsFile, paths.backupsDir, 'claude-settings.json');
        fs.writeFileSync(settingsFile, renderSettings(restored));
        report.settingsChanged = true;
      }
    } else {
      // Without state there is no record of the values our keys replaced, so reverting would be a guess.
      // Refuse instead: the caller stops before removing the service, so Claude keeps working and the user
      // gets told exactly which keys to remove.
      if (unclaimedRouterUrl(settings)) throw new Error(`${settingsFile} still routes Claude through agents-switchboard (env.ANTHROPIC_BASE_URL) but ${paths.stateFile} is missing, so the value it replaced cannot be restored. Remove that key by hand (or take the matching file from ${paths.backupsDir}), then re-run \`switchboard uninstall\`. Claude's settings and the running router were left as they are.`);
    }
  }
  const { claude: _recorded, ...remainingState } = allState;
  writeState(paths.stateFile, remainingState);
  report.roles = removeRoleFiles(roleSpec(claudeHome, false));
  report.claudeMd = removeDelegationFile(path.join(claudeHome, 'CLAUDE.md'));
  return report;
}
