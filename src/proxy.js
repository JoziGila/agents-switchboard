import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/** Collect a request body into a Buffer. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Collect a request body into a Buffer; rejects with `{ status: 413 }` past MAX_BODY_BYTES. */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, rejected = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Drain instead of destroying, so the 413 reaches the client rather than a connection reset.
        if (!rejected) { rejected = true; const e = new Error(`request body exceeds ${limit} bytes`); e.status = 413; reject(e); }
        chunks.length = 0; return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Header names listed in a `Connection` header are hop-by-hop too. */
function connectionTokens(headers) {
  return String(headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function decoderFor(encoding) {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '': case 'identity': return null;
    case 'gzip': return zlib.createGunzip();
    case 'br': return zlib.createBrotliDecompress();
    case 'deflate': return zlib.createInflate();
    case 'zstd': return zlib.createZstdDecompress();
    default: return null;
  }
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
  const extraHop = connectionTokens(headers);
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k) && !extraHop.includes(k)) out[k] = v;
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
  const extraHop = connectionTokens(up.headers);
  for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && !extraHop.includes(k)) headers[k] = v;
  if (transform) { delete headers['content-length']; delete headers['content-encoding']; }
  res.writeHead(up.statusCode, headers);
  if (transform) {
    // The router asks providers for identity encoding; if one compresses anyway, decode before the line transform.
    const decoder = decoderFor(up.headers['content-encoding']);
    (decoder ? up.pipe(decoder) : up).pipe(transform).pipe(res);
    transform.on('error', () => res.destroy());
  } else up.pipe(res);
  up.on('error', () => res.destroy());
  // A client that goes away must not keep the vendor connection (and its billing) alive.
  res.on('close', () => { if (!up.complete) up.destroy(); if (transform && !transform.destroyed) transform.destroy(); });
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
