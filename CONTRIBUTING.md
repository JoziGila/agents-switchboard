# Contributing

Thanks for helping. This project is small on purpose: plain ESM JavaScript, Node 22+, one dependency (`smol-toml`), tests with `node:test`, no build step.

## Setup

```
git clone https://github.com/JoziGila/agents-switchboard
cd agents-switchboard
npm ci
npm test
```

`npm run check` syntax-checks every module. `npm test` runs the unit and integration tests; the integration tests start mock OpenAI, Anthropic and DeepSeek upstreams on loopback and never touch the network or your home directory.

To run the router from the checkout: `node bin/switchboard.js serve --port 4242`, then point a client at it with an override only, for example `ANTHROPIC_BASE_URL=http://127.0.0.1:4242/anthropic claude -p "hi"`. This changes nothing on disk. The tokenless `http://127.0.0.1:4242/anthropic` URL is valid only while the dev config has no `access_token`: a tokenless router serves the legacy vendor paths, while one with a token answers those paths with HTTP 400 and reinstall guidance.

## Layout

| Path | What lives there |
|---|---|
| `bin/switchboard.js` | executable entry, delegates to `src/cli.js` |
| `src/cli.js` | command dispatch and `serve` |
| `src/server.js` | the HTTP server: builds the route context and dispatches by path prefix |
| `src/routes/` | one module per client (`codex.js`, `claude.js`) plus shared helpers |
| `src/adapters/` | pure request rewrites for DeepSeek's Responses and Messages dialects, error mapping, the DeepSeek probe |
| `src/catalog.js` | the bundled DeepSeek entries, generic entries for other provider models, and the picker merge |
| `src/providers.js` | third-party model providers and the model-id predicate that selects one (`resolveProvider`/`matches`); anything no provider claims passes through |
| `src/failover.js` | quota-failover detection from the vendors' 429 shapes, and the per-client active state |
| `src/provenance.js` | which provider produced which reasoning item, so reasoning is replayed only to the provider that can read it |
| `src/paths.js` | filesystem locations and client detection; everything else derives paths from here |
| `src/proxy.js`, `src/sse.js` | streaming reverse-proxy primitives and the SSE relay |
| `src/stats.js`, `src/status-page.js` | counters, cost estimate, request log, status page |
| `src/install/` | client detection, config edits, role files, login service, secrets |
| `src/commands/` | one module per CLI command |
| `catalog/` | DeepSeek's own Codex model entries, carried verbatim |
| `test/` | `node:test` suites; `*.test.js` |
| `SPEC.md` | the design, with the verified client internals it depends on |

## Rules of the road

- **Pass-through stays byte-for-byte.** Anything on the OpenAI or Anthropic path is forwarded unchanged: headers, bodies, response bytes. If you must modify a request, do it only on the DeepSeek path.
- **Never return 401 to a client.** Both clients treat a 401 from their backend as an expired login and start a token refresh. Report auth problems as 400 with a clear message.
- **Never point a client at a router that is not up.** The installer starts the service, waits for `/switchboard/health`, and completes a real turn per client before it edits any client config. Keep that ordering.
- **Adapters are pure functions.** `rewriteResponsesRequest` and `rewriteMessagesRequest` take a parsed body and return a new one, deterministically. Add a fixture-based test for every field you touch, and remember that DeepSeek's prefix cache depends on byte-stable requests.
- **Config edits are marker-guarded, backed up, idempotent, and reversible.** `switchboard uninstall` must always restore what `install` changed.
- **No secrets on disk or in logs.** Keys live in the OS keychain or an env var. Logs hold metadata only.

## Submitting changes

Open a pull request against `main` with tests. Describe which client and which model you verified against, and paste the relevant `switchboard test` and `switchboard doctor` output. Keep the spec in sync: if you change behaviour the spec describes, change the spec in the same PR.
