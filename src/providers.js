// Third-party model providers the router can send a request to, and how a model id selects one.
// The client's own vendor (OpenAI for Codex, Anthropic for Claude Code) is never a provider here:
// anything no provider claims passes through untouched.
import { baseModelId } from './catalog.js';

const PROJECT_URL = 'https://github.com/JoziGila/agents-switchboard';

/**
 * @typedef {object} Provider
 * @property {string} name                       'deepseek' | 'openrouter'
 * @property {URL} baseUrl
 * @property {string} responsesPath              path of the OpenAI Responses endpoint under baseUrl
 * @property {string} messagesPath               path of the Anthropic Messages endpoint under baseUrl
 * @property {(id: string) => boolean} matches   does this provider serve the (suffix-stripped) model id
 * @property {() => Promise<string|null>} key    resolves the API key
 * @property {(dialect: 'responses'|'messages', key: string) => Record<string,string>} authHeaders
 * @property {string[]} models                   ids advertised in the Codex picker
 * @property {Record<string, object>} modelOverrides  per-model catalog overrides
 * @property {(dialect: 'responses'|'messages', conversationId: string|null, reqHeaders: object) => {body: object, headers: object}} requestOptions
 *   provider-specific fields merged into the outgoing body and headers
 * @property {(dialect: 'responses'|'messages') => URL} endpoint
 *   the dialect's absolute request URL, joining baseUrl and the dialect's path (baseUrl may itself carry a path, e.g. OpenRouter's `/api`)
 */

/**
 * Join a base URL with a dialect path. `new URL(path, baseUrl)` is wrong here: when `path` starts with `/`
 * (every dialect path does), WHATWG resolution discards any path segment already on `baseUrl` — OpenRouter's
 * `/api` — so a plain `new URL('/v1/messages', 'https://openrouter.ai/api')` resolves to the marketing site,
 * not the API. Stripping trailing slashes on the base and concatenating avoids that, and tolerates either
 * side carrying (or missing) a slash at the join.
 * @param {URL|string} baseUrl
 * @param {string} path
 * @returns {URL}
 */
function joinEndpoint(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return new URL(base + suffix);
}

/** OpenRouter routing preferences sent with every request; `[upstream.openrouter.provider]` overrides or extends. */
const OPENROUTER_PROVIDER_DEFAULTS = {
  // Only providers that support every parameter (tools, reasoning, parallel calls); the others would drop them silently.
  require_parameters: true,
  allow_fallbacks: true,
};

/** Claude Code beta values OpenRouter forwards to Anthropic-hosted models; login and client markers are not for a third party. */
function betaForOpenRouter(anthropicBeta) {
  return String(anthropicBeta ?? '').split(',').map((s) => s.trim()).filter((v) => v && !/^oauth-|^claude-code-/.test(v)).join(',');
}

/**
 * Build the provider list from config. A provider is present when its section exists in config;
 * whether it has a key is checked per request so a missing key yields a clear 400, not a dead route.
 * @param {object} config
 * @param {(section: object) => Promise<string|null>} keyFor  resolves `api_key` of an upstream section
 * @returns {Provider[]}
 */
export function buildProviders(config, keyFor) {
  const providers = [];
  const ds = config.upstream?.deepseek;
  if (ds) {
    providers.push({
      name: 'deepseek',
      baseUrl: new URL(ds.base_url),
      responsesPath: '/responses',
      messagesPath: '/anthropic/v1/messages',
      // DeepSeek's own slugs have no vendor prefix: deepseek-flash, deepseek-v4-pro, legacy deepseek-v4-flash.
      matches: (id) => /^deepseek-/i.test(id),
      key: () => keyFor(ds),
      authHeaders: (dialect, key) => (dialect === 'messages' ? { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` }),
      models: ds.models ?? [],
      modelOverrides: ds.model_overrides ?? {},
      requestOptions: () => ({ body: {}, headers: {} }),
      endpoint(dialect) { return joinEndpoint(this.baseUrl, dialect === 'messages' ? this.messagesPath : this.responsesPath); },
    });
  }
  const or = config.upstream?.openrouter;
  if (or) {
    providers.push({
      name: 'openrouter',
      baseUrl: new URL(or.base_url),
      responsesPath: '/v1/responses',
      messagesPath: '/v1/messages',
      // OpenRouter ids are always vendor/model (optionally ~vendor/alias or a :variant suffix).
      matches: (id) => /^~?[a-z0-9-]+\/[^\s]+$/i.test(id),
      key: () => keyFor(or),
      authHeaders: (dialect, key) => ({ authorization: `Bearer ${key}`, 'http-referer': PROJECT_URL, 'x-title': 'agents-switchboard', ...(dialect === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}) }),
      models: or.models ?? [],
      modelOverrides: or.model_overrides ?? {},
      requestOptions: (dialect, conversationId, reqHeaders) => {
        const provider = { ...OPENROUTER_PROVIDER_DEFAULTS, ...(or.provider ?? {}) };
        const body = { provider };
        const headers = {};
        // Sticky routing keeps a conversation on the provider that holds its prefix cache (10 min idle expiry).
        if (conversationId) { headers['x-session-id'] = String(conversationId).slice(0, 256); if (dialect === 'responses') body.session_id = headers['x-session-id']; }
        if (dialect === 'messages') { const beta = betaForOpenRouter(reqHeaders['anthropic-beta']); if (beta) headers['x-anthropic-beta'] = beta; }
        return { body, headers };
      },
      endpoint(dialect) { return joinEndpoint(this.baseUrl, dialect === 'messages' ? this.messagesPath : this.responsesPath); },
    });
  }
  return providers;
}

/**
 * The provider that serves `model`, or null when the request should pass through to the client's vendor.
 * @param {Provider[]} providers
 * @param {string|null|undefined} model
 */
export function resolveProvider(providers, model) {
  const id = baseModelId(model);
  if (!id) return null;
  return providers.find((p) => p.matches(id)) ?? null;
}
