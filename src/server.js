// The loopback router: one HTTP server, three route families, no state beyond counters.
import http from 'node:http';
import { entriesFor, catalogHash } from './catalog.js';
import { buildProviders } from './providers.js';
import { createProvenance } from './provenance.js';
import { createFailoverState } from './failover.js';
import { sendJson } from './proxy.js';
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
    catalog: { entries, slugs: entries.map((e) => e.slug), hash: catalogHash(entries) },
    stats: createStats({ logFile }),
    provenance: createProvenance(),
    failover: { enabled: !!config.failover?.enabled, model: config.failover?.model ?? null, state: createFailoverState() },
    log,
  };
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

  async function dispatch(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith(CODEX_PREFIX + '/')) return codex(req, res, pathname.slice(CODEX_PREFIX.length));
    if (pathname.startsWith(CLAUDE_PREFIX + '/')) return claude(req, res, pathname.slice(CLAUDE_PREFIX.length), req.url.slice(CLAUDE_PREFIX.length));
    switch (pathname) {
      case '/switchboard/health': return sendJson(res, 200, { ok: true });
      case '/switchboard/status': return sendJson(res, 200, statusJson());
      case '/switchboard': case '/switchboard/': res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(renderStatusPage(statusJson()));
      case '/switchboard/failover/reset': if (req.method === 'POST') { ctx.failover.state.reset(); return sendJson(res, 200, { ok: true, active: {} }); }
    }
    sendJson(res, 404, { error: { message: 'agents-switchboard: unknown route' } });
  }

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch((e) => {
      log(`error ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) sendJson(res, 502, { error: { type: 'server_error', message: `switchboard: ${e.message}` } });
      else res.destroy();
    });
  });
  // Upgrades carry the routing hint but not the body; phase 3 splices GPT sockets through. Declining
  // makes Codex fall back to HTTP for the session (SPEC §7).
  server.on('upgrade', (req, socket) => {
    log(`declined websocket upgrade ${req.url} (${req.headers['x-codex-routing-hint'] ?? 'no hint'})`);
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
  server.stats = ctx.stats;
  server.statusJson = statusJson;
  return server;
}
