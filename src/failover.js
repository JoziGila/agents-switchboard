// Quota failover: when a client's own vendor says the subscription is used up, finish the turn on a
// provider model and keep going there until the vendor's reset time (SPEC §8).
import { resolveProvider } from './providers.js';

/** Parse an epoch-seconds, epoch-millis, RFC 3339, or delta-seconds value into a Date, or null. */
export function parseResetAt(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n > 1e12) return new Date(n);              // epoch millis
    if (n > 1e9) return new Date(n * 1000);        // epoch seconds
    if (n >= 0) return new Date(now + n * 1000);   // delta seconds (retry-after)
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decide whether a vendor response means "subscription usage exhausted", per client.
 * @param {'codex'|'claude'} client
 * @param {number} status
 * @param {Record<string,string>} headers  response headers, lower-cased names
 * @param {string} bodyText
 * @returns {{ triggered: boolean, resetAt: Date|null, reason?: string }}
 */
export function detectExhaustion(client, status, headers, bodyText, now = Date.now()) {
  if (status !== 429) return { triggered: false, resetAt: null };
  let body = {};
  try { body = JSON.parse(bodyText); } catch { /* not JSON: fall through to header checks */ }
  const err = body?.error ?? {};
  const fallback = () => parseResetAt(headers['retry-after'], now) ?? new Date(now + 5 * 60_000);
  if (client === 'codex') {
    if (err.type !== 'usage_limit_reached') return { triggered: false, resetAt: null };
    const resetAt = parseResetAt(headers['x-codex-primary-reset-at'], now) ?? parseResetAt(err.resets_at, now) ?? fallback();
    return { triggered: true, resetAt, reason: err.message ?? 'usage_limit_reached' };
  }
  // Claude Code: per-minute rate limits are transient and retried by the client; only the subscription's
  // unified limit (rejected status header, or a message naming a session/weekly/model limit) triggers.
  if (err.type !== 'rate_limit_error') return { triggered: false, resetAt: null };
  const unified = headers['anthropic-ratelimit-unified-status'];
  const message = String(err.message ?? '');
  const looksLikeQuota = unified === 'rejected' || /\b(session|weekly|monthly|usage|opus|sonnet|fable)\b.*\blimit\b|\blimit\b.*\b(session|weekly|monthly)\b/i.test(message);
  if (!looksLikeQuota) return { triggered: false, resetAt: null };
  const resetAt = parseResetAt(headers['anthropic-ratelimit-unified-reset'], now) ?? fallback();
  return { triggered: true, resetAt, reason: message || 'rate_limit_error' };
}

/** Per-client exhaustion state. */
export function createFailoverState() {
  /** @type {Record<string, {until: Date, reason: string, since: Date}|undefined>} */
  const active = {};
  return {
    activate(client, until, reason) { active[client] = { until, reason, since: new Date() }; },
    isActive(client, now = Date.now()) {
      const a = active[client];
      if (!a) return false;
      if (a.until.getTime() <= now) { delete active[client]; return false; }
      return true;
    },
    reset() { for (const k of Object.keys(active)) delete active[k]; },
    snapshot(now = Date.now()) {
      return Object.fromEntries(Object.entries(active).filter(([, a]) => a && a.until.getTime() > now).map(([c, a]) => [c, { until: a.until.toISOString(), since: a.since.toISOString(), reason: a.reason }]));
    },
  };
}

/**
 * The one failover decision both routes ask: should this request go to the fallback provider now,
 * and on which model? `fallback` is the configured provider whenever failover is enabled and that
 * model resolves — routes need it to know whether a 429 is worth inspecting even when not yet armed.
 * `fallbackModel` is what crosses the wire when the request does go to the fallback (armed now, or
 * armed by the 429 on this very response); it is `ctx.failover.model` whenever a fallback is
 * resolved (independent of `armed`) and null otherwise — routes only read it once `fallback` is known
 * truthy, so callers must keep using the requested `model` themselves outside that branch.
 * @param {import('./server.js').RouteContext} ctx
 * @param {'codex'|'claude'} client
 * @param {string} model  the model the request asked for
 * @returns {{ armed: boolean, fallback: import('./providers.js').Provider|null, fallbackModel: string|null }}
 */
export function plan(ctx, client, model) {
  const fallback = ctx.failover.enabled ? resolveProvider(ctx.providers, ctx.failover.model) : null;
  const armed = Boolean(fallback) && ctx.failover.state.isActive(client);
  return { armed, fallback, fallbackModel: fallback ? ctx.failover.model : null };
}

/**
 * Headers a transient 429 keeps, per client: the retry hint, plus the vendor's own usage-meter
 * headers (`x-codex-*` for the Codex backend, `anthropic-ratelimit-*` for the Anthropic one).
 * @type {Record<'codex'|'claude', string[]>}
 */
const TRANSIENT_429_HEADERS = { codex: ['retry-after', 'x-codex-'], claude: ['retry-after', 'anthropic-ratelimit-'] };

const keptOn429 = (client, name) => (TRANSIENT_429_HEADERS[client] ?? []).some((p) => name === p || name.startsWith(p));

/**
 * Is this 429 a transient limit for this client (i.e. carries its retry/meter signals) rather than
 * an exhausted subscription? The vendor's own verdict lives in `detectExhaustion`; this only reads
 * the per-client header allow-list.
 * @param {'codex'|'claude'} client
 * @param {Record<string,string>} headers  response headers, lower-cased names
 */
export function transient429(client, headers) {
  return Object.keys(headers ?? {}).some((name) => keptOn429(client, name));
}

/** The subset of a 429's headers to hand back to the client untouched. */
export function transient429Headers(client, headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => keptOn429(client, name)));
}
