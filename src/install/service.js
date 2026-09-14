import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const LABEL = 'dev.agents-switchboard';

const plistPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitPath = (home = os.homedir()) => path.join(home, '.config', 'systemd', 'user', 'agents-switchboard.service');

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render the launchd plist. Pure. */
export function renderPlist({ nodePath, entryPath, logFile, pathEnv }) {
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
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

/** Render the systemd user unit. Pure. */
export function renderUnit({ nodePath, entryPath, logFile, pathEnv }) {
  return `[Unit]
Description=agents-switchboard loopback router
After=network.target

[Service]
ExecStart=${nodePath} ${entryPath} serve
Restart=always
RestartSec=2
Environment=PATH=${pathEnv}
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

/**
 * Register the router as a login service and start it.
 * @param {{ nodePath?: string, entryPath: string, logFile: string, home?: string, platform?: string }} opts
 */
export async function installService(opts) {
  const nodePath = opts.nodePath || process.execPath;
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true, mode: 0o700 });

  if (platform === 'darwin') {
    const file = plistPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await run('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`]).catch(() => {});
    fs.writeFileSync(file, renderPlist({ nodePath, entryPath: opts.entryPath, logFile: opts.logFile, pathEnv }));
    try {
      await run('launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, file]);
    } catch {
      await run('launchctl', ['load', '-w', file]);
    }
    return { kind: 'launchd', file };
  }
  if (platform === 'linux') {
    const file = unitPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderUnit({ nodePath, entryPath: opts.entryPath, logFile: opts.logFile, pathEnv }));
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', 'agents-switchboard.service']);
    await run('systemctl', ['--user', 'restart', 'agents-switchboard.service']).catch(() => {});
    return { kind: 'systemd', file };
  }
  if (platform === 'win32') {
    const cmd = `"${nodePath}" "${opts.entryPath}" serve`;
    await run('schtasks', ['/Delete', '/TN', LABEL, '/F']).catch(() => {});
    await run('schtasks', ['/Create', '/TN', LABEL, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', cmd, '/F']);
    await run('schtasks', ['/Run', '/TN', LABEL]).catch(() => {});
    return { kind: 'schtasks', file: null };
  }
  throw new Error(`unsupported platform ${platform}`);
}

/** Stop and unregister the login service. */
export async function uninstallService(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const file = plistPath(home);
    await run('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`]).catch(() => {});
    if (fs.existsSync(file)) { await run('launchctl', ['unload', file]).catch(() => {}); fs.unlinkSync(file); }
    return true;
  }
  if (platform === 'linux') {
    const file = unitPath(home);
    await run('systemctl', ['--user', 'disable', '--now', 'agents-switchboard.service']).catch(() => {});
    if (fs.existsSync(file)) fs.unlinkSync(file);
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    return true;
  }
  if (platform === 'win32') {
    await run('schtasks', ['/End', '/TN', LABEL]).catch(() => {});
    await run('schtasks', ['/Delete', '/TN', LABEL, '/F']).catch(() => {});
    return true;
  }
  return false;
}

/**
 * @returns {Promise<{ installed: boolean, running: boolean, pid?: number }>}
 */
export async function serviceStatus(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const installed = fs.existsSync(plistPath(home));
    try {
      const { stdout } = await run('launchctl', ['print', `gui/${os.userInfo().uid}/${LABEL}`]);
      const m = stdout.match(/\bpid = (\d+)/);
      return { installed, running: !!m, ...(m ? { pid: Number(m[1]) } : {}) };
    } catch {
      return { installed, running: false };
    }
  }
  if (platform === 'linux') {
    const installed = fs.existsSync(unitPath(home));
    try {
      const { stdout } = await run('systemctl', ['--user', 'show', 'agents-switchboard.service', '-p', 'ActiveState', '-p', 'MainPID']);
      const running = /ActiveState=active/.test(stdout);
      const m = stdout.match(/MainPID=(\d+)/);
      return { installed, running, ...(m && Number(m[1]) ? { pid: Number(m[1]) } : {}) };
    } catch {
      return { installed, running: false };
    }
  }
  if (platform === 'win32') {
    try {
      const { stdout } = await run('schtasks', ['/Query', '/TN', LABEL, '/FO', 'LIST']);
      return { installed: true, running: /Running/.test(stdout) };
    } catch {
      return { installed: false, running: false };
    }
  }
  return { installed: false, running: false };
}
