// The switchboard's own config file (SPEC §11): defaults, load/save, and DeepSeek key resolution.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { resolvePaths } from './paths.js';
import { getSecret } from './secrets.js';

export const DEFAULT_PORT = 4141;
export const ACCESS_TOKEN_BYTES = 32;

/** Defaults from SPEC §11. */
export const DEFAULT_CONFIG = Object.freeze({
  listen: `127.0.0.1:${DEFAULT_PORT}`,
  upstream: {
    openai: { base_url: 'https://chatgpt.com/backend-api/codex' },
    anthropic: { base_url: 'https://api.anthropic.com' },
    deepseek: {
      base_url: 'https://api.deepseek.com',
      api_key: { keychain: 'agents-switchboard/deepseek' },
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    },
    openrouter: {
      base_url: 'https://openrouter.ai/api',
      api_key: { keychain: 'agents-switchboard/openrouter' },
      // Advertised in the Codex picker; any vendor/model id routes to OpenRouter regardless.
      models: [],
    },
  },
  failover: { enabled: true, model: 'deepseek-flash' },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge `over` onto a copy of `base`; arrays and scalars in `over` win outright.
 * @param {object} base
 * @param {object} [over]
 * @returns {object}
 */
export function mergeDeep(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : structuredClone(v);
  }
  return out;
}

/**
 * Load the switchboard config merged over the defaults. A missing file yields the defaults.
 * @param {import('./paths.js').Paths} [paths]
 * @returns {object}
 */
export function loadConfig(paths = resolvePaths()) {
  const user = fs.existsSync(paths.configFile) ? parse(fs.readFileSync(paths.configFile, 'utf8')) : {};
  const cfg = mergeDeep(DEFAULT_CONFIG, user);
  // An explicit api_key source replaces the default one instead of merging with it.
  if (user.upstream?.deepseek?.api_key) cfg.upstream.deepseek.api_key = structuredClone(user.upstream.deepseek.api_key);
  return cfg;
}

/** A URL-safe local capability token for the router prefix. */
export function newAccessToken() {
  return randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');
}

const ACCESS_TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

/** Path prefix of the router's protected local capability route: `/_switchboard/<token>/…`. */
export const CAPABILITY_PREFIX = '/_switchboard/';

/**
 * Split a request URL's optional capability segment from its local path. The only place that knows the
 * segment's format.
 * @param {string} url a request-target, e.g. `/_switchboard/<token>/anthropic/v1/messages`
 * @returns {{ url: string, supplied: string|null }} `url` with the segment stripped (untouched when
 *   absent); `supplied` is null when no `CAPABILITY_PREFIX` was present, '' for an empty or unclosed
 *   segment (no closing `/`), otherwise the segment text.
 */
export function readCapability(url) {
  const target = String(url ?? '');
  if (!target.startsWith(CAPABILITY_PREFIX)) return { url: target, supplied: null };
  const end = target.indexOf('/', CAPABILITY_PREFIX.length);
  const supplied = end < 0 ? '' : target.slice(CAPABILITY_PREFIX.length, end);
  const stripped = end < 0 ? '/' : target.slice(end);
  return { url: stripped, supplied };
}

/**
 * The one capability path segment for a token. Base64url is used verbatim, so the segment a client writes
 * is byte-identical to the value the router compares against; no percent-encoding is involved.
 * @param {unknown} token
 * @returns {string} `_switchboard/<token>`
 * @throws {Error} when the token is empty or not base64url
 */
export function accessTokenSegment(token) {
  const value = String(token ?? '');
  if (!ACCESS_TOKEN_SHAPE.test(value)) {
    throw new Error('agents-switchboard access_token must be a non-empty base64url string; run `switchboard install` again to mint a protected router URL.');
  }
  return `${CAPABILITY_PREFIX}${value}`.slice(1); // the segment itself is written without the leading slash
}

/**
 * Ensure the loaded config has the one router access-token authority. Mutates and returns `cfg`.
 * The installer calls this before saving; runtime commands that should not create config call
 * `routerBaseUrl` instead and get a clear reinstall error if the token is absent.
 * @param {object} cfg
 * @returns {object}
 */
export function ensureAccessToken(cfg) {
  if (cfg.access_token) accessTokenSegment(cfg.access_token); // an existing token must already be usable
  else cfg.access_token = newAccessToken();
  return cfg;
}

/**
 * Write the config with user-only permissions.
 * @param {object} cfg
 * @param {import('./paths.js').Paths} [paths]
 */
export function saveConfig(cfg, paths = resolvePaths()) {
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.configFile, stringify(cfg) + '\n', { mode: 0o600 });
  try { fs.chmodSync(paths.configFile, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
}

/**
 * Split `listen` ("host:port") into its parts, defaulting to loopback and the default port.
 * @param {{ listen?: string }} cfg
 * @returns {{ host: string, port: number }}
 */
export function listenAddress(cfg) {
  const listen = String(cfg.listen ?? '');
  const colon = listen.lastIndexOf(':');
  const host = colon === -1 ? listen : listen.slice(0, colon);
  const port = colon === -1 ? NaN : Number(listen.slice(colon + 1));
  return { host: host || '127.0.0.1', port: port || DEFAULT_PORT };
}

/**
 * Base URL for protected router routes, without a client/vendor suffix.
 * @param {{ listen?: string, access_token?: string }} cfg
 * @returns {string}
 */
export function routerBaseUrl(cfg) {
  if (!cfg.access_token) {
    throw new Error('agents-switchboard config is missing access_token; run `switchboard install` again so local clients get a protected router URL.');
  }
  const { host, port } = listenAddress(cfg);
  // `localhost` and `127.0.0.1` reach the same loopback listener; clients are always configured with the
  // literal 127.0.0.1 so every exact-URL check (doctor, conflicts, uninstall) agrees on one spelling.
  const clientHost = host === 'localhost' ? '127.0.0.1' : host;
  return `http://${clientHost}:${port}/${accessTokenSegment(cfg.access_token)}`;
}

/**
 * The protected URL of one client's router prefix, e.g. `http://127.0.0.1:4141/_switchboard/<token>/anthropic`.
 * @param {number} port
 * @param {string} token capability token; its path segment carries the router's auth
 * @param {string} suffix client prefix under the router, e.g. `/anthropic`
 * @returns {string}
 * @throws {Error} when the token is missing or empty
 */
export function baseUrlFor(port, token, suffix) {
  if (!token) throw new Error('agents-switchboard: access token required; run `switchboard install`');
  return `http://127.0.0.1:${port}/${accessTokenSegment(token)}${suffix}`;
}

// `redact` lives in the leaf ./redact.js (it must not depend on secrets.js); re-exported here so existing
// `import { redact } from './config.js'` call sites keep working.
export { redact } from './redact.js';

/**
 * Resolve the API key of an upstream section: `{ env }` reads that variable, `{ keychain }` reads the
 * OS keychain and falls back to `envDefault`; no `api_key` at all means `envDefault` only.
 * @param {object} section   e.g. cfg.upstream.deepseek
 * @param {string} envDefault  e.g. 'DEEPSEEK_API_KEY'
 * @param {{env?: object, getSecret?: (name: string) => Promise<string|null>}} [deps]
 * @returns {Promise<string|null>}
 */
export async function resolveProviderKey(section, envDefault, deps = {}) {
  const env = deps.env || process.env;
  const readSecret = deps.getSecret || getSecret;
  const source = section?.api_key || {};
  if (source.env) return env[source.env] || null;
  if (source.keychain) return (await readSecret(source.keychain)) || env[envDefault] || null;
  return env[envDefault] || null;
}

/** Env var that carries a provider's key when no keychain entry exists. */
export const PROVIDER_KEY_ENV = { deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
