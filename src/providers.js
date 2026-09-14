// Third-party model providers the router can send a request to, and how a model id selects one.
// The client's own vendor (OpenAI for Codex, Anthropic for Claude Code) is never a provider here:
// anything no provider claims passes through untouched.

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
 */

/** Strip a Claude-style `[1m]` context suffix. */
export function stripSuffix(model) {
  return String(model ?? '').replace(/\[1m\]$/i, '');
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
  const id = stripSuffix(model);
  if (!id) return null;
  return providers.find((p) => p.matches(id)) ?? null;
}
