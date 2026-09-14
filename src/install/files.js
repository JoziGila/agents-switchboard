// File helpers shared by both client installers: backups, managed-file markers, role files, installer state.
import fs from 'node:fs';
import path from 'node:path';
import { backupStamp } from '../paths.js';
import { upsertDelegation, removeDelegation } from './roles.js';

/**
 * Read a text file, or return `fallback` when it does not exist.
 * @param {string} file
 * @param {string} [fallback]
 * @returns {string}
 */
export function readTextOr(file, fallback = '') {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;
}

/**
 * Copy `file` into a fresh timestamped backup directory.
 * @param {string} file
 * @param {string} backupsDir
 * @param {string} name file name inside the backup directory
 * @param {string} [stamp]
 * @returns {string|null} the backup path, or null when `file` does not exist
 */
export function backupFile(file, backupsDir, name, stamp = backupStamp()) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(backupsDir, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, name);
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * Most recent backup of `name`, or null.
 * @param {string} backupsDir
 * @param {string} name
 * @returns {string|null}
 */
export function latestBackup(backupsDir, name) {
  if (!fs.existsSync(backupsDir)) return null;
  for (const dir of fs.readdirSync(backupsDir).sort().reverse()) {
    const candidate = path.join(backupsDir, dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Write only when the content differs, creating parent directories.
 * @param {string} file
 * @param {string} content
 * @returns {boolean} true when written
 */
export function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

/**
 * Whether a file carries the managed marker: on its first line, or, for markdown with YAML
 * frontmatter, on the first non-empty line after the closing `---`.
 * @param {string} text
 * @param {string} marker
 * @param {boolean} [afterFrontmatter]
 * @returns {boolean}
 */
export function isManaged(text, marker, afterFrontmatter = false) {
  let lines = text.split('\n');
  if (afterFrontmatter && lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close !== -1) lines = lines.slice(close + 1);
  }
  const first = lines.find((l) => l.trim() !== '') ?? '';
  return first.trim() === marker;
}

/**
 * Write a managed file unless an unmanaged file already occupies the path.
 * @param {string} file
 * @param {string} content
 * @param {string} marker
 * @param {boolean} [afterFrontmatter]
 * @returns {'written'|'unchanged'|'skipped'}
 */
export function writeManaged(file, content, marker, afterFrontmatter = false) {
  if (fs.existsSync(file) && !isManaged(fs.readFileSync(file, 'utf8'), marker, afterFrontmatter)) return 'skipped';
  return writeIfChanged(file, content) ? 'written' : 'unchanged';
}

/**
 * Delete a file only if it carries the managed marker.
 * @param {string} file
 * @param {string} marker
 * @param {boolean} [afterFrontmatter]
 * @returns {boolean} true when deleted
 */
export function removeManaged(file, marker, afterFrontmatter = false) {
  if (!fs.existsSync(file) || !isManaged(fs.readFileSync(file, 'utf8'), marker, afterFrontmatter)) return false;
  fs.unlinkSync(file);
  return true;
}

/**
 * @typedef {object} RoleFileSpec
 * @property {string} dir               directory holding the role files
 * @property {string} extension         `.toml` or `.md`
 * @property {string} marker            managed-file marker for this file type
 * @property {boolean} afterFrontmatter whether the marker sits after YAML frontmatter
 * @property {Record<string, object>} roles   role name → role definition
 * @property {(name: string, role: object) => string} render
 */

/**
 * Write every role file, leaving unmanaged files alone.
 * @param {RoleFileSpec} spec
 * @returns {Record<string, 'written'|'unchanged'|'skipped'>}
 */
export function writeRoleFiles({ dir, extension, marker, afterFrontmatter, roles, render }) {
  const report = {};
  for (const [name, role] of Object.entries(roles)) {
    report[name] = writeManaged(path.join(dir, name + extension), render(name, role), marker, afterFrontmatter);
  }
  return report;
}

/**
 * What writeRoleFiles would report, without touching the filesystem.
 * @param {RoleFileSpec} spec
 * @returns {Record<string, 'written'|'unchanged'|'skipped'>}
 */
export function previewRoles({ dir, extension, marker, afterFrontmatter, roles, render }) {
  const report = {};
  for (const [name, role] of Object.entries(roles)) {
    const file = path.join(dir, name + extension);
    const content = render(name, role);
    if (!fs.existsSync(file)) { report[name] = 'written'; continue; }
    const current = fs.readFileSync(file, 'utf8');
    report[name] = !isManaged(current, marker, afterFrontmatter) ? 'skipped' : current === content ? 'unchanged' : 'written';
  }
  return report;
}

/**
 * Remove every managed role file.
 * @param {Pick<RoleFileSpec, 'dir'|'extension'|'marker'|'afterFrontmatter'> & { names: string[] }} spec
 * @returns {Record<string, 'removed'|'kept'>}
 */
export function removeRoleFiles({ dir, extension, marker, afterFrontmatter, names }) {
  const report = {};
  for (const name of names) {
    report[name] = removeManaged(path.join(dir, name + extension), marker, afterFrontmatter) ? 'removed' : 'kept';
  }
  return report;
}

/**
 * Insert or refresh the delegation block in an instructions file (AGENTS.md / CLAUDE.md), creating it if missing.
 * @param {string} file
 * @returns {boolean} true when the file changed
 */
export function upsertDelegationFile(file) {
  return writeIfChanged(file, upsertDelegation(readTextOr(file)));
}

/**
 * Remove the delegation block from an instructions file if present.
 * @param {string} file
 * @returns {boolean} true when the file changed
 */
export function removeDelegationFile(file) {
  if (!fs.existsSync(file)) return false;
  return writeIfChanged(file, removeDelegation(fs.readFileSync(file, 'utf8')));
}

/**
 * Read the persisted installer state; `{}` when missing or unreadable.
 * @param {string} stateFile
 * @returns {object}
 */
export function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    // No state yet (first install) or a corrupt file: both mean "nothing recorded".
    return {};
  }
}

/**
 * Persist the installer state with user-only permissions.
 * @param {string} stateFile
 * @param {object} state
 */
export function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
