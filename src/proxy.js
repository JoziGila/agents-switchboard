import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/** Collect a request body into a Buffer. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Collect a request body into a Buffer; rejects with `{ status: 413 }` past MAX_BODY_BYTES. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, rejected = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Drain instead of destroying, so the 413 reaches the client rather than a connection reset.
        if (!rejected) { rejected = true; const e = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`); e.status = 413; reject(e); }
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

/** How long an upstream has to answer before its socket is destroyed. */
const UPSTREAM_TIMEOUT_MS = 600_000;

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
 *
 * `signal` is the client's own lifecycle. The server supplies it as `req.proxySignal` (`IncomingMessage`'s
 * own `signal` getter is read-only, and Node fires it on socket close only after the response commits); the
 * native request signal destroys the vendor request before its headers arrive and the vendor response after
 * them, so a client that hangs up never leaves a billed provider stream open for the full timeout.
 */
export function upstreamRequest(url, { method, headers, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = client(url).request(url, { method, headers, signal }, resolve);
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body == null) req.end();
    else if (Buffer.isBuffer(body) || typeof body === 'string') req.end(body);
    else body.pipe(req);
  });
}

/**
 * Relay an upstream response (status, headers, bytes) to the client unchanged.
 *
 * `onAbort`, when given, fires at most once for an *abnormal* end of the relay — the counterpart to a
 * caller's own 'end'-driven completion handler, so a client disconnect or an upstream reset is never silently
 * dropped: `{ type: 'client' }` when the client went away before the response finished, `{ type: 'upstream',
 * error }` when the upstream stream itself errored (a reset, a truncated body). Normal completion never
 * calls it. Whichever cause fires first wins; callers should guard with their own "already finished" flag
 * since the other cause's cleanup can still trigger a second, harmless call.
 */
export function relayResponse(up, res, { transform, onAbort } = {}) {
  const headers = {};
  const extraHop = connectionTokens(up.headers);
  for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && !extraHop.includes(k)) headers[k] = v;
  if (transform) { delete headers['content-length']; delete headers['content-encoding']; }
  res.writeHead(up.statusCode, headers);
  // `settled` makes the first genuine cause win even though a client abort and an upstream reset each
  // cascade into the other's cleanup path (destroying `up` after a client abort can itself surface as an
  // 'error' on `up`; destroying `res` after an upstream error surfaces as `res`'s own 'close'). Listening
  // directly on `up` for the failure, registered before `pipeline()` builds its own internal listeners on
  // the same streams, reports an upstream-caused failure before that cascade reaches `res`'s 'close' and
  // gets misread as a client abort.
  let settled = false;
  const finishAbort = (info) => { if (settled) return; settled = true; if (onAbort) onAbort(info); };
  up.once('error', (err) => finishAbort({ type: 'upstream', error: err }));
  up.once('aborted', () => finishAbort({ type: 'upstream', error: new Error('upstream aborted') }));
  res.on('close', () => {
    // A client that goes away must not keep the vendor connection (and its billing) alive. Settle the
    // cause before destroying `up` — destroying an incomplete IncomingMessage can itself synchronously
    // surface as 'aborted'/'error' on `up`, which must not win the race against this genuine client cause.
    if (!up.complete) { finishAbort({ type: 'client' }); up.destroy(); }
  });
  // One pipeline owns the whole chain, so a malformed compressed body, an upstream reset, or a client that
  // hangs up destroys every stream in it. Hand-wired pipes left the decoder's 'error' unhandled: a provider
  // that mislabelled or truncated a gzip/br/zstd body took the entire router process down.
  // The router asks providers for identity encoding; if one compresses anyway, decode before the line transform.
  const decoder = transform ? decoderFor(up.headers['content-encoding']) : null;
  const chain = decoder ? [up, decoder, transform] : transform ? [up, transform] : [up];
  pipeline(...chain, res, (err) => {
    if (err && !res.destroyed) res.destroy();
    if (err) finishAbort({ type: 'upstream', error: err }); // fallback: decoder/transform errors never touch `up` directly
  });
}

/**
 * Byte-for-byte reverse proxy of `req` to `baseUrl + path`. The client's own `req.proxySignal` cancels the
 * vendor request when it goes away; a `path` that resolves to another origin than the configured
 * upstream is refused, since it would carry the client's vendor credentials to a host the config never named.
 */
export async function passThrough(req, res, baseUrl, path) {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) {
    const e = new Error(`refusing upstream request to a different origin: ${url.origin}`);
    e.status = 400;
    throw e;
  }
  const up = await upstreamRequest(url, { method: req.method, headers: upstreamHeaders(req.headers, url), body: req, signal: req.proxySignal });
  relayResponse(up, res);
  return up;
}

/** Read a whole upstream response body as a Buffer (decoding gzip/br/zstd/deflate). */
export async function readResponse(up) {
  const buf = await readBody(up);
  return decodeBody(buf, up.headers['content-encoding']);
}
