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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge `over` onto a copy of `base`; arrays and scalars in `over` win outright. */
export function mergeDeep(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : structuredClone(v);
  }
  return out;
}

/**
 * Load the switchboard config, merged over defaults. A missing file yields the defaults.
 * @param {import('./paths.js').Paths} [paths]
 */
export function loadConfig(paths = resolvePaths()) {
  let user = {};
  if (fs.existsSync(paths.configFile)) {
    user = parse(fs.readFileSync(paths.configFile, 'utf8'));
  }
  const cfg = mergeDeep(DEFAULT_CONFIG, user);
  // An explicit api_key choice replaces the default one rather than merging with it.
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

/** Split `listen` into host and port. */
export function listenAddress(cfg) {
  const [host, port] = String(cfg.listen).split(':');
  return { host: host || '127.0.0.1', port: Number(port) || DEFAULT_PORT };
}

/**
 * Resolve the DeepSeek API key from the configured source. Null when unavailable.
 * @param {object} cfg
 * @param {{ env?: NodeJS.ProcessEnv, getSecret?: (name: string) => Promise<string|null> }} [deps]
 * @returns {Promise<string|null>}
 */
export async function resolveDeepSeekKey(cfg, deps = {}) {
  const env = deps.env || process.env;
  const read = deps.getSecret || getSecret;
  const src = cfg.upstream?.deepseek?.api_key || {};
  if (src.env) return env[src.env] || null;
  if (src.keychain) return (await read(src.keychain)) || env.DEEPSEEK_API_KEY || null;
  return env.DEEPSEEK_API_KEY || null;
}
