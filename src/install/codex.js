// Codex installer: marker-guarded edits to config.toml, role files, and the AGENTS.md delegation block (SPEC §10.1, §10.3).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { DEFAULT_PORT } from '../config.js';
import { resolvePaths } from '../paths.js';
import { backupFile, latestBackup, readTextOr, writeRoleFiles, removeRoleFiles, previewRoles, upsertDelegationFile, removeDelegationFile } from './files.js';
import { codexRoles, renderCodexRole, MANAGED_TOML, ROLE_NAMES, upsertDelegation } from './roles.js';

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
const isTableValue = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const headerName = (line) => line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?/)?.[1].trim() ?? null;
const tomlValue = (source) => parse(`x = ${source}`).x;

/**
 * Remove every line the installer previously added. Pure.
 * @param {string} text
 * @returns {string}
 */
export function stripManaged(text, { collapse = true } = {}) {
  const out = [];
  let skipUntil = null;
  let dropBlankAfter = false; // insertBaseUrl adds one blank line after its block; take it back with the block
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (skipUntil) {
      if (trimmed === skipUntil) { skipUntil = null; dropBlankAfter = trimmed === URL_END; }
      continue;
    }
    if (dropBlankAfter) {
      dropBlankAfter = false;
      if (trimmed === '' && out.at(-1)?.trim() === '') continue;
      if (trimmed === '' && out.length === 0) continue;
    }
    if (trimmed === BLOCK_START) { skipUntil = BLOCK_END; continue; }
    if (trimmed === URL_START) { skipUntil = URL_END; continue; }
    if (trimmed.endsWith(LINE_TAG) && trimmed !== LINE_TAG) continue;
    out.push(line);
  }
  const joined = out.join('\n');
  return collapse ? joined.replace(/\n{3,}/g, '\n\n') : joined;
}

/**
 * Settings that would redirect or mask the provider, or that we would have to overwrite (SPEC §10). Pure.
 * @param {object} cfg parsed TOML with managed lines already stripped
 * @param {string} ourUrl
 * @param {Set<string>} [inlineTables] managed table names written as `name = { ... }` or a scalar (see inlineTablesIn)
 * @returns {string[]} human-readable conflict descriptions, empty when none
 */
export function findConflicts(cfg, ourUrl, inlineTables = new Set()) {
  const conflicts = [];
  if (cfg.profile !== undefined) conflicts.push('profile');
  if (cfg.oss_provider !== undefined) conflicts.push('oss_provider');
  if (cfg.model_provider !== undefined && cfg.model_provider !== 'openai') conflicts.push(`model_provider = "${cfg.model_provider}"`);
  if (cfg.model_catalog_json !== undefined) conflicts.push('model_catalog_json');
  if (cfg.openai_base_url !== undefined && cfg.openai_base_url !== ourUrl) conflicts.push(`openai_base_url = "${cfg.openai_base_url}"`);
  for (const [table, keys] of Object.entries(MANAGED_TABLES)) {
    // An inline table (`agents = { ... }`) or scalar cannot take our merged keys; treat it like a foreign value.
    if (cfg[table] !== undefined && (inlineTables.has(table) || !isTableValue(cfg[table]))) { conflicts.push(`${table} written as an inline table or scalar; use a [${table}] header`); continue; }
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
  const parsed = clean.trim() ? parseNamed(clean) : {};
  const conflicts = findConflicts(parsed, url, inlineTablesIn(clean));
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
  try {
    parse(text);
  } catch (e) {
    throw new Error(`config.toml could not be merged (${e.message}); the switchboard's lines would leave it invalid. Move [agents] and [features] into standard table headers and re-run.`);
  }
  return text;
}

/** Parse TOML, naming the file in the error instead of surfacing the parser's message alone. */
function parseNamed(text) {
  try {
    return parse(text);
  } catch (e) {
    throw new Error(`config.toml is not valid TOML (${e.message}); fix it and re-run.`);
  }
}

/**
 * Names of managed tables that appear as `name = { ... }` (inline) or `name = <scalar>` at top level. Pure.
 * @param {string} text
 * @returns {Set<string>}
 */
export function inlineTablesIn(text) {
  const names = new Set();
  let inTable = false;
  for (const line of text.split('\n')) {
    if (isHeader(line)) { inTable = true; continue; }
    if (inTable) continue;
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (m && Object.hasOwn(MANAGED_TABLES, m[1])) names.add(m[1]);
  }
  return names;
}

const roleSpec = (codexHome, pro) => ({
  dir: path.join(codexHome, 'agents'), extension: '.toml', marker: MANAGED_TOML, afterFrontmatter: false,
  roles: codexRoles({ pro }), render: renderCodexRole, names: ROLE_NAMES,
});

/**
 * Settings that do not block the install but work against the DeepSeek prefix cache (SPEC §9).
 * @param {string} text config.toml text
 * @returns {string[]}
 */
export function findWarnings(text) {
  let cfg = {};
  try { cfg = text.trim() ? parse(stripManaged(text)) : {}; } catch { return []; /* reported as a conflict elsewhere */ }
  const warnings = [];
  if (cfg.context_management?.experimental_mode || cfg.features?.context_management?.experimental_mode) {
    warnings.push('context_management.experimental_mode is on in config.toml; it rewrites history more often, which costs DeepSeek prefix-cache hits.');
  }
  return warnings;
}

/**
 * Install the Codex side.
 * @param {{ codexHome?: string, port?: number, dryRun?: boolean, pro?: boolean, paths?: import('../paths.js').Paths }} [opts]
 * @returns {Promise<{ configFile: string, configChanged: boolean, backup: string|null, roles: object, agentsMd: boolean, warnings: string[], dryRun: boolean }>}
 */
export async function installCodex(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const codexHome = opts.codexHome || paths.codexHome;
  const port = opts.port || DEFAULT_PORT;
  const configFile = path.join(codexHome, 'config.toml');
  const original = readTextOr(configFile);
  const next = applyCodexConfig(original, port);
  const report = { configFile, configChanged: next !== original, backup: null, roles: {}, agentsMd: false, warnings: findWarnings(original), dryRun: !!opts.dryRun };
  if (opts.dryRun) {
    const agentsMd = path.join(codexHome, 'AGENTS.md');
    return { ...report, roles: previewRoles(roleSpec(codexHome, opts.pro)), agentsMd: upsertDelegation(readTextOr(agentsMd)) !== readTextOr(agentsMd) };
  }

  if (report.configChanged) {
    report.backup = backupFile(configFile, paths.backupsDir, 'codex-config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configFile, next);
  }
  report.roles = writeRoleFiles(roleSpec(codexHome, opts.pro));
  report.agentsMd = upsertDelegationFile(path.join(codexHome, 'AGENTS.md'));
  return report;
}

/** Whether the text carries any line the installer wrote. */
export function hasManaged(text) {
  return text.split('\n').some((line) => { const t = line.trim(); return t === BLOCK_START || t === URL_START || (t.endsWith(LINE_TAG) && t !== LINE_TAG); });
}

/** Strip our lines; if the result is not valid TOML, fall back to the latest backup. */
function revertedConfig(original, backupsDir) {
  let next = stripManaged(original, { collapse: false }).replace(/^\n+/, '').replace(/\n+$/, '');
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

  if (fs.existsSync(configFile) && hasManaged(fs.readFileSync(configFile, 'utf8'))) {
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
