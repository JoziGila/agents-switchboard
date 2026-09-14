import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isOnPath } from './paths.js';

const run = promisify(execFile);
const SERVICE = 'agents-switchboard';

/** @returns {'security'|'secret-tool'|'powershell'|null} */
function backend() {
  if (process.platform === 'darwin' && isOnPath('security')) return 'security';
  if (process.platform === 'linux' && isOnPath('secret-tool')) return 'secret-tool';
  if (process.platform === 'win32' && (isOnPath('powershell') || isOnPath('pwsh'))) return 'powershell';
  return null;
}

/** Whether an OS credential store is usable on this machine. */
export function keychainAvailable() {
  return backend() !== null;
}

const PS = () => (isOnPath('powershell') ? 'powershell' : 'pwsh');
const VAULT = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault;';

/**
 * Read a secret. Resolves to null when absent or when no store exists.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
export async function getSecret(name) {
  try {
    switch (backend()) {
      case 'security': {
        const { stdout } = await run('security', ['find-generic-password', '-a', name, '-s', SERVICE, '-w']);
        return stdout.replace(/\n$/, '');
      }
      case 'secret-tool': {
        const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
        return stdout.length ? stdout : null;
      }
      case 'powershell': {
        const { stdout } = await run(PS(), ['-NoProfile', '-NonInteractive', '-Command',
          `${VAULT} $c = $v.Retrieve('${SERVICE}', $env:SB_NAME); $c.RetrievePassword(); [Console]::Out.Write($c.Password)`],
          { env: { ...process.env, SB_NAME: name } });
        return stdout.length ? stdout : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Store a secret, replacing any previous value. Resolves false when no store exists.
 * @param {string} name
 * @param {string} value
 */
export async function setSecret(name, value) {
  switch (backend()) {
    case 'security':
      await run('security', ['add-generic-password', '-U', '-a', name, '-s', SERVICE, '-w', value]);
      return true;
    case 'secret-tool': {
      const child = execFile('secret-tool', ['store', `--label=${SERVICE}/${name}`, 'service', SERVICE, 'account', name]);
      child.stdin.end(value);
      await new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`secret-tool exited ${code}`)))));
      return true;
    }
    case 'powershell':
      await run(PS(), ['-NoProfile', '-NonInteractive', '-Command',
        `${VAULT} try { $old = $v.Retrieve('${SERVICE}', $env:SB_NAME); $v.Remove($old) } catch {}; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', $env:SB_NAME, $env:SB_VALUE)))`],
        { env: { ...process.env, SB_NAME: name, SB_VALUE: value } });
      return true;
    default:
      return false;
  }
}

/**
 * Remove a secret. Resolves false when no store exists or nothing was stored.
 * @param {string} name
 */
export async function deleteSecret(name) {
  try {
    switch (backend()) {
      case 'security':
        await run('security', ['delete-generic-password', '-a', name, '-s', SERVICE]);
        return true;
      case 'secret-tool':
        await run('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
        return true;
      case 'powershell':
        await run(PS(), ['-NoProfile', '-NonInteractive', '-Command',
          `${VAULT} $c = $v.Retrieve('${SERVICE}', $env:SB_NAME); $v.Remove($c)`],
          { env: { ...process.env, SB_NAME: name } });
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}
