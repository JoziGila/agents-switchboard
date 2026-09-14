// The switchboard's own config file (SPEC §11): defaults, load/save, and DeepSeek key resolution.
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { resolvePaths } from './paths.js';
import { getSecret } from './secrets.js';

export const DEFAULT_PORT = 4141;

/** Defaults from SPEC §11. Failover ships disabled in phase 1. */
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
  },
  failover: { enabled: false, model: 'deepseek-flash' },
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

/**
 * Write the config with user-only permissions.
 * @param {object} cfg
 * @param {import('./paths.js').Paths} [paths]
 */
export function saveConfig(cfg, paths = resolvePaths()) {
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.configFile, stringify(cfg) + '\n', { mode: 0o600 });
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
 * Resolve the DeepSeek API key from the configured source: an env var, or the OS keychain with
 * `DEEPSEEK_API_KEY` as a fallback. Null when unavailable.
 * @param {object} cfg
 * @param {{ env?: NodeJS.ProcessEnv, getSecret?: (name: string) => Promise<string|null> }} [deps]
 * @returns {Promise<string|null>}
 */
export async function resolveDeepSeekKey(cfg, deps = {}) {
  const env = deps.env || process.env;
  const readSecret = deps.getSecret || getSecret;
  const source = cfg.upstream?.deepseek?.api_key || {};
  if (source.env) return env[source.env] || null;
  if (source.keychain) return (await readSecret(source.keychain)) || env.DEEPSEEK_API_KEY || null;
  return env.DEEPSEEK_API_KEY || null;
}
