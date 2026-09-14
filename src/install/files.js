import fs from 'node:fs';
import path from 'node:path';
import { backupStamp } from '../paths.js';

/** Copy `file` into a fresh backup directory. Returns the backup path, or null when the file does not exist. */
export function backupFile(file, backupsDir, name, stamp = backupStamp()) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(backupsDir, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, name);
  fs.copyFileSync(file, dest);
  return dest;
}

/** Write only when content differs; returns true when written. */
export function writeIfChanged(file, content, mode) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
  return true;
}

/**
 * Whether a file carries the managed marker: on its first line, or, for markdown
 * with YAML frontmatter, on the first non-empty line after the closing `---`.
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
 * Write a managed role file unless an unmanaged file already occupies the path.
 * @returns {'written'|'unchanged'|'skipped'}
 */
export function writeManaged(file, content, marker, afterFrontmatter = false) {
  if (fs.existsSync(file) && !isManaged(fs.readFileSync(file, 'utf8'), marker, afterFrontmatter)) return 'skipped';
  return writeIfChanged(file, content) ? 'written' : 'unchanged';
}

/** Delete a role file only if it carries the managed marker. */
export function removeManaged(file, marker, afterFrontmatter = false) {
  if (!fs.existsSync(file)) return false;
  if (!isManaged(fs.readFileSync(file, 'utf8'), marker, afterFrontmatter)) return false;
  fs.unlinkSync(file);
  return true;
}

/** Read the persisted installer state ({} when missing). */
export function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
