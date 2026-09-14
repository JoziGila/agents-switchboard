// Helpers shared by the client route modules.
import { sendJson, upstreamHeaders } from '../proxy.js';

export const CODEX_PREFIX = '/backend-api/codex';
export const CLAUDE_PREFIX = '/anthropic';

const DROP_FOR_PROVIDER = new Set(['authorization', 'x-api-key', 'chatgpt-account-id', 'session_id', 'session-id', 'thread-id', 'originator', 'anthropic-beta', 'anthropic-version', 'openai-beta', 'content-encoding', 'content-length', 'accept-encoding', 'x-client-request-id', 'anthropic-dangerous-direct-browser-access']);
const DROP_PREFIXES = ['x-codex-', 'x-openai-', 'x-claude-code-', 'x-stainless-', 'x-app'];

/**
 * Headers for a request the router rewrites and sends to a third-party provider: client-identifying and
 * vendor-specific headers are dropped, the provider's auth is added, the body is plain JSON over SSE.
 */
export function providerHeaders(reqHeaders, url, auth, payloadLength) {
  const out = {};
  for (const [k, v] of Object.entries(upstreamHeaders(reqHeaders, url))) {
    if (DROP_FOR_PROVIDER.has(k) || DROP_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return { ...out, ...auth, 'content-type': 'application/json', 'content-length': payloadLength, accept: 'text/event-stream', 'accept-encoding': 'identity' };
}

/** `x-codex-routing-hint: model=gpt-5.5` → `gpt-5.5`. */
export function modelFromRoutingHint(header) {
  const m = /(?:^|[;,\s])model=([^;,\s]+)/.exec(header ?? '');
  return m ? m[1] : null;
}

/**
 * Pass-through routes require the client's own credential, so a stray local process cannot reach
 * a vendor through the router anonymously. The credential is not validated here; the upstream does that.
 */
export function requireClientAuth(req, res) {
  if (req.headers.authorization || req.headers['x-api-key']) return true;
  sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'agents-switchboard: pass-through requires the client credential' } });
  return false;
}

/**
 * A missing provider key is reported as 400, never 401: both clients treat a 401 from their backend
 * as an expired login and start a token refresh.
 */
export async function requireProviderKey(provider, res) {
  const key = await provider.key();
  if (!key) sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `agents-switchboard: no ${provider.name} API key configured. Run \`switchboard install\`.` } });
  return key;
}

/** Conversation identity for cache-affine routing and attribution, per client. */
export function conversationId(headers) {
  if (headers['thread-id']) return String(headers['thread-id']);
  if (headers['x-claude-code-session-id']) return [headers['x-claude-code-session-id'], headers['x-claude-code-agent-id']].filter(Boolean).join('/');
  return headers['session-id'] ? String(headers['session-id']) : null;
}
