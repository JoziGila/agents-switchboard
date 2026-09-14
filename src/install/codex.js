import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { resolvePaths } from '../paths.js';
import { DEFAULT_PORT } from '../config.js';
import { backupFile, writeManaged, removeManaged, writeIfChanged } from './files.js';
import { codexRoles, renderCodexRole, upsertDelegation, removeDelegation, MANAGED_TOML } from './roles.js';

const BLOCK_START = '# >>> agents-switchboard >>>';
const BLOCK_END = '# <<< agents-switchboard <<<';
const URL_START = '# >>> agents-switchboard:base_url >>>';
const URL_END = '# <<< agents-switchboard:base_url <<<';
const LINE_TAG = '# agents-switchboard';
const ROLE_NAMES = ['explorer', 'worker', 'reviewer', 'senior'];

/** The keys the installer owns inside each table (SPEC §10.1). */
const MANAGED_TABLES = {
  agents: [
    ['default_subagent_model', '"deepseek-flash"'],
    ['default_subagent_reasoning_effort', '"high"'],
    ['max_concurrent_threads_per_session', '8'],
  ],
  features: [['multi_agent_v2', 'false']],
};

export function baseUrlFor(port) {
  return `http://127.0.0.1:${port}/backend-api/codex`;
}

const isHeader = (line) => /^\s*\[/.test(line);
const headerName = (line) => {
  const m = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?/);
  return m ? m[1].trim() : null;
};

/**
 * Remove every line the installer previously added. Pure.
 * @param {string} text
 */
export function stripManaged(text) {
  const out = [];
  let skipping = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (skipping) {
      if (t === skipping) skipping = null;
      continue;
    }
    if (t === BLOCK_START) { skipping = BLOCK_END; continue; }
    if (t === URL_START) { skipping = URL_END; continue; }
    if (t.endsWith(LINE_TAG) && t !== LINE_TAG) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Settings that would redirect or mask the provider (SPEC §10). Pure.
 * @param {object} cfg parsed TOML with managed lines already stripped
 * @param {string} ourUrl
 * @returns {string[]}
 */
export function findConflicts(cfg, ourUrl) {
  const c = [];
  if (cfg.profile !== undefined) c.push('profile');
  if (cfg.oss_provider !== undefined) c.push('oss_provider');
  if (cfg.model_provider !== undefined && cfg.model_provider !== 'openai') c.push(`model_provider = "${cfg.model_provider}"`);
  if (cfg.model_catalog_json !== undefined) c.push('model_catalog_json');
  if (cfg.openai_base_url !== undefined && cfg.openai_base_url !== ourUrl) c.push(`openai_base_url = "${cfg.openai_base_url}"`);
  for (const [table, keys] of Object.entries(MANAGED_TABLES)) {
    for (const [key, value] of keys) {
      const existing = cfg[table]?.[key];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(parse(`x = ${value}`).x)) {
        c.push(`${table}.${key} = ${JSON.stringify(existing)}`);
      }
    }
  }
  return c;
}

/** Index of the first table header line, or -1. */
function firstHeaderIndex(lines) {
  return lines.findIndex(isHeader);
}

/** Line range [start, end) of the body of table `name`, or null. */
function tableRange(lines, name) {
  const start = lines.findIndex((l) => isHeader(l) && headerName(l) === name);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeader(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/**
 * Produce the config text with the switchboard settings applied. Pure.
 * @param {string} original
 * @param {number} port
 */
export function applyCodexConfig(original, port) {
  const url = baseUrlFor(port);
  const clean = stripManaged(original);
  const parsed = clean.trim() ? parse(clean) : {};
  const conflicts = findConflicts(parsed, url);
  if (conflicts.length) {
    throw new Error(`config.toml has settings the switchboard cannot coexist with: ${conflicts.join(', ')}`);
  }

  let lines = clean.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  // 1. openai_base_url: a top-level key, so it must precede the first table header.
  if (parsed.openai_base_url !== url) {
    const urlLines = [URL_START, `openai_base_url = "${url}"`, URL_END];
    const at = firstHeaderIndex(lines);
    if (at === -1) lines.push(...(lines.length ? [''] : []), ...urlLines);
    else lines.splice(at, 0, ...urlLines, '');
  }

  // 2. [agents] and [features]: merge into existing tables, else append inside the block.
  const appended = [];
  for (const [table, keys] of Object.entries(MANAGED_TABLES)) {
    const missing = keys.filter(([key]) => parsed[table]?.[key] === undefined);
    if (!missing.length) continue;
    const range = tableRange(lines, table);
    const rendered = missing.map(([k, v]) => `${k} = ${v} ${LINE_TAG}`);
    if (range) {
      let insertAt = range.end;
      while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
      lines.splice(insertAt, 0, ...rendered);
    } else {
      appended.push(`[${table}]`, ...rendered.map((l) => l.replace(` ${LINE_TAG}`, '')), '');
    }
  }
  if (appended.length) {
    appended.pop();
    lines.push('', BLOCK_START, ...appended, BLOCK_END);
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  parse(text); // must still be valid TOML
  return text;
}

/**
 * Install the Codex side (SPEC §10.1, §10.3).
 * @param {{ codexHome?: string, port?: number, dryRun?: boolean, pro?: boolean, paths?: import('../paths.js').Paths }} opts
 */
export async function installCodex(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const codexHome = opts.codexHome || paths.codexHome;
  const port = opts.port || DEFAULT_PORT;
  const configFile = path.join(codexHome, 'config.toml');
  const original = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const next = applyCodexConfig(original, port);
  const report = { configFile, configChanged: next !== original, backup: null, roles: {}, agentsMd: false, dryRun: !!opts.dryRun };
  if (opts.dryRun) return report;

  if (report.configChanged) {
    report.backup = backupFile(configFile, paths.backupsDir, 'codex-config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configFile, next);
  }

  const roles = codexRoles({ pro: opts.pro });
  for (const name of ROLE_NAMES) {
    const file = path.join(codexHome, 'agents', `${name}.toml`);
    report.roles[name] = writeManaged(file, renderCodexRole(name, roles[name]), MANAGED_TOML);
  }

  const agentsMd = path.join(codexHome, 'AGENTS.md');
  const md = fs.existsSync(agentsMd) ? fs.readFileSync(agentsMd, 'utf8') : '';
  report.agentsMd = writeIfChanged(agentsMd, upsertDelegation(md));
  return report;
}

/**
 * Remove everything installCodex added. Restores config.toml from the latest backup if the edit leaves invalid TOML.
 * @param {{ codexHome?: string, paths?: import('../paths.js').Paths }} opts
 */
export async function uninstallCodex(opts = {}) {
  const paths = opts.paths || resolvePaths();
  const codexHome = opts.codexHome || paths.codexHome;
  const configFile = path.join(codexHome, 'config.toml');
  const report = { configFile, configChanged: false, restoredFromBackup: null, roles: {}, agentsMd: false };

  if (fs.existsSync(configFile)) {
    const original = fs.readFileSync(configFile, 'utf8');
    let next = stripManaged(original).replace(/^\n+/, '').replace(/\n+$/, '');
    if (next.length) next += '\n';
    try {
      parse(next);
    } catch {
      const backup = latestBackup(paths.backupsDir, 'codex-config.toml');
      if (backup) { next = fs.readFileSync(backup, 'utf8'); report.restoredFromBackup = backup; }
    }
    if (next !== original) {
      backupFile(configFile, paths.backupsDir, 'codex-config.toml');
      fs.writeFileSync(configFile, next);
      report.configChanged = true;
    }
  }

  for (const name of ROLE_NAMES) {
    report.roles[name] = removeManaged(path.join(codexHome, 'agents', `${name}.toml`), MANAGED_TOML) ? 'removed' : 'kept';
  }

  const agentsMd = path.join(codexHome, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    const md = fs.readFileSync(agentsMd, 'utf8');
    report.agentsMd = writeIfChanged(agentsMd, removeDelegation(md));
  }
  return report;
}

function latestBackup(backupsDir, name) {
  if (!fs.existsSync(backupsDir)) return null;
  const dirs = fs.readdirSync(backupsDir).sort().reverse();
  for (const d of dirs) {
    const f = path.join(backupsDir, d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
