// `switchboard roles`: rewrite the managed role files for every detected client.
import path from 'node:path';
import { writeRoleFiles } from '../install/files.js';
import { codexRoles, renderCodexRole, claudeRoles, renderClaudeRole, MANAGED_TOML, MANAGED_MD } from '../install/roles.js';
import { resolvePaths, codexPresent, claudePresent } from '../paths.js';

/**
 * @param {{ pro?: boolean }} [opts] `--pro` moves reviewer and senior to deepseek-v4-pro
 * @returns {Promise<number>} exit code
 */
export async function roles(opts = {}) {
  const paths = resolvePaths();
  const pro = !!opts.pro;
  const reports = [];
  if (codexPresent(paths)) {
    reports.push(writeRoleFiles({ dir: path.join(paths.codexHome, 'agents'), extension: '.toml', marker: MANAGED_TOML, afterFrontmatter: false, roles: codexRoles({ pro }), render: renderCodexRole }));
  }
  if (claudePresent(paths)) {
    reports.push(writeRoleFiles({ dir: path.join(paths.claudeHome, 'agents'), extension: '.md', marker: MANAGED_MD, afterFrontmatter: true, roles: claudeRoles({ pro }), render: renderClaudeRole }));
  }
  const outcomes = reports.flatMap((r) => Object.values(r));
  const count = (kind) => outcomes.filter((o) => o === kind).length;
  process.stdout.write(`role files: ${count('written')} written, ${count('unchanged')} unchanged, ${count('skipped')} skipped (not managed by agents-switchboard)${pro ? '; reviewer and senior on deepseek-v4-pro' : ''}\n`);
  return 0;
}
