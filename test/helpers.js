import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from '../src/paths.js';

/** A throwaway home directory with isolated paths for every client. */
export function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'));
  const paths = resolvePaths({ PATH: '' }, home);
  return { home, paths, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/**
 * A loopback mock upstream: records every request into `log`, then answers with `handler`.
 * Resolves once it is listening, so the caller can use its port straight away.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer) => void} handler
 * @param {object[]} [log] one `{ method, url, headers, body }` entry per request
 * @returns {Promise<import('node:http').Server>}
 */
export function mockUpstream(handler, log = []) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    log.push({ method: req.method, url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

export const read = (f) => fs.readFileSync(f, 'utf8');
export const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
