// Filesystem locations and client detection. Everything else derives paths from here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} Paths
 * @property {string} home            user home directory
 * @property {string} codexHome       `$CODEX_HOME` or `~/.codex`
 * @property {string} claudeHome      `$CLAUDE_CONFIG_DIR` or `~/.claude`
 * @property {string} switchboardHome `$AGENTS_SWITCHBOARD_HOME` or `~/.agents-switchboard`
 * @property {string} backupsDir      timestamped copies of every client file the installer changes
 * @property {string} logFile         JSONL request log written by the router
 * @property {string} configFile      switchboard config (TOML)
 * @property {string} stateFile       installer state used to undo edits precisely
 */

/**
 * Resolve every filesystem location the switchboard cares about.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {Paths}
 */
export function resolvePaths(env = process.env, home = os.homedir()) {
  const switchboardHome = env.AGENTS_SWITCHBOARD_HOME || path.join(home, '.agents-switchboard');
  return {
    home,
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
    claudeHome: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    switchboardHome,
    backupsDir: path.join(switchboardHome, 'backups'),
    logFile: path.join(switchboardHome, 'switchboard.log'),
    configFile: path.join(switchboardHome, 'config.toml'),
    stateFile: path.join(switchboardHome, 'state.json'),
  };
}

/**
 * Whether an executable is reachable through PATH.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isOnPath(bin, env = process.env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking along PATH.
      }
    }
  }
  return false;
}

/**
 * Codex is present when its config exists or the `codex` binary is on PATH.
 * @param {Paths} paths
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function codexPresent(paths, env = process.env) {
  return fs.existsSync(path.join(paths.codexHome, 'config.toml')) || isOnPath('codex', env);
}

/**
 * Claude Code is present when its settings exist or the `claude` binary is on PATH.
 * @param {Paths} paths
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function claudePresent(paths, env = process.env) {
  return fs.existsSync(path.join(paths.claudeHome, 'settings.json')) || isOnPath('claude', env);
}

/**
 * Timestamp usable as a directory name, e.g. `20260914-161500-123`.
 * @param {Date} [date]
 * @returns {string}
 */
export function backupStamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
