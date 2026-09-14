// `switchboard logs`: print the tail of the JSONL request log.
import fs from 'node:fs';
import { resolvePaths } from '../paths.js';

const DEFAULT_LINES = 50;

/**
 * @param {{ n?: string|number }} [opts] number of lines
 * @returns {Promise<number>} exit code
 */
export async function logs(opts = {}) {
  const file = resolvePaths().logFile;
  if (!fs.existsSync(file)) {
    process.stderr.write(`no log yet at ${file}; it appears after the first request through the router\n`);
    return 1;
  }
  const count = Number(opts.n) || DEFAULT_LINES;
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  process.stdout.write(lines.slice(-count).join('\n') + '\n');
  return 0;
}
