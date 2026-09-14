// Quota failover: when a client's own vendor says the subscription is used up, finish the turn on a
// provider model and keep going there until the vendor's reset time (SPEC §8).

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
 * Reshape a Codex body built for a responses-lite model (GPT-6 Astra) into the plain form: the
 * `additional_tools` developer item becomes `tools`. Bodies without that item are returned as is.
 */
export function liftResponsesLite(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  const lite = items.find((i) => i?.type === 'additional_tools');
  if (!lite) return body;
  const tools = [...(Array.isArray(body.tools) ? body.tools : []), ...(Array.isArray(lite.tools) ? lite.tools : [])];
  return { ...body, tools, input: items.filter((i) => i !== lite) };
}
