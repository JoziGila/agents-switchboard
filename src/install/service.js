// Login service registration: launchd (macOS), systemd --user (Linux), Scheduled Task (Windows).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const LABEL = 'dev.agents-switchboard';
const UNIT = 'agents-switchboard.service';

const plistPath = (home) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitPath = (home) => path.join(home, '.config', 'systemd', 'user', UNIT);
const launchdTarget = () => `gui/${os.userInfo().uid}`;
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Swallow the error from a command whose failure means "already in the desired state". */
const ignoreFailure = () => {};

/** `<key>NAME</key><string>VALUE</string>` lines for a plist EnvironmentVariables dict. */
const plistEnv = (env) => Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
/** `Environment=NAME=VALUE` lines for a systemd unit, quoted so spaces and quotes survive. */
const unitEnv = (env) => Object.entries(env).map(([k, v]) => `Environment="${k}=${String(v).replace(/(["\\])/g, '\\$1')}"`).join('\n');

/**
 * Render the launchd plist. Pure.
 * @param {{ nodePath: string, entryPath: string, logFile: string, pathEnv: string, env?: Record<string, string> }} opts
 *   `env` is extra service environment (a provider key when no keychain exists); never logged.
 * @returns {string}
 */
export function renderPlist({ nodePath, entryPath, logFile, pathEnv, env = {} }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(entryPath)}</string>
    <string>serve</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${plistEnv({ PATH: pathEnv, ...env })}
  </dict>
</dict>
</plist>
`;
}

/**
 * Render the systemd user unit. Pure.
 * @param {{ nodePath: string, entryPath: string, logFile: string, pathEnv: string, env?: Record<string, string> }} opts
 * @returns {string}
 */
export function renderUnit({ nodePath, entryPath, logFile, pathEnv, env = {} }) {
  return `[Unit]
Description=agents-switchboard loopback router
After=network.target

[Service]
ExecStart=${nodePath} ${entryPath} serve
Restart=always
RestartSec=2
${unitEnv({ PATH: pathEnv, ...env })}
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

/** Where the Windows task reads its environment from: a user-only file the wrapper sources before `serve`. */
export const windowsEnvFile = (home) => path.join(home, '.agents-switchboard', 'service.env.cmd');

/**
 * Render the Windows wrapper that loads the env file (if present) and starts the router. Pure.
 * @param {{ nodePath: string, entryPath: string, envFile: string }} opts
 * @returns {string}
 */
export function renderWindowsWrapper({ nodePath, entryPath, envFile }) {
  return `@echo off\r\nif exist "${envFile}" call "${envFile}"\r\n"${nodePath}" "${entryPath}" serve\r\n`;
}

/**
 * Register the router as a login service and start it.
 * @param {{ nodePath?: string, entryPath: string, logFile: string, home?: string, platform?: string, env?: Record<string, string> }} opts
 *   `env` is extra service environment, used to carry a provider key when the machine has no keychain. It is
 *   written only into the user-only service definition and never printed.
 * @returns {Promise<{ kind: 'launchd'|'systemd'|'schtasks', file: string|null }>}
 */
export async function installService(opts) {
  const nodePath = opts.nodePath || process.execPath;
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const env = opts.env || {};
  const rendering = { nodePath, entryPath: opts.entryPath, logFile: opts.logFile, pathEnv, env };
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true, mode: 0o700 });

  switch (platform) {
    case 'darwin': {
      const file = plistPath(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await run('launchctl', ['bootout', `${launchdTarget()}/${LABEL}`]).catch(ignoreFailure); // not loaded yet
      fs.writeFileSync(file, renderPlist(rendering), { mode: 0o600 });
      try {
        await run('launchctl', ['bootstrap', launchdTarget(), file]);
      } catch {
        // Older launchctl without bootstrap/bootout.
        await run('launchctl', ['load', '-w', file]);
      }
      return { kind: 'launchd', file };
    }
    case 'linux': {
      const file = unitPath(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderUnit(rendering), { mode: 0o600 });
      await run('systemctl', ['--user', 'daemon-reload']);
      await run('systemctl', ['--user', 'enable', '--now', UNIT]);
      await run('systemctl', ['--user', 'restart', UNIT]).catch(ignoreFailure); // enable --now already started a fresh unit
      return { kind: 'systemd', file };
    }
    case 'win32': {
      // Scheduled tasks carry no per-task environment; a user-only env file sourced by a wrapper stands in.
      const envFile = windowsEnvFile(home);
      const wrapper = path.join(path.dirname(envFile), 'service.cmd');
      fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
      if (Object.keys(env).length) fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join('\r\n') + '\r\n', { mode: 0o600 });
      fs.writeFileSync(wrapper, renderWindowsWrapper({ nodePath, entryPath: opts.entryPath, envFile }), { mode: 0o600 });
      await run('schtasks', ['/Delete', '/TN', LABEL, '/F']).catch(ignoreFailure); // not registered yet
      await run('schtasks', ['/Create', '/TN', LABEL, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `"${wrapper}"`, '/F']);
      await run('schtasks', ['/Run', '/TN', LABEL]).catch(ignoreFailure); // already running
      return { kind: 'schtasks', file: wrapper };
    }
    default:
      throw new Error(`unsupported platform ${platform}: run \`switchboard serve\` under your own supervisor`);
  }
}

/**
 * Restart the running service so it picks up a changed switchboard config.
 * @param {{ home?: string, platform?: string }} [opts]
 * @returns {Promise<boolean>} false when no service manager is available
 */
export async function restartService(opts = {}) {
  const platform = opts.platform || process.platform;
  switch (platform) {
    case 'darwin':
      await run('launchctl', ['kickstart', '-k', `${launchdTarget()}/${LABEL}`]);
      return true;
    case 'linux':
      await run('systemctl', ['--user', 'restart', UNIT]);
      return true;
    case 'win32':
      await run('schtasks', ['/End', '/TN', LABEL]).catch(ignoreFailure); // not running
      await run('schtasks', ['/Run', '/TN', LABEL]);
      return true;
    default:
      return false;
  }
}

/**
 * Stop and unregister the login service.
 * @param {{ home?: string, platform?: string }} [opts]
 * @returns {Promise<{ removed: boolean }>}
 */
export async function uninstallService(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  switch (platform) {
    case 'darwin': {
      const file = plistPath(home);
      const removed = fs.existsSync(file);
      await run('launchctl', ['bootout', `${launchdTarget()}/${LABEL}`]).catch(ignoreFailure); // not loaded
      if (removed) {
        await run('launchctl', ['unload', file]).catch(ignoreFailure); // legacy launchctl fallback
        fs.unlinkSync(file);
      }
      return { removed };
    }
    case 'linux': {
      const file = unitPath(home);
      const removed = fs.existsSync(file);
      await run('systemctl', ['--user', 'disable', '--now', UNIT]).catch(ignoreFailure); // not enabled
      if (removed) fs.unlinkSync(file);
      await run('systemctl', ['--user', 'daemon-reload']).catch(ignoreFailure);
      return { removed };
    }
    case 'win32': {
      await run('schtasks', ['/End', '/TN', LABEL]).catch(ignoreFailure); // not running
      const removed = await run('schtasks', ['/Delete', '/TN', LABEL, '/F']).then(() => true, () => false);
      return { removed };
    }
    default:
      return { removed: false };
  }
}

/**
 * Whether the login service is registered and running.
 * @param {{ home?: string, platform?: string }} [opts]
 * @returns {Promise<{ installed: boolean, running: boolean, pid?: number }>}
 */
export async function serviceStatus(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  switch (platform) {
    case 'darwin': {
      const installed = fs.existsSync(plistPath(home));
      try {
        const { stdout } = await run('launchctl', ['print', `${launchdTarget()}/${LABEL}`]);
        const pid = stdout.match(/\bpid = (\d+)/)?.[1];
        return { installed, running: !!pid, ...(pid ? { pid: Number(pid) } : {}) };
      } catch {
        // launchctl print exits non-zero when the job is not loaded.
        return { installed, running: false };
      }
    }
    case 'linux': {
      const installed = fs.existsSync(unitPath(home));
      try {
        const { stdout } = await run('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveState', '-p', 'MainPID']);
        const pid = Number(stdout.match(/MainPID=(\d+)/)?.[1]);
        return { installed, running: /ActiveState=active/.test(stdout), ...(pid ? { pid } : {}) };
      } catch {
        // systemctl show fails when the unit is unknown.
        return { installed, running: false };
      }
    }
    case 'win32': {
      try {
        const { stdout } = await run('schtasks', ['/Query', '/TN', LABEL, '/FO', 'LIST']);
        return { installed: true, running: /Running/.test(stdout) };
      } catch {
        // schtasks /Query fails when the task does not exist.
        return { installed: false, running: false };
      }
    }
    default:
      return { installed: false, running: false };
  }
}
