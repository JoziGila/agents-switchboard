import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';
import { codexRoles, renderCodexRole, claudeRoles, renderClaudeRole, MANAGED_TOML, MANAGED_MD } from '../install/roles.js';
import { writeManaged } from '../install/files.js';

export async function roles(opts = {}) {
  const paths = resolvePaths();
  const pro = !!opts.pro;
  let n = 0;
  if (codexPresent(paths)) {
    const dir = path.join(paths.codexHome, 'agents'); fs.mkdirSync(dir, { recursive: true });
    for (const [name, role] of Object.entries(codexRoles({ pro }))) { if (writeManaged(path.join(dir, `${name}.toml`), renderCodexRole(name, role), MANAGED_TOML) !== false) n++; }
  }
  if (claudePresent(paths)) {
    const dir = path.join(paths.claudeHome, 'agents'); fs.mkdirSync(dir, { recursive: true });
    for (const [name, role] of Object.entries(claudeRoles({ pro }))) { if (writeManaged(path.join(dir, `${name}.md`), renderClaudeRole(name, role), MANAGED_MD, true) !== false) n++; }
  }
  process.stdout.write(`wrote ${n} role file(s)${pro ? ' (pro: reviewer and senior on deepseek-v4-pro)' : ''}. Files that are not managed by agents-switchboard were left alone.\n`);
  return 0;
}
