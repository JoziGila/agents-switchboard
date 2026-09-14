import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from '../src/paths.js';

/** A throwaway home directory with isolated paths for every client. */
export function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'));
  const paths = resolvePaths({ PATH: '' }, home);
  return { home, paths, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

export const read = (f) => fs.readFileSync(f, 'utf8');
export const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
