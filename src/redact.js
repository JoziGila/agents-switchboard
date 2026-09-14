// Scrubs credentials from output text. Leaf module: imports nothing from the project, so config.js and
// secrets.js can both depend on it without forming an import cycle.

const ACCESS_TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * Reconstruct the protected router base URL from a config, without importing config.js (that would
 * reintroduce the cycle this module exists to break). Mirrors config.js's routerBaseUrl/listenAddress.
 * @param {{ listen?: string, access_token?: string }} cfg
 * @returns {string|null} null when there is no usable token to build a URL around
 */
function routerBaseUrlFor(cfg) {
  const token = String(cfg?.access_token ?? '');
  if (!ACCESS_TOKEN_SHAPE.test(token)) return null;
  const listen = String(cfg?.listen ?? '');
  const colon = listen.lastIndexOf(':');
  const host = (colon === -1 ? listen : listen.slice(0, colon)) || '127.0.0.1';
  const port = (colon === -1 ? NaN : Number(listen.slice(colon + 1))) || 4141; // config.js's DEFAULT_PORT
  const clientHost = host === 'localhost' ? '127.0.0.1' : host;
  return `http://${clientHost}:${port}/_switchboard/${token}`;
}

/**
 * Scrub every credential a line of output could carry: each extra `secrets` value, the access token, and
 * the protected base URL that contains it. The URL goes first so no half-redacted URL is left behind.
 * @param {unknown} text
 * @param {{ listen?: string, access_token?: string }} [cfg]
 * @param {(string|null|undefined)[]} secrets further values to scrub, e.g. a provider key being stored
 * @returns {string}
 */
export function redact(text, cfg = {}, ...secrets) {
  let out = String(text ?? '');
  const routerUrl = routerBaseUrlFor(cfg);
  if (routerUrl) out = out.split(routerUrl).join('[router]');
  for (const value of [cfg.access_token, ...secrets]) if (value) out = out.split(String(value)).join('[redacted]');
  return out;
}
