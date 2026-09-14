// Codex installer: marker-guarded edits to config.toml, role files, and the AGENTS.md delegation block (SPEC §10.1, §10.3).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { DEFAULT_PORT } from '../config.js';
import { resolvePaths } from '../paths.js';
import { backupFile, latestBackup, readTextOr, writeRoleFiles, removeRoleFiles, upsertDelegationFile, removeDelegationFile } from './files.js';
import { codexRoles, renderCodexRole, MANAGED_TOML, ROLE_NAMES } from './roles.js';

const BLOCK_START = '# >>> agents-switchboard >>>';
const BLOCK_END = '# <<< agents-switchboard <<<';
const URL_START = '# >>> agents-switchboard:base_url >>>';
const URL_END = '# <<< agents-switchboard:base_url <<<';
const LINE_TAG = '# agents-switchboard';

/** The keys the installer owns inside each table, as TOML source text (SPEC §10.1). */
const MANAGED_TABLES = {
  agents: [
    ['default_subagent_model', '"deepseek-flash"'],
    ['default_subagent_reasoning_effort', '"high"'],
    ['max_concurrent_threads_per_session', '8'],
  ],
  features: [['multi_agent_v2', 'false']],
};

/**
 * The `openai_base_url` that keeps ChatGPT auth while routing through the switchboard (SPEC §2).
 * @param {number} port
 * @returns {string}
 */
export function baseUrlFor(port) {
  return `http://127.0.0.1:${port}/backend-api/codex`;
}

const isHeader = (line) => /^\s*\[/.test(line);
const headerName = (line) => line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?/)?.[1].trim() ?? null;
const tomlValue = (source) => parse(`x = ${source}`).x;

/**
 * Remove every line the installer previously added. Pure.
 * @param {string} text
 * @returns {string}
 */
export function stripManaged(text) {
  const out = [];
  let skipUntil = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (skipUntil) {
      if (trimmed === skipUntil) skipUntil = null;
      continue;
    }
    if (trimmed === BLOCK_START) { skipUntil = BLOCK_END; continue; }
    if (trimmed === URL_START) { skipUntil = URL_END; continue; }
    if (trimmed.endsWith(LINE_TAG) && trimmed !== LINE_TAG) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Settings that would redirect or mask the provider, or that we would have to overwrite (SPEC §10). Pure.
 * @param {object} cfg parsed TOML with managed lines already stripped
 * @param {string} ourUrl
 * @returns {string[]} human-readable conflict descriptions, empty when none
 */
export function findConflicts(cfg, ourUrl) {
  const conflicts = [];
  if (cfg.profile !== undefined) conflicts.push('profile');
  if (cfg.oss_provider !== undefined) conflicts.push('oss_provider');
  if (cfg.model_provider !== undefined && cfg.model_provider !== 'openai') conflicts.push(`model_provider = "${cfg.model_provider}"`);
  if (cfg.model_catalog_json !== undefined) conflicts.push('model_catalog_json');
  if (cfg.openai_base_url !== undefined && cfg.openai_base_url !== ourUrl) conflicts.push(`openai_base_url = "${cfg.openai_base_url}"`);
  for (const [table, keys] of Object.entries(MANAGED_TABLES)) {
    for (const [key, source] of keys) {
      const existing = cfg[table]?.[key];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(tomlValue(source))) {
        conflicts.push(`${table}.${key} = ${JSON.stringify(existing)}`);
      }
    }
  }
  return conflicts;
}

/** Line range [start, end) covering the header and body of table `name`, or null. */
function tableRange(lines, name) {
  const start = lines.findIndex((l) => isHeader(l) && headerName(l) === name);
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && isHeader(l));
  return { start, end: next === -1 ? lines.length : next };
}

/** Insert the base-url lines before the first table header, so the key stays top-level. */
function insertBaseUrl(lines, url) {
  const urlLines = [URL_START, `openai_base_url = "${url}"`, URL_END];
  const firstHeader = lines.findIndex(isHeader);
  if (firstHeader === -1) lines.push(...(lines.length ? [''] : []), ...urlLines);
  else lines.splice(firstHeader, 0, ...urlLines, '');
}

/** Merge missing managed keys into an existing table (tagged per line) or collect them for the appended block. */
function mergeTable(lines, table, missing, appended) {
  const range = tableRange(lines, table);
  const rendered = missing.map(([key, source]) => `${key} = ${source} ${LINE_TAG}`);
  if (!range) {
    appended.push(`[${table}]`, ...rendered.map((l) => l.replace(` ${LINE_TAG}`, '')), '');
    return;
  }
  let insertAt = range.end;
  while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, ...rendered);
}

/**
 * Produce the config text with the switchboard settings applied. Pure and idempotent.
 * @param {string} original current config.toml text ('' when missing)
 * @param {number} port
 * @returns {string}
 * @throws {Error} when the config contains settings the switchboard cannot coexist with
 */
export function applyCodexConfig(original, port) {
  const url = baseUrlFor(port);
  const clean = stripManaged(original);
  const parsed = clean.trim() ? parse(clean) : {};
  const conflicts = findConflicts(parsed, url);
  if (conflicts.length) {
    throw new Error(`config.toml has settings the switchboard cannot coexist with: ${conflicts.join(', ')}. Remove them (or move them to a profile you do not use with the switchboard) and re-run.`);
  }

  const lines = clean.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (parsed.openai_base_url !== url) insertBaseUrl(lines, url);

  const appended = [];
  for (const [table, keys] of Object.entries(MANAGED_TABLES)) {
    const missing = keys.filter(([key]) => parsed[table]?.[key] === undefined);
    if (missing.length) mergeTable(lines, table, missing, appended);
  }
  if (appended.length) {
    appended.pop();
    lines.push('', BLOCK_START, ...appended, BLOCK_END);
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  parse(text); // must still be valid TOML
  return text;
}

const roleSpec = (codexHome, pro) => ({
  dir: path.join(codexHome, 'agents'), extension: '.toml', marker: MANAGED_TOML, afterFrontmatter: false,
  roles: codexRoles({ pro }), render: renderCodexRole, names: ROLE_NAMES,
});

/**
 * Install the Codex side.
 * @param {{ codexHome?: string, port?: number, dryRun?: boolean, pro?: boolean, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ configFile: string, configChanged: boolean, backup: string|null, roles: object, agentsMd: boolean, dryRun: boolean }>}
 */
export async function installCodex(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const codexHome = opts.codexHome || paths.codexHome;
  const port = opts.port || DEFAULT_PORT;
  const configFile = path.join(codexHome, 'config.toml');
  const original = readTextOr(configFile);
  const next = applyCodexConfig(original, port);
  const report = { configFile, configChanged: next !== original, backup: null, roles: {}, agentsMd: false, dryRun: !!opts.dryRun };
  if (opts.dryRun) return report;

  if (report.configChanged) {
    report.backup = backupFile(configFile, paths.backupsDir, 'codex-config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configFile, next);
  }
  report.roles = writeRoleFiles(roleSpec(codexHome, opts.pro));
  report.agentsMd = upsertDelegationFile(path.join(codexHome, 'AGENTS.md'));
  return report;
}

/** Strip our lines; if the result is not valid TOML, fall back to the latest backup. */
function revertedConfig(original, backupsDir) {
  let next = stripManaged(original).replace(/^\n+/, '').replace(/\n+$/, '');
  if (next.length) next += '\n';
  try {
    parse(next);
    return { next, restoredFromBackup: null };
  } catch {
    // Our line-level strip left invalid TOML (the user edited inside our markers); restore the copy we took.
    const backup = latestBackup(backupsDir, 'codex-config.toml');
    return backup ? { next: fs.readFileSync(backup, 'utf8'), restoredFromBackup: backup } : { next, restoredFromBackup: null };
  }
}

/**
 * Remove everything installCodex added.
 * @param {{ codexHome?: string, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ configFile: string, configChanged: boolean, restoredFromBackup: string|null, roles: object, agentsMd: boolean }>}
 */
export async function uninstallCodex(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const codexHome = opts.codexHome || paths.codexHome;
  const configFile = path.join(codexHome, 'config.toml');
  const report = { configFile, configChanged: false, restoredFromBackup: null, roles: {}, agentsMd: false };

  if (fs.existsSync(configFile)) {
    const original = fs.readFileSync(configFile, 'utf8');
    const { next, restoredFromBackup } = revertedConfig(original, paths.backupsDir);
    report.restoredFromBackup = restoredFromBackup;
    if (next !== original) {
      backupFile(configFile, paths.backupsDir, 'codex-config.toml');
      fs.writeFileSync(configFile, next);
      report.configChanged = true;
    }
  }
  report.roles = removeRoleFiles(roleSpec(codexHome, false));
  report.agentsMd = removeDelegationFile(path.join(codexHome, 'AGENTS.md'));
  return report;
}
