import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * @typedef {object} Paths
 * @property {string} home
 * @property {string} codexHome
 * @property {string} claudeHome
 * @property {string} switchboardHome
 * @property {string} backupsDir
 * @property {string} logFile
 * @property {string} configFile
 * @property {string} stateFile
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
 */
export function isOnPath(bin, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

/** @param {Paths} paths */
export function codexPresent(paths, env = process.env) {
  return fs.existsSync(path.join(paths.codexHome, 'config.toml')) || isOnPath('codex', env);
}

/** @param {Paths} paths */
export function claudePresent(paths, env = process.env) {
  return fs.existsSync(path.join(paths.claudeHome, 'settings.json')) || isOnPath('claude', env);
}

/** Timestamp usable as a directory name, e.g. 20260914-161500-123. */
export function backupStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`;
}
