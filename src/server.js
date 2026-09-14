// The loopback router: one HTTP server, three route families, no state beyond counters.
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { entriesFor, catalogHash } from './catalog.js';
import { buildProviders } from './providers.js';
import { createProvenance } from './provenance.js';
import { createFailoverState } from './failover.js';
import { sendJson } from './proxy.js';
import { readCapability } from './config.js';
import { createStats } from './stats.js';
import { renderStatusPage } from './status-page.js';
import { codexRoutes } from './routes/codex.js';
import { claudeRoutes } from './routes/claude.js';
import { CODEX_PREFIX, CLAUDE_PREFIX } from './routes/shared.js';

/**
 * @typedef {object} RouteContext
 * @property {URL} openai      upstream for Codex traffic (ChatGPT backend)
 * @property {URL} anthropic   upstream for Claude Code traffic
 * @property {import('./providers.js').Provider[]} providers  third-party providers, in routing order
 * @property {{entries: object[], slugs: string[], hash: string}} catalog  entries injected into the Codex picker
 * @property {ReturnType<typeof createStats>} stats
 * @property {ReturnType<typeof createProvenance>} provenance  which provider produced which reasoning item
 * @property {{enabled: boolean, model: string|null, state: ReturnType<typeof createFailoverState>}} failover
 * @property {(line: string) => void} log
 */

/**
 * Verdict for the router's capability gate, from the `supplied` segment `readCapability` split off a
 * request URL and the loaded config.
 * - 'open': no token is configured and no capability segment was supplied.
 * - 'ok':   a supplied segment matches the configured token (timing-safe).
 * - 'deny': everything else — including a supplied segment on a tokenless router, and a configured
 *   token with no segment supplied at all.
 * @param {string|null} supplied
 * @param {{ access_token?: string }} cfg
 * @returns {'open'|'ok'|'deny'}
 */
export function authorize(supplied, cfg) {
  const token = String(cfg?.access_token ?? '');
  if (token.length === 0) return supplied === null ? 'open' : 'deny';
  if (supplied === null) return 'deny';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(token);
  return suppliedBuf.length === expectedBuf.length && timingSafeEqual(suppliedBuf, expectedBuf) ? 'ok' : 'deny';
}

/**
 * @param {object} opts
 * @param {object} opts.config      loaded switchboard config
 * @param {(section: object) => Promise<string|null>} opts.keyFor  resolves an upstream section's API key
 * @param {string} [opts.logFile]   JSONL request log
 * @param {(line: string) => void} [opts.log]
 */
export function createServer({ config, keyFor, logFile, log = () => {} }) {
  const providers = buildProviders(config, keyFor);
  const entries = entriesFor(providers);
  /** @type {RouteContext} */
  const ctx = {
    openai: new URL(config.upstream.openai.base_url),
    anthropic: new URL(config.upstream.anthropic.base_url),
    providers,
    catalog: { entries, slugs: entries.map((e) => e.slug), hash: catalogHash({ entries }) },
    stats: createStats({ logFile, log }),
    provenance: createProvenance({ file: logFile ? path.join(path.dirname(logFile), 'provenance.json') : null }),
    failover: { enabled: !!config.failover?.enabled, model: config.failover?.model ?? null, state: createFailoverState() },
    log,
  };
  if (!config.access_token) log('no access_token configured; vendor routes are unprotected until `switchboard install` mints one');
  const codex = codexRoutes(ctx);
  const claude = claudeRoutes(ctx);

  function statusJson() {
    return {
      name: 'agents-switchboard',
      listen: config.listen,
      routes: { codex: `${CODEX_PREFIX}/*`, claude: `${CLAUDE_PREFIX}/*` },
      providers: Object.fromEntries(providers.map((p) => [p.name, { models: p.models, base_url: p.baseUrl.origin }])),
      deepseekModels: ctx.catalog.slugs,
      failover: { enabled: ctx.failover.enabled, model: ctx.failover.model, active: ctx.failover.state.snapshot() },
      ...ctx.stats.snapshot(),
    };
  }

  const statusPage = (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(renderStatusPage(statusJson())); };
  /** A route family whose bare prefix (no trailing path) is gated like the rest of it but resolves to
   * nothing: matches today's behaviour where e.g. `/anthropic` alone 404s once past the gate. */
  const clientPrefix = (prefix, handle) => ({ prefix, protected: true, handle: (req, res, pathname) => (pathname === prefix ? sendJson(res, 404, { error: { message: 'agents-switchboard: unknown route' } }) : handle(req, res, pathname)) });

  /** Route table: `prefix` matches the path itself or anything nested under it; `path` matches exactly. */
  const routes = [
    clientPrefix(CODEX_PREFIX, (req, res, pathname) => codex(req, res, pathname.slice(CODEX_PREFIX.length))),
    clientPrefix(CLAUDE_PREFIX, (req, res, pathname) => claude(req, res, pathname.slice(CLAUDE_PREFIX.length), req.url.slice(CLAUDE_PREFIX.length))),
    { path: '/switchboard/health', protected: false, handle: (req, res) => sendJson(res, 200, { ok: true }) },
    { path: '/switchboard/status', protected: false, handle: (req, res) => sendJson(res, 200, statusJson()) },
    { path: '/switchboard', protected: false, handle: statusPage },
    { path: '/switchboard/', protected: false, handle: statusPage },
    {
      path: '/switchboard/failover/reset',
      protected: true,
      handle: (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 404, { error: { message: 'agents-switchboard: unknown route' } });
        ctx.failover.state.reset();
        return sendJson(res, 200, { ok: true, active: {} });
      },
    },
  ];

  const findRoute = (pathname) => routes.find((r) => (r.prefix ? (pathname === r.prefix || pathname.startsWith(r.prefix + '/')) : pathname === r.path)) ?? null;

  /** Which client a rejected path belongs to; a gate rejection is recorded so an outage is not silence. */
  const clientOf = (pathname) => (pathname === CODEX_PREFIX || pathname.startsWith(CODEX_PREFIX + '/') ? 'codex'
    : pathname === CLAUDE_PREFIX || pathname.startsWith(CLAUDE_PREFIX + '/') ? 'claude' : 'unknown');

  /** Refuse a request at the token gate, counting it: never the URL, the token or the body. */
  function gateReject(res, target, message) {
    ctx.stats.record({ client: clientOf(new URL(target, 'http://localhost').pathname), route: 'gate', upstream: null, status: 400 });
    return sendJson(res, 400, { error: { message } });
  }

  async function dispatch(req, res) {
    // No token configured (a router started before `switchboard install`, or one the installer rolled
    // back) serves the pre-token paths; the routes' own requireClientAuth still demands each client's
    // upstream credential. A request carrying a capability prefix is refused exactly as before.
    const { url, supplied } = readCapability(req.url);
    const verdict = authorize(supplied, config);
    // Never leave the capability in a path that can reach an upstream or a diagnostic log.
    req.url = url;
    if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
      return sendJson(res, 400, { error: { message: 'agents-switchboard: request target must be a local path' } });
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = findRoute(pathname);
    if ((route?.protected || supplied !== null) && verdict !== 'ok' && verdict !== 'open') {
      return gateReject(res, req.url, supplied !== null
        ? 'agents-switchboard: invalid local access token; run switchboard install to configure this client'
        : 'agents-switchboard: local access token required; run switchboard install to configure this client');
    }
    if (!route) return sendJson(res, 404, { error: { message: 'agents-switchboard: unknown route' } });
    return route.handle(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    req.proxySignal = controller.signal;
    req.once('aborted', () => controller.abort());
    res.once('close', () => controller.abort());
    dispatch(req, res).catch((e) => {
      if (res.destroyed) return;
      log(`error ${req.method} ${req.url}: ${e.message}`);
      if (res.headersSent) { res.destroy(); return; }
      if (e.status === 413) sendJson(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: `agents-switchboard: ${e.message}` } }, { connection: 'close' });
      else sendJson(res, e.status === 400 ? 400 : 502, { error: { type: 'server_error', message: `agents-switchboard: ${e.message}` } });
    });
  });
  // Upgrades carry the routing hint but not the body; phase 3 splices GPT sockets through. Declining
  // makes Codex fall back to HTTP for the session (SPEC §7).
  server.on('upgrade', (req, socket) => {
    log('declined websocket upgrade');
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.stats = ctx.stats;
  server.statusJson = statusJson;
  return server;
}
