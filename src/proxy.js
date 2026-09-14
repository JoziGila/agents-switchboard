import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/** Collect a request body into a Buffer. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Decode a request body according to its Content-Encoding. */
export function decodeBody(buf, encoding) {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '': case 'identity': return buf;
    case 'zstd': return zlib.zstdDecompressSync(buf);
    case 'gzip': return zlib.gunzipSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    default: throw new Error(`unsupported content-encoding: ${encoding}`);
  }
}

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function client(url) { return url.protocol === 'https:' ? https : http; }

/** Copy request headers for the upstream, dropping hop-by-hop ones and rewriting host. */
export function upstreamHeaders(headers, url, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
  out.host = url.host;
  for (const [k, v] of Object.entries(overrides)) { if (v == null) delete out[k]; else out[k] = v; }
  return out;
}

/**
 * Open an upstream request and resolve with the streaming response.
 * `body` may be a Buffer or a readable stream (the incoming request).
 */
export function upstreamRequest(url, { method, headers, body, timeoutMs = 600_000 }) {
  return new Promise((resolve, reject) => {
    const req = client(url).request(url, { method, headers }, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body == null) req.end();
    else if (Buffer.isBuffer(body) || typeof body === 'string') req.end(body);
    else body.pipe(req);
  });
}

/** Relay an upstream response (status, headers, bytes) to the client unchanged. */
export function relayResponse(up, res, { transform } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  if (transform) { delete headers['content-length']; delete headers['content-encoding']; }
  res.writeHead(up.statusCode, headers);
  if (transform) up.pipe(transform).pipe(res); else up.pipe(res);
  up.on('error', () => res.destroy());
}

/** Byte-for-byte reverse proxy of `req` to `baseUrl + path`. */
export async function passThrough(req, res, baseUrl, path) {
  const url = new URL(path, baseUrl);
  const up = await upstreamRequest(url, { method: req.method, headers: upstreamHeaders(req.headers, url), body: req });
  relayResponse(up, res);
  return up;
}

/** Read a whole upstream response body as a Buffer (decoding gzip/br/zstd/deflate). */
export async function readResponse(up) {
  const buf = await readBody(up);
  return decodeBody(buf, up.headers['content-encoding']);
}
