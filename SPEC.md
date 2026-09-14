# agents-switchboard — Specification

Status: v0.7, 2026-09-14. Quota failover implemented for both clients (§8). OpenRouter added as a second provider for both clients; DeepSeek integration follows DeepSeek's own harness (Appendix D, docs/deepseek-standard.md). Both base-URL contracts verified live (§2.1). Phase 1 implemented, installed on the author's machine, and verified with `switchboard test`: a Codex explorer ran 14 requests on DeepSeek Flash (94% cache hits) and a Claude Code explorer ran on Flash.
Reviewed against: openai/codex `main` @ 2f8603f (CLI 0.154.0, desktop runtime 0.154.0-alpha.6.2); Claude Code 2.1.270 and its gateway protocol docs; DeepSeek API docs (Responses API, Anthropic-compatible API, context caching, pricing) as of 2026-09-14.

## 1. Summary

`agents-switchboard` is a loopback HTTP router that sits between your coding agents and the model backends. Codex and Claude Code keep using their normal subscription logins and believe they are talking to OpenAI and Anthropic. The installer gives both clients a protected local capability URL, the switchboard forwards native-vendor requests unchanged, and sends any request for a DeepSeek model to DeepSeek instead.

What you get, in both Codex (desktop and CLI) and Claude Code (desktop, CLI, IDE):

- Native subagents run on DeepSeek V4.1 Flash by default. The orchestrating session stays on GPT‑6 or Claude.
- DeepSeek is a first-class entry in each app's model picker, so it can be the main model with one click.
- When the subscription usage limit is hit, the switchboard fails the session over to DeepSeek and the turn completes.
- DeepSeek's prefix cache is used deliberately, so exploration and review cost cents.
- One command installs everything for both clients. One command removes it. Nothing in either client is patched.

### 1.1 Goals

1. DeepSeek Flash as the default model for native subagents in Codex and Claude Code, orchestrated from the frontier model you already pay for.
2. Full, unchanged use of GPT and Claude models through the ChatGPT and claude.ai subscription logins.
3. DeepSeek selectable as the main model, by picker or by automatic quota failover.
4. Correct rendering in both desktop UIs: picker, agent panel, streaming, diffs, usage and cache statistics.
5. Maximal DeepSeek prefix-cache hit rate.
6. Open source (MIT), `npx` install on macOS, Linux, Windows, reversible, no secrets in files.

### 1.2 Non-goals

- Patching or forking Codex or Claude Code.
- Translating between API dialects. Codex traffic stays Responses API, Claude Code traffic stays Anthropic Messages. DeepSeek speaks both natively.
- Remote or multi-user deployment. Loopback only.
- Replacing either client's picker, usage meter, or agent UI.

## 2. Why a router

Both clients let you choose a model per subagent, and neither lets you choose a provider per subagent.

**Codex.** `agents.default_subagent_model` sets the spawned model; the slug must exist in the session's models list and, under multi-agent v2, must not be flagged `multi_agent_version = "disabled"`. Role files may override model, reasoning effort and summary, verbosity, personality, service tier, feature-disables and skills, and nothing else. Since PR #39299 (2026‑08‑18) a role's `model_provider` is silently discarded; children always inherit the parent's provider (`codex-rs/core/src/agent/role.rs`, `AgentRoleOverrides`).

**Claude Code.** `CLAUDE_CODE_SUBAGENT_MODEL` and the frontmatter `model:` accept full model names, but every request goes to the one `ANTHROPIC_BASE_URL`. There is no per-agent base URL, and the documented `fallbackModel` chain explicitly does not trigger on rate-limit errors.

Both clients, however, let the one provider they use be re-pointed while keeping subscription auth:

- Codex: `openai_base_url` in `config.toml` becomes the built-in OpenAI provider's `base_url`. If it ends with `/backend-api/codex`, Codex still treats it as the Codex backend: ChatGPT auth is attached, `/models` is fetched from it, rate-limit headers are read from it (`model-provider-info/src/lib.rs` `supports_codex_backend_routes`, `core/src/client.rs` `uses_codex_backend`).
- Claude Code: `ANTHROPIC_BASE_URL` set without any credential variable routes through the gateway while "a saved claude.ai login stays the active credential, so the subscription's usage limits and billing apply". The OAuth capability travels in the `anthropic-beta` header, which the gateway forwards verbatim (gateway protocol doc).

A loopback router at those URLs receives every request each client makes, with the user's own token, and dispatches by model. That is the whole trick.

### 2.1 Verified on the wire

Captured on 2026-09-14 by pointing each client at a local listener that rejected every request:

- Codex 0.154.0 with `openai_base_url` set to a `/backend-api/codex` URL sent `GET /models?client_version=0.154.0`, then a WebSocket upgrade on `/responses`, then after the 426 an HTTP `POST /responses`. Every request carried `Authorization: Bearer <ChatGPT JWT>` and `chatgpt-account-id`. The POST body is `content-encoding: zstd`, and both the upgrade and the POST carry `x-codex-routing-hint: model=<slug>`. So the router can route GPT traffic, including the WebSocket, from a header without touching the body, and only decompresses bodies it rewrites.
- Claude Code 2.1.270 with `ANTHROPIC_BASE_URL` set and no credential variable sent `HEAD /api/hello`, then `POST /v1/messages?beta=true` with `Authorization: Bearer sk-ant-oat01-…` (the claude.ai OAuth token) and `anthropic-beta` containing `oauth-2025-04-20`. The first call was the session-title request (`thinking: disabled`, `output_config.format` json schema); the main call carried `thinking: {type: "adaptive", display: "omitted"}`, `context_management` edits, `output_config.effort`, a three-block `system` with the attribution block first and 1 h `cache_control` on the other two, and a mid-conversation `role: "system"` message.

## 3. Architecture

```
 Codex desktop / CLI                       agents-switchboard  127.0.0.1:4141                 upstreams
 provider = openai                       ┌────────────────────────────────────────────┐
 openai_base_url =                       │ /backend-api/codex/models ── merge catalog ─┼─▶ chatgpt.com/backend-api/codex
   http://127.0.0.1:4141/_switchboard/<token>/backend-api/codex
                                         │ /backend-api/codex/responses               │
 ───────────────────────────────────────▶│     gpt-*      ── pass-through ─────────────┼─▶ chatgpt.com/backend-api/codex/responses
                                         │     deepseek-* ── responses adapter ────────┼─▶ api.deepseek.com/responses
                                         │     other      ── pass-through ─────────────┼─▶ chatgpt.com/backend-api/codex/*
 Claude Code desktop / CLI / IDE         │                                            │
 ANTHROPIC_BASE_URL =                    │ /anthropic/v1/messages                     │
   http://127.0.0.1:4141/_switchboard/<token>/anthropic
                                         │     claude-*   ── pass-through ─────────────┼─▶ api.anthropic.com/v1/messages
 ───────────────────────────────────────▶│     deepseek-* ── messages adapter ─────────┼─▶ api.deepseek.com/anthropic/v1/messages
                                         │ /anthropic/*   ── pass-through ─────────────┼─▶ api.anthropic.com/*
                                         │                                            │
                                         │ /switchboard/* ── status, log, control      │
                                         └────────────────────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| `server` | HTTP/1.1 on loopback. Streams bodies both ways, never buffers SSE, relays keep-alive pings and emits its own during silent gaps. |
| `router` | Pure function: (client, path, model) → upstream. Unit tested against a table. |
| `upstream/openai` | Byte-for-byte reverse proxy to `chatgpt.com/backend-api/codex`. |
| `upstream/anthropic` | Byte-for-byte reverse proxy to `api.anthropic.com`. |
| `upstream/deepseek-responses` | Responses API adapter for `api.deepseek.com/responses`. |
| `upstream/deepseek-messages` | Anthropic Messages adapter for `api.deepseek.com/anthropic/v1/messages`. |
| `catalog` | Injects DeepSeek entries into the Codex `/models` response and rewrites its ETag. |
| `failover` | Detects subscription usage-limit responses, retries on the fallback model, remembers the reset time, per client. |
| `secrets` | DeepSeek key from the OS keychain or an env var. Never from a config file. |
| `installer` | Detects which clients are present, writes their config, role files and delegation policy, registers the login service, backs up, restores. |
| `status` | `/switchboard/status` JSON and one HTML page: routes, upstream health, failover state, tokens, cache hit ratio, estimated spend, per client and per role. |

`config.access_token` is the single authority for the local capability prefix. The installer creates it with `randomBytes(32).toString('base64url')`, preserves it on reinstall, and writes `~/.agents-switchboard/config.toml` with user-only permissions. Runtime code derives protected URLs through `routerBaseUrl(config)`, which returns `http://<listen>/_switchboard/<token>` and throws a reinstall-guidance error if a caller needs a protected URL but the token is missing.

Runtime: Node 22+, no native modules, single npm package `agents-switchboard`, binary `switchboard`. Every Codex and Claude Code user already has npm.

## 4. Routing

### 4.1 Route table

| Client | Request | Upstream | Handling |
|---|---|---|---|
| Codex | `GET /_switchboard/<token>/backend-api/codex/models` | OpenAI | Proxy, merge catalog, rewrite ETag (§5.1). |
| Codex | `POST /_switchboard/<token>/backend-api/codex/responses`, DeepSeek model | DeepSeek | Responses adapter (§6). |
| Codex | `POST /_switchboard/<token>/backend-api/codex/responses`, other model | OpenAI | Pass-through; failover hook (§8). |
| Codex | WebSocket upgrade on `/responses` | none | 426; Codex drops to HTTP for that session (§7). The upgrade carries `x-codex-routing-hint`, so phase 3 can splice GPT sockets through. |
| Codex | anything else under `/_switchboard/<token>/backend-api/codex/` | OpenAI | Pass-through: usage, compaction, realtime, connectors, memories. |
| Claude | `POST /_switchboard/<token>/anthropic/v1/messages`, DeepSeek model | DeepSeek | Messages adapter (§6). |
| Claude | `POST /_switchboard/<token>/anthropic/v1/messages`, other model | Anthropic | Pass-through; failover hook (§8). |
| Claude | `POST /_switchboard/<token>/anthropic/v1/messages/count_tokens`, DeepSeek model | local | 404. Claude Code falls back to its character estimate. |
| Claude | `HEAD /_switchboard/<token>/anthropic/api/hello` | local | 200. Connection-warming probe. |
| Claude | anything else under `/_switchboard/<token>/anthropic/` | Anthropic | Pass-through. |
| any | `/switchboard/*` | local | Status and control. |

Legacy unprotected vendor paths (`/backend-api/codex/*`, `/anthropic/*`) fail with HTTP 400 and reinstall guidance once a token is configured, while a router that has none (started before `switchboard install`, or restored by its rollback) still serves them. Wrong local capability tokens and provider-key failures also fail with HTTP 400. Real upstream subscription 401s remain byte-for-byte pass-through so native login refresh still works. Health, status JSON and the status page stay public. Failover reset is a protected control route at `/_switchboard/<token>/switchboard/failover/reset`.

A request leaves the client's own vendor only when a provider claims its model id (after stripping a Claude-style `[1m]` suffix). The rule is the id's shape, so no list has to be maintained for routing:

| Id shape | Provider | Examples |
|---|---|---|
| `deepseek-*` (no slash) | DeepSeek direct | `deepseek-flash`, `deepseek-v4-pro` |
| `vendor/model`, optionally `~vendor/alias` or a `:variant` suffix | OpenRouter | `deepseek/deepseek-v4.1-flash`, `qwen/qwen3-coder`, `~anthropic/claude-opus-latest`, `openai/gpt-5.5:nitro` |
| anything else | pass-through to the client's vendor | `gpt-6-astra`, `claude-sonnet-5` |

For Codex the id comes from the `x-codex-routing-hint` header, so pass-through bodies are never decompressed; for Claude Code it comes from the JSON body. The catalog (§5) decides only what is advertised in the Codex picker; any OpenRouter id typed into either client routes correctly whether or not it is advertised. The catalog is the single source of truth for both the Codex picker entries and the routing decision, so a model can never be advertised without a route.

### 4.2 Pass-through contract

Pass-through means: method, vendor path, query, every request header, every request byte, every response header, every response byte. The switchboard removes only the local `/_switchboard/<token>` prefix before dispatching or forwarding. This is what keeps ChatGPT auth, `chatgpt-account-id`, `session_id`, `originator`, `x-codex-*` sticky routing, `anthropic-beta` with its OAuth capability, `anthropic-version`, `cache_control`, the system-prompt attribution block, rate-limit headers, and every future capability working without the switchboard knowing about them.

### 4.3 DeepSeek-bound headers

Authorization is replaced with the DeepSeek key (`Authorization: Bearer` for the Responses API, `x-api-key` for the Anthropic-compatible API). Client-identifying and backend-specific headers are dropped: `chatgpt-account-id`, `session_id`, `originator`, `x-codex-*`, `x-claude-code-*`, `anthropic-beta`, `anthropic-version`. `x-claude-code-agent-id` and `x-openai-subagent` are read for attribution before being dropped.

## 5. Models in the picker

### 5.1 Codex: catalog injection

Codex fetches `GET {base_url}/models?client_version=…`, caches it in `~/.codex/models_cache.json`, and revalidates by ETag. The picker, the effort menu, per-model tool wiring, base instructions, and the `spawn_agent` model whitelist all derive from that list.

The switchboard proxies the request, appends the provider entries, serves upstream entries marked `multi_agent_version: "v2"` as `"v1"` (see §10.1 for why), and rewrites the ETag to `"<upstream-etag>+sb<hash>"` over everything it changed, so any change invalidates the app's cache while upstream changes still propagate. No `model_catalog_json` is written: a static catalog would freeze OpenAI's live list.

The bundled entries (`catalog/deepseek.models.json`) are the ones DeepSeek ships in its own Codex setup script (`cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh` v1.3.0), carried verbatim because they encode DeepSeek's tested choices:

| Field | deepseek-flash | Why it matters |
|---|---|---|
| `tool_mode` | unset | No code mode: GPT‑6 Astra uses `tool_mode = code_mode_only` and drives tools through JavaScript; a provider model gets ordinary function calls. (`shell_type` is a deserialisation alias of `unified_exec` in current Codex and makes no difference.) |
| `apply_patch_tool_type` | `freeform` | DeepSeek's Responses API accepts one custom tool name, `apply_patch`. |
| `use_responses_lite` | `false` | Tools stay in `tools`, not folded into the input. |
| `multi_agent_version` | served as `v1` | Eligible for `spawn_agent`; every entry the router serves, injected or upstream, is v1 so no session ever produces encrypted spawn payloads (§10.1). |
| `supported_reasoning_levels` | low, high, max | Passed through as `reasoning.effort`. |
| `default_reasoning_summary` | `none` | DeepSeek returns no summaries; the UI does not wait for one. |
| `context_window` | 1,048,576 at 95% | Matches the API. |
| `input_modalities` | text, image | Flash accepts images. V4 Pro is text only. |
| `base_instructions` | 17.7 KB, identical for every role | The shared cache prefix (§9). |
| `prefer_websockets` | `false` | HTTP only. |

OpenRouter models listed under `[upstream.openrouter] models` get a generic entry derived from the Flash template: plain function tools, function-style `apply_patch` (OpenRouter's Responses API documents function tools only), no responses-lite, a 262K context and a `low | medium | high` effort menu by default. `[upstream.openrouter.model_overrides."vendor/model"]` overrides any field, typically `context_window` and `display_name`.

`deepseek-v4-pro` is a second, optional entry. DeepSeek's Responses API doc lists only `deepseek-flash`, while their Codex script registers both; the installer probes each slug and advertises the ones that answer.

### 5.2 Claude Code: custom model option

Claude Code adds one arbitrary, unvalidated model to `/model` through three env vars. The installer writes them to `~/.claude/settings.json`:

```json
"ANTHROPIC_CUSTOM_MODEL_OPTION": "deepseek-flash",
"ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "DeepSeek Flash",
"ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "DeepSeek V4.1 Flash · 1M context · via switchboard"
```

The entry appears after the built-in rows. `deepseek-v4-pro` is reachable with `/model deepseek-v4-pro`. Gateway model discovery (`/v1/models`) is not used: it is skipped entirely when the only credential is a claude.ai login, and it filters out ids that do not contain `claude` or `anthropic`.

## 6. DeepSeek adapters

DeepSeek exposes both dialects natively, stateless, with documented gaps. Each adapter is a pure request rewrite plus a streamed response pass-through, tested against fixtures captured from real client requests.

### 6.1 Responses adapter (Codex)

DeepSeek Responses API: only `function` tools plus the `apply_patch` custom tool; no `previous_response_id`; `store` always false; no encrypted reasoning; `reasoning.summary` accepted but empty; built-in tools ignored; unknown parameters ignored; standard `response.*` SSE events.

Request rewrite:

1. `include`: remove `reasoning.encrypted_content`; drop the key if empty.
2. `input`: a `reasoning` item is replayed only to the provider that produced it, tracked by item id in the provenance store (persisted to `~/.agents-switchboard/provenance.json` so a router restart keeps a live conversation's own reasoning). Foreign items are dropped: after a mid-conversation switch from GPT‑6 to DeepSeek, GPT's reasoning items carry `content` that DeepSeek rejects (`Invalid 'input[7].content': array too long`), and a GPT parent's encrypted items are unreadable anyway. The provider's own reasoning text is never touched: DeepSeek recovers a turn's thinking signature by hashing that exact text, and its own harness replays it on every turn for that reason (docs/research/deepseek-harness-learnings.md).
3. `tools`: keep `function` and the `apply_patch` custom tool. Members of a `namespace` wrapper (Codex's collaboration tools, MCP servers) are sent as flat functions named `<namespace>__<name>`, and calls the model makes to them are decoded back into Codex's `namespace` + `name` on the way out, using the exact map built from the request rather than string parsing, since MCP namespaces already contain `__`. History `function_call` items get the same encoding. Remove `web_search`, `image_generation`.
4. Remove `store`, `prompt_cache_key`, `service_tier`, `safety_identifier`, `text`, `client_metadata`, and each input item's `internal_chat_message_metadata_passthrough`. DeepSeek would ignore them; removing keeps the body identical across requests. Bodies arrive zstd-compressed and are re-sent as plain JSON.
5. `reasoning.effort`: pass low, high, max; map medium → high, xhigh → max, ultra → max.
6. Everything else (`instructions`, `input` order, `parallel_tool_calls`, `stream`) untouched.

Response: SSE forwarded unchanged. The switchboard reads `usage` from `response.completed` for its counters, preferring the OpenAI-compatible `input_tokens_details.cached_tokens` and falling back to DeepSeek's `prompt_cache_hit_tokens`, and remembering that DeepSeek's prompt totals include cache hits, and maps DeepSeek HTTP errors to the OpenAI envelope Codex expects (401 → `invalid_api_key`, 429 → `rate_limit_exceeded`, 5xx → `server_error`) so Codex's retry logic behaves normally.

### 6.2 Messages adapter (Claude Code)

DeepSeek Anthropic-compatible API at `api.deepseek.com/anthropic`: `system`, `messages`, `tools`, `tool_choice`, `stream`, `temperature`, `stop_sequences`, `metadata.user_id` supported; `thinking` supported with `budget_tokens` ignored; `output_config.effort` supported; `cache_control`, `top_k`, `anthropic-beta`, `anthropic-version`, `service_tier`, `container`, `mcp_servers` ignored; `documents`, `search_results`, `redacted_thinking`, code-execution results and MCP tool blocks unsupported. Claude model names are remapped by DeepSeek itself (opus → v4-pro, sonnet/haiku → flash), which the failover path relies on.

Request rewrite:

1. `model`: strip a `[1m]` suffix (Claude Code normally strips it itself).
2. `thinking`: `{"type": "adaptive"}` becomes `{"type": "enabled"}`. Claude Code sends adaptive for every model it does not recognise.
3. `system` array and `messages` forwarded unchanged, including the attribution block (stable per conversation since Claude Code 2.1.181), `cache_control` markers, and every `thinking` block DeepSeek previously returned. Nothing is reordered or merged.
4. Content blocks DeepSeek rejects (`document`, `search_result`, `redacted_thinking`) are dropped from `messages` with a log line. Text and tool blocks are never touched.
5. `context_management`, `tool` beta fields (`strict`, `defer_loading`), `metadata` other than `user_id`: left in place. DeepSeek ignores unknown fields.
6. Mid-conversation `role: "system"` messages (the `mid-conversation-system` beta) become `role: "user"` messages with the same content, since DeepSeek's endpoint accepts only user and assistant roles in `messages`.
7. `output_config.format` (structured output) is removed with a log line; DeepSeek supports only `effort` there. In the installed configuration Claude Code's background traffic (session titles, classifier and helper calls) follows the small-fast and classifier models, which stay on Anthropic; this path is exercised only when DeepSeek is the main model or `ANTHROPIC_DEFAULT_HAIKU_MODEL` is pinned to it.

Response handling:

- SSE forwarded unchanged (`message_start`, `content_block_*`, `message_delta`, `message_stop`, `ping`). On the Responses side, `response.completed.usage` is normalised to the OpenAI spellings (`total_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`) so Codex's context meter and compaction thresholds see the native shape.
- Ping insurance: Claude Code aborts a stream silent for 300 s. If DeepSeek sends no bytes for 20 s, the switchboard emits `event: ping` itself.
- Usage normalisation: if the final usage lacks `cache_read_input_tokens` but carries DeepSeek's `prompt_cache_hit_tokens`, the switchboard fills `cache_read_input_tokens` and `cache_creation_input_tokens: 0` so `/usage` shows the prompt-cache line and per-model figures for DeepSeek turns. For its own counters the router treats Anthropic's `input_tokens` as the uncached part, so the prompt total is `input + cache_read + cache_creation`, and a `message_delta` that carries only `output_tokens` never zeroes the earlier counts.
- Error bodies forwarded unmodified. Claude Code matches on upstream error wording to decide its own recovery, and wrapping breaks that.

Thinking blocks across providers: Anthropic rejects thinking blocks it did not sign. When a conversation that ran on DeepSeek returns to Claude (failback, or the user switching models), the switchboard strips assistant `thinking` blocks that carry no signature from Anthropic-bound requests. Claude Code would recover on its own after one rejected request; stripping saves that round trip.

### 6.3 Provider profiles

Both adapters take a profile, so one code path serves every provider and the differences are data:

| | DeepSeek | OpenRouter |
|---|---|---|
| Responses endpoint | `/responses` | `/v1/responses` (stateless; rejects `store: true` and `previous_response_id`, both removed anyway) |
| Messages endpoint | `/anthropic/v1/messages` | `/v1/messages` |
| Effort ladder | `low, high, max` | `minimal, low, medium, high` |
| Custom tools kept | `apply_patch` | none (function tools only) |
| Encrypted reasoning sent back | never | only for items OpenRouter itself produced, tracked by id in a bounded in-memory LRU (a hit refreshes the id), so a fork from a GPT parent never forwards OpenAI's encrypted items and an OpenRouter-main session keeps its own chains. A router restart forgets the set, which costs one prefix rebuild per live OpenRouter conversation |
| `thinking: adaptive` | rewritten to `enabled` | passed through (OpenRouter forwards it to Anthropic-hosted models) |
| `output_config.format` | dropped | kept |
| Mid-conversation `system` messages | converted to `user` | converted to `user` |
| Unsupported content blocks | `document`, `search_result`, `redacted_thinking` dropped | all kept |
| Empty assistant content, empty tool output | `""` and `(no output)` placeholders (harness rule) | left as sent |
| Auth | `Authorization: Bearer` (Responses), `x-api-key` + Bearer (Messages) | `Authorization: Bearer` plus `HTTP-Referer` and `X-Title` attribution |
| Routing preferences | none | `provider: { require_parameters: true, allow_fallbacks: true }` by default, so a request with tools or reasoning never lands on a provider that would drop them silently; `[upstream.openrouter.provider]` adds or overrides keys (`sort = "throughput"`, `data_collection = "deny"`, `order`, `ignore`, `max_price`, `preferred_min_throughput`), and a `:nitro` or `:floor` model suffix works as OpenRouter documents |
| Sticky routing | not applicable | `session_id` (Responses body) and `x-session-id` (both dialects) set from the conversation: Codex `thread-id`, Claude Code session id plus agent id. OpenRouter then keeps the conversation on the provider that holds its prefix cache; the affinity expires after 10 idle minutes. Not sent when `provider.order` is configured, since OpenRouter disables stickiness then |
| Anthropic beta features | dropped | Claude Code's `anthropic-beta` values are forwarded as `x-anthropic-beta` minus the login and client markers, so interleaved thinking and structured outputs survive on Anthropic-hosted models |
| Cost | estimated from the bundled DeepSeek price table with peak detection | taken from `usage.cost` when OpenRouter reports it |
| Errors | never 401/402/403 to the client; OpenRouter's `error.metadata.error_type` and `provider_name` are folded into the message |

## 7. WebSocket policy (Codex)

The built-in OpenAI provider advertises WebSocket support and Codex tries to upgrade `/responses` once per thread spawn. The upgrade carries the routing hint but not the request body, so it is declined with 426 and Codex calls `force_http_fallback`, continuing over HTTP with full request bodies, which is exactly what a stateless backend needs. Cost: a slower first request per thread spawn and no incremental appends for GPT traffic, which affects latency, not correctness; the 426 lines in the log are expected noise until phase 3 splices GPT sockets through. Version 3 accepts the upgrade, reads the first `response.create` frame to learn the model, splices GPT sockets through to `wss://chatgpt.com`, and closes DeepSeek sockets with a retryable error so only those sessions drop to HTTP. Claude Code does not use WebSockets.

## 8. Quota failover

### 8.1 Triggers

| Client | Signal |
|---|---|
| Codex | HTTP 429 from ChatGPT with body `error.type = "usage_limit_reached"`, plus `x-codex-primary-used-percent`, `x-codex-primary-reset-at`, `x-codex-rate-limit-reached-type` headers (`codex-api/src/api_bridge.rs`). |
| Claude Code | HTTP 429 from Anthropic with `error.type = "rate_limit_error"` and the subscription's unified-limit signal (`anthropic-ratelimit-unified-status: rejected` header, or a message naming a session, weekly, or model limit). The documented `retry-after`-style per-minute limits are not a trigger: they are transient and both clients retry them. |

The exact Claude 429 for subscriptions is not in public docs; the detector accepts the unified-limit `rejected` header or a message naming a session, weekly, monthly, or model limit, and treats every other `rate_limit_error` as transient. The first real capture will be pinned as a fixture.

### 8.2 Behaviour

With `failover.enabled = true` (the default), pass-through bodies are buffered instead of streamed so they can be re-sent; on a trigger the switchboard:

1. records `exhausted_until` per client from the reset header (`x-codex-primary-reset-at`, `anthropic-ratelimit-unified-reset`), else `error.resets_at`, else `retry-after`, else now + 5 min;
2. rewrites the request for the fallback model (§8.3) and sends it to DeepSeek;
3. streams the DeepSeek response back, so the turn completes;
4. logs one line and flips the status page to "failover active for <client> until <time>".

While `exhausted_until` is in the future, that client's frontier-bound requests go straight to the fallback. After it passes, the next request tries the frontier upstream again. `switchboard failover reset` clears the state. Failover is per client, not per session, because the quota is per account.

### 8.3 Reshaping frontier-shaped bodies

Claude Code: swap `model`, apply §6.2. DeepSeek maps Claude model names itself, so even an unswapped body would land on Flash; the swap is for clarity and for the `message_start.model` echo, which makes `/usage` attribute the turn to DeepSeek.

Codex: swap `model`, apply §6.1. Bodies built for `use_responses_lite` models (GPT‑6 Astra) additionally get the `additional_tools` developer item lifted into `tools` and `namespace` tools flattened (`liftResponsesLite`); the base-instructions developer message stays in the input, which the fallback model reads as context. Failover for plain-function-tool models (gpt‑5.5, gpt‑5.6 family) is verified against mocks; the GPT‑6 Astra reshaping is best effort until validated live.

### 8.4 What the user sees

Codex keeps the session's GPT label because it was never told. Claude Code's `/usage` shows DeepSeek in "Usage by model" from the response echo; the model name in the status line stays as picked. Both clients show the switchboard's notice in its status page and log. A user who wants the label to match switches the picker to DeepSeek by hand, which works from phase 1.

## 9. Prefix cache strategy

DeepSeek caches by exact prefix units: a request hits only where its leading tokens fully match a persisted unit. Units persist at request boundaries and at fixed token intervals inside long inputs, common prefixes across requests are persisted independently, and idle entries expire after hours to days. Hits cost about 2% of misses (Flash: $0.003 vs $0.15 per million input tokens off-peak). Usage reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.

Both clients already send cache-shaped requests: a fixed system prompt or `instructions`, a fixed tool list, then the conversation appended turn by turn. The switchboard's job is to not break that, and to arrange the fleet so agents share prefixes:

1. **Never rewrite the prefix.** Adapters delete fields, always the same fields, and never reorder `system`, `instructions`, `tools`, or history. Deletions are byte-identical across requests.
2. **One base prompt per client for every DeepSeek role.** Codex roles share the catalog's `base_instructions`; role-specific `developer_instructions` arrive later as a developer message. Claude Code subagents share Claude Code's system prompt; the agent's own prompt is appended after it. Ten explorers therefore share the same multi-kilobyte prefix and hit the cache from the second agent on.
3. **Volatile bytes never reach DeepSeek.** `prompt_cache_key`, `session_id`, `x-codex-*`, `x-claude-code-*`, `anthropic-beta` are stripped. Claude Code's attribution block is stable per conversation since 2.1.181, so it is left in place (moving it would defeat Anthropic's positional strip on the Claude path).
4. **Forks inherit the parent's cache.** A child spawned with `fork_turns` from a DeepSeek parent replays a prefix DeepSeek already holds. From a frontier parent only the instructions prefix is shared, which is still most of a short exploration.
5. **Compaction is the one legitimate miss.** Both clients rewrite history when they compact; the switchboard counts those as expected rebuilds, the same way Claude Code's own `/usage` cache line does.
6. **Keep the catalog small and still.** Codex renders the available model list into the `spawn_agent` tool description, which sits in every request's prefix. The switchboard injects two entries and never varies them at runtime; adding models is a release, not a setting. DeepSeek's own harness refuses to render its catalog into tool schemas for the same reason.
7. **Replay reasoning exactly.** Reasoning text DeepSeek returned is sent back byte-identical on every later request, on both dialects. It sits at a fixed position, so it costs one miss when it first appears and hits forever after.
8. **Measure per role.** Hit ratio per client, model and role is on the status page. Below 60% on explorer traffic is a bug to investigate: the usual causes are a role file changing the base prompt, tool definitions changing between requests, or aggressive context editing.

These rules are the ones DeepSeek applies in its own harness, where every model-visible addition must document its "KV cache effect" and anything volatile goes into a tail message that is re-emitted only when it changes. The reference notes are in `docs/research/deepseek-harness-learnings.md`.

Under the forced-v1 models list, GPT‑6 Astra's `ultra` effort is effort-only for the parent: its automatic task delegation is a v2 behaviour, so delegation rests on the policy block in §10.3, which is the intended design.

Cache hygiene the installer applies only if the keys are absent: keep default compaction thresholds; for Claude Code leave `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` unset (the extra fields are ignored by DeepSeek and needed by Claude); for Codex leave `context_management.experimental_mode` at its current value but warn if it is on, since it rewrites history more often.

## 10. Client configuration

All edits are marker-guarded, idempotent, and preceded by a timestamped backup under `~/.agents-switchboard/backups/`. The installer refuses to coexist with settings that would redirect or mask the provider, reports them, and stops rather than editing around them: for Codex `profile`, `oss_provider`, a `model_provider` other than `openai`, a different `openai_base_url`, or `model_catalog_json`; for Claude Code `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, a different `ANTHROPIC_BASE_URL`, or any `CLAUDE_CODE_USE_*` provider flag (each would switch billing off the subscription or bypass the switchboard). Reinstall preserves the existing `access_token`; the token is never passed in native-client argv during verification.

### 10.1 Codex: `~/.codex/config.toml`

```toml
# >>> agents-switchboard >>>
openai_base_url = "http://127.0.0.1:4141/_switchboard/<token>/backend-api/codex"

[agents]
default_subagent_model = "deepseek-flash"
default_subagent_reasoning_effort = "high"
max_concurrent_threads_per_session = 8

[features]
multi_agent_v2 = false
# <<< agents-switchboard <<<
```

The installer brings the router up and proves a real turn per client through it before any client config is edited (§11); an earlier install that skipped this left Claude Code pointed at a dead port.

The installer does not write this as one literal block: TOML puts a top-level key after any table header inside that table, and a second `[features]` header is an error. It inserts `openai_base_url` on its own marker-guarded line before the first table header, merges the `[agents]` and `[features]` keys into existing tables when present, and appends the tables inside the block otherwise. The parsed result is exactly the above. A managed key already present with a different value is reported as a conflict, not overwritten.

`multi_agent_v2 = false` alone does not keep Codex on v1. The flag only forces v2 on; with it off, Codex takes the version from the parent model's catalog entry (`multi_agent_version_for_model` in `core/src/config/mod.rs`), and GPT‑6 Astra's entry says v2. Under v2 the parent's `spawn_agent` arguments come back from the OpenAI backend encrypted (`encrypted_function_args`), and the child receives an `agent_message` whose payload is an `encrypted_content` block only that backend can read. Observed live: a DeepSeek explorer answered that its task contained no question. The router therefore serves every upstream entry that declares `multi_agent_version: "v2"` as `"v1"` in the merged models list (§5.1). Under v1 the task travels in plaintext, and the adapter turns `agent_message` items into ordinary user messages, since no other provider knows that item type. The config flag stays as a belt-and-braces guard against enabling v2 by hand.

Role files in `~/.codex/agents/`, named after the built-in roles so they replace them:

```toml
# explorer.toml
name = "explorer"
description = "Fast, read-only codebase exploration on DeepSeek Flash: find files, trace call paths, summarise modules, answer questions about existing code. Several explorers can run in parallel on independent questions."
model = "deepseek-flash"
model_reasoning_effort = "high"
developer_instructions = """
You are an explorer. Answer the parent's question about the codebase with file paths and line references. Read as much as you need; report only what the parent needs: a direct answer first, then the evidence, at most a screenful. Do not modify files. Do not speculate beyond what you read. Other explorers may be answering other questions in parallel; stay on yours.
"""
```

```toml
# worker.toml
name = "worker"
description = "Implementation on DeepSeek Flash for bounded, fully specified changes: a function, a test, a migration, a refactor within one module. Assign it ownership of specific files; other agents may edit the same tree in parallel, so it never reverts or reformats code it did not write, and it reports the files it touched."
model = "deepseek-flash"
model_reasoning_effort = "high"
developer_instructions = """
You are a worker. Implement exactly the task the parent specified, run the relevant tests, and report a short diff summary, the files you touched and the test result, at most a screenful; include failing output verbatim only for the failures. You own only the files the parent assigned to you. Other agents may be editing the same tree in parallel: never revert, reformat or clean up code you did not write, even if it looks wrong. If the task is under-specified or you are blocked, stop and say what you need instead of guessing.
"""
```

```toml
# reviewer.toml
name = "reviewer"
description = "Independent review on DeepSeek Flash: check a diff for bugs, missing tests and spec mismatches before the parent accepts it."
model = "deepseek-flash"
model_reasoning_effort = "high"
developer_instructions = """
You are a reviewer. Read the diff and the surrounding code, run the tests if they exist. Report concrete defects with file and line, ranked by severity, each with a one-line fix suggestion. Do not restate the diff. Say clearly when you find nothing.
"""
```

```toml
# senior.toml
name = "senior"
description = "Escalation on a frontier GPT model. Use only after a Flash worker failed twice, or for cross-module design work."
model = "gpt-5.5"
model_reasoning_effort = "high"
developer_instructions = """
You are the senior engineer. You receive tasks a faster model could not complete. The failed attempt's report should be in your brief; if it is missing, say what you need instead of repeating work that already failed. Solve the task end to end and run the tests. Report what you changed, the files you touched, how you verified it, and what remains, at most a screenful.
"""
```

`senior` needs an explicit model because `default_subagent_model` is applied before the role file. `switchboard roles --pro` moves `reviewer` and `senior` to `deepseek-v4-pro` for an all-DeepSeek fleet.

Codex applies a fixed whitelist of role fields (model, reasoning effort and summary, verbosity, personality, service tier, feature-disables, skills). A role file cannot restrict a child's sandbox, so the files carry no `sandbox_mode`: read-only behaviour rests on the `developer_instructions`, and Codex's own explorer role is read-only by convention only. The worker and explorer texts carry the coordination rules Codex's built-in role descriptions had: a worker owns the files it is assigned, never reverts or reformats code it did not write, and reports the files it touched; explorers run in parallel on independent questions.

### 10.2 Claude Code: `~/.claude/settings.json`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141/_switchboard/<token>/anthropic",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-flash[1m]",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "deepseek-flash[1m]",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "DeepSeek Flash",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "DeepSeek V4.1 Flash · 1M context · via switchboard",
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT": "1"
  },
  "modelSettings": {
    "deepseek-flash": { "effortLevel": "high" }
  }
}
```

The `[1m]` suffix tells Claude Code the real context window; without it an unrecognised id is assumed to have 200K and auto-compaction fires early. The router strips the suffix before DeepSeek sees it. `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` makes Claude Code send `output_config.effort` for a model id it does not recognise, so the session's effort level and ultracode's `xhigh` reach DeepSeek (the adapter maps them onto `low | high | max`). The `modelSettings` field is `effortLevel`, merged into any entry the user already has for that id, so a level saved with `/effort` is restored on uninstall. Existing keys are merged, not replaced. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is detected and warned about, not set: it would collapse every role, including `senior`'s `inherit`, onto the subagent model, and the Explore/Plan files already cover the built-ins. The desktop app, the CLI and the IDE extensions all read this file.

Role files in `~/.claude/agents/`:

```markdown
---
name: explorer
description: Fast, read-only codebase exploration on DeepSeek Flash. Use for finding files, tracing call paths, summarising modules, answering questions about existing code. Several explorers can run in parallel on independent questions.
model: deepseek-flash[1m]
tools: Read, Grep, Glob, Bash
effort: high
---
You are an explorer. Answer the parent's question about the codebase with file paths and line references. Read as much as you need; report only what the parent needs: a direct answer first, then the evidence, at most a screenful. Do not modify files. Do not speculate beyond what you read. Other explorers may be answering other questions in parallel; stay on yours.
```

`worker` (model `deepseek-flash[1m]`, all tools, `effort: high`), `reviewer` (read-only tools, `effort: high`) and `senior` (model `inherit`, so it runs on whatever frontier model the session uses) follow the same pattern with the instructions from §10.1. Claude Code's built-in `Explore` and `Plan` agents do not follow `CLAUDE_CODE_SUBAGENT_MODEL`: they inherit the main model. A user agent with the same name replaces the built-in and keeps its own model, so the installer also writes `Explore.md` and `Plan.md` (both `effort: high`) on Flash. Claude reaches for Explore on its own many times per session, which makes this the largest single saving on the Claude side. The frontmatter `effort` flows through the Messages adapter onto DeepSeek's `low | high | max` ladder.

### 10.3 Delegation policy

The same marked block is appended to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. It is the only orchestration machinery: no scheduler, no router-side routing by task. The policy pushes reading, running and reviewing into Flash subagents, whose context never enters the frontier session, which is where the subscription budget actually goes. Role instructions ask for a screenful back, so a subagent's work returns as a summary rather than as raw output.

```markdown
<!-- agents-switchboard delegation policy -->
## Delegation

Subagents run on DeepSeek Flash: 1M context, roughly 50x cheaper than this session, and their context never enters yours. Every file you read, test you run, or log you scan in this session spends the expensive budget; done in a subagent it costs cents and returns a summary. Delegate by default, keep judgement here.

- explorer: anything that means reading before deciding: where is X, how does Y work, what does this test output mean, what changed in this diff. Give one precise question per explorer and spawn several in parallel. Trust their file:line references; verify only what you change.
- Keep the critical path here: if your very next action is blocked on the answer, read it yourself, then delegate the sidecar reading that can run while you work. Send a blocking question to Flash only when the answer replaces a large amount of reading you would otherwise do yourself.
- Reuse before you respawn: for a related question about code an explorer or worker already read, continue that agent (Codex send_input or followup_task, Claude Code resuming the subagent) instead of spawning a new one; its context is already paid for. Respawn only when the question needs a clean read.
- worker: implementation that fits in one message: exact files, exact behaviour, how to verify. Give it ownership of specific files; it runs the tests and reports the diff summary, the files it touched and the results. Split larger work into worker-sized pieces first.
- reviewer: every non-trivial diff before you accept it, and before you tell the user it is done. Give it the base ref or commit to diff against and what "done" means; it starts with no history of this session.
- senior: only after a worker failed twice on the same task, or for a decision that spans modules. Pass the failed attempt's report so it does not start from zero.

Brief each subagent with the goal, the exact files or commands, and the shape of answer you want. Ask for at most a screenful back. Never paste large outputs into this session; ask an explorer to summarise them.

Do not delegate: choosing an approach, resolving ambiguity with the user, anything that depends on screenshots or images unless you describe them in text first.
<!-- /agents-switchboard -->
```

## 11. CLI and installer

`npx agents-switchboard <command>`. No global install required.

| Command | Effect |
|---|---|
| `install [--codex] [--claude] [--port N] [--pro] [--openrouter-key K] [--dry-run]` | Detects installed clients (default: both present ones). Asks for the DeepSeek key once (and optionally an OpenRouter key) and stores them in the keychain. Probes each provider on both dialects. Pre-flights both clients' configs and stops with nothing changed on a conflict or a corrupt file. Registers and starts the login service, waits for `/switchboard/health`, completes a real turn per client through the router using only an override, and only then backs up and edits each client's config, writes role files and the delegation block, and runs `doctor`. Exit code reflects the install; failed connectivity probes are reported but do not fail it. `--dry-run` previews config, role-file and delegation-block outcomes without writing. Idempotent. |
| `doctor` | Service running; port bound; each client's base URL correct; subscription auth present per client; upstreams reachable; DeepSeek key valid on both dialects; Codex `/models` served with DeepSeek entries; client versions within the supported ranges. Exit code reflects health. |
| `test` | Codex: `codex exec` spawns an explorer; verifies from the switchboard log that a `deepseek-flash` request reached DeepSeek and from `~/.codex/state_*.sqlite` that the child recorded `model = deepseek-flash`. Claude Code: `claude -p` runs a prompt that invokes the explorer subagent; verifies a request with `x-claude-code-agent-id` and model `deepseek-flash` reached DeepSeek. Prints the evidence. |
| `status` | Routes, failover state per client, per-model tokens, cache hit ratio per role, estimated spend today. |
| `logs` | Tails the request log. |
| `roles [--pro]` | Rewrites role files for both clients. |
| `failover on\|off\|reset` | Toggles or clears failover state. |
| `serve` | Runs the router in the foreground. What the service runs. |
| `uninstall [--purge]` | Restores each client's config (a config the installer never marked is left byte-identical), removes role files and delegation blocks, then stops and removes the service. `--purge` also deletes every provider's keychain entry and the switchboard home. |

Login service: `launchd` user agent on macOS (`~/Library/LaunchAgents/dev.agents-switchboard.plist`), `systemd --user` unit on Linux, Scheduled Task at logon on Windows. `KeepAlive`, logs to `~/.agents-switchboard/switchboard.log` with size rotation.

Secrets: macOS Keychain via `security`, Linux Secret Service via `secret-tool` when present, Windows PasswordVault via PowerShell. Without a keychain, the installer writes `api_key = { env = "DEEPSEEK_API_KEY" }` (or the OpenRouter equivalent) into the switchboard config and puts the key into the service definition's environment: the plist's `EnvironmentVariables`, the unit's `Environment=`, or on Windows a user-only `service.env.cmd` sourced by the task's wrapper. The definition files are user-only. Provider keys never appear in client config, role files, logs, `install` output, or `test` output. The local `access_token` is not a provider key; it appears only in protected local base URLs and is stripped before logging or upstream forwarding.

Switchboard config, `~/.agents-switchboard/config.toml`:

```toml
listen = "127.0.0.1:4141"

[upstream.openai]
base_url = "https://chatgpt.com/backend-api/codex"

[upstream.anthropic]
base_url = "https://api.anthropic.com"

[upstream.deepseek]
base_url = "https://api.deepseek.com"
api_key = { keychain = "agents-switchboard/deepseek" }   # or { env = "DEEPSEEK_API_KEY" }
models = ["deepseek-flash", "deepseek-v4-pro"]

[upstream.openrouter]
base_url = "https://openrouter.ai/api"
api_key = { keychain = "agents-switchboard/openrouter" }   # or { env = "OPENROUTER_API_KEY" }; optional
models = ["deepseek/deepseek-v4.1-flash", "qwen/qwen3-coder"]  # advertised in the Codex picker; any vendor/model id routes regardless

[upstream.openrouter.model_overrides."qwen/qwen3-coder"]
context_window = 262144

[upstream.openrouter.provider]            # merged over { require_parameters = true, allow_fallbacks = true }
sort = "throughput"                       # or omit to keep OpenRouter's price-weighted balancing and sticky routing
data_collection = "deny"

[failover]
enabled = true
model = "deepseek-flash"
```

`install` asks for the OpenRouter key as an optional second prompt (`--openrouter-key`, or `OPENROUTER_API_KEY`) and probes it on both dialects. To run subagents on an OpenRouter model instead of DeepSeek direct, set `agents.default_subagent_model` and `CLAUDE_CODE_SUBAGENT_MODEL` to its id, or point a single role file at it.

## 12. Observability

- `GET /switchboard/status`: version, uptime, listen address, per-upstream health (last success, last error), failover state per client, per-model counters (requests, input tokens, cache-hit tokens, output tokens, estimated USD from bundled off-peak and peak rates and the current UTC time), cache hit ratio per role, keyed by `x-openai-subagent` and `x-claude-code-agent-id`.
- `GET /switchboard/`: the same as one HTML page.
- Request log: one JSON line per request with timestamp, client, route, model, upstream, status, duration, tokens, cache hits, role. No bodies, no headers, no tokens.

## 13. Security and privacy

- Binds to `127.0.0.1` only. Any other address requires `--allow-remote`, which the installer never sets.
- Every vendor route, pass-through or provider, requires the protected local capability URL. Every pass-through route also requires the client's own `Authorization` or `x-api-key` header, so a stray local process can neither reach ChatGPT or Anthropic anonymously through the router nor spend the stored DeepSeek or OpenRouter key. Tokens are not validated locally; the upstream does that. Bodies above 32 MB are answered with 413. A client that disconnects mid-stream takes the vendor connection down with it.
- The ChatGPT token goes only to `chatgpt.com`, the Anthropic OAuth token only to `api.anthropic.com`, the DeepSeek key only to `api.deepseek.com`. Hosts are pinned in code and overridable only in the switchboard's own config file, created with user-only permissions.
- Bodies are streamed, never stored. Logs hold metadata only.
- Router-owned local auth failures and missing or rejected provider keys are reported as HTTP 400 with explanatory messages. Both clients treat local 401s as expired subscription logins, but real upstream subscription 401s stay transparent so native login refresh still works.
- This is a local transparent proxy under your own credentials, the same shape as the LLM gateways both vendors document. It is not credential sharing. Either vendor could still restrict the pattern; `doctor` detects the failure modes (rejected `version` header, rejected base URL, 401 on OAuth) and says so plainly.

## 14. Compatibility

- Supported ranges are declared in `package.json` and checked by `doctor`. Phase 1 targets Codex 0.150–0.155 and Claude Code 2.1.181 or later (stable attribution block).
- The upstream contracts the design depends on, each with a test that fails loudly if it changes: Codex `openai_base_url` ending in `/backend-api/codex` keeps ChatGPT auth and serves `/models`; Claude Code `ANTHROPIC_BASE_URL` without a credential variable keeps OAuth; Claude Code accepts arbitrary ids in `CLAUDE_CODE_SUBAGENT_MODEL`, frontmatter `model:`, and `ANTHROPIC_CUSTOM_MODEL_OPTION`; Codex role files cannot change providers (if they can again, the switchboard is still correct and the README should say a simpler path exists for Codex).
- DeepSeek drift: `doctor` probes `/responses` and `/anthropic/v1/messages` with minimal streamed requests per advertised model.
- Both desktop apps read the same config files as their CLIs. Each must be restarted once after `install` to reload config and refetch models.

## 15. Testing

- Unit: route table; both request rewrites against fixtures captured from gpt‑5.5, gpt‑6‑astra, deepseek-shaped Codex requests and from Claude Code main and subagent requests; catalog merge and ETag; failover state machine; error mapping; usage normalisation; thinking-block stripping.
- Integration: mock OpenAI, Anthropic and DeepSeek upstreams with recorded SSE fixtures. Byte equality on pass-through paths; exact bodies on DeepSeek paths; ping insertion during silence; failover on mocked 429s.
- End to end (`switchboard test`): real clients, real DeepSeek. Evidence from the log and the clients' own state, never from the model's claims.
- Manual desktop checklist per release, both apps: DeepSeek visible in picker; switch main model to DeepSeek mid-session; spawn explorer, worker, reviewer from a frontier parent; agent panel shows name, role, model; streaming text and diffs render; usage meter unchanged after DeepSeek turns; `/usage` in Claude Code shows DeepSeek rows and a cache line; failover engages on a real limit and the turn completes.

## 16. Roadmap

| Phase | Delivers |
|---|---|
| 1 | Router with both pass-throughs, both DeepSeek adapters, Codex catalog injection, WebSocket decline, ping insurance, installer for both clients, roles, delegation policy, doctor, test, status. DeepSeek subagents everywhere; DeepSeek as main model by picker. |
| 2 | Done: quota failover for both clients, provider-reported cost, cache ratios per role. Open: captured real 429 fixtures; local compaction shim for DeepSeek main sessions in Codex, built as a prefix extension of the last request so the summary call is mostly cache hits, the way DeepSeek's harness does it. |
| 3 | WebSocket splice for GPT traffic. Responses-lite reshaping for GPT‑6 Astra failover. Codex multi-agent v2 verification. |
| 4 | Any Responses- or Messages-compatible upstream as a subagent provider; per-role cost budgets. |

## 17. Risks and open questions

- Either vendor may restrict base-URL overrides with subscription auth. Mitigation: `doctor` detection, an honest README, no silent workaround.
- Codex `force_http_fallback` after a declined upgrade was read from source; observed 2026-09-14 that Codex retries the upgrade once per thread spawn and the HTTP fallback works, so the 426 lines are expected noise until phase 3 splices GPT sockets through.
- The subscription 429 shape for Claude Code is undocumented; failover for Claude ships only after a captured fixture.
- DeepSeek's Responses API documents `deepseek-flash` only; V4 Pro is probed, not assumed.
- Codex compaction for a DeepSeek main session calls the OpenAI backend and spends GPT quota until the phase 2 shim exists. Claude Code compaction is a normal `/v1/messages` call and already lands on DeepSeek.
- DeepSeek's Anthropic endpoint does not document whether it echoes `cache_read_input_tokens`; §6.2 normalises either way.
- Windows service and keychain paths are specified and verified last.

## Appendix A. Evidence in openai/codex @ 2f8603f

| Claim | Location |
|---|---|
| Role override whitelist | `codex-rs/core/src/agent/role.rs`, `struct AgentRoleOverrides`, `apply_role_to_config_inner` |
| Provider inheritance enforced | PR #39299, merged 2026‑08‑18 |
| Default subagent model resolution | `codex-rs/core/src/tools/handlers/multi_agents_common.rs`: `apply_requested_spawn_agent_model_overrides`, `find_spawn_agent_model_name`, `model_supports_multi_agent_backend` |
| `openai_base_url` feeds the built-in provider | `codex-rs/core/src/config/mod.rs` ≈ L3678; `codex-rs/model-provider-info/src/lib.rs` `create_openai_provider` |
| Codex backend routes need the `/backend-api/codex` suffix | `codex-rs/model-provider-info/src/lib.rs` `supports_codex_backend_routes`, `is_openai` (matches by provider name) |
| ChatGPT auth attached only then | `codex-rs/core/src/client.rs` `uses_codex_backend` |
| `/models?client_version=` and ETag cache | `codex-rs/model-provider/src/models_endpoint.rs`, `codex-rs/models-manager/src/cache.rs` |
| WebSocket fallback | `codex-rs/core/src/client.rs` `responses_websocket_enabled`, `force_http_fallback` |
| Usage-limit error shape and headers | `codex-rs/codex-api/src/api_bridge.rs` ≈ L133 |
| Responses-lite tool folding | `codex-rs/core/src/client.rs` ≈ L805; `codex-rs/tools/src/tool_spec.rs` `create_tools_json_for_responses_lite` |
| Encrypted reasoning always requested | `codex-rs/core/src/client.rs` ≈ L862 |
| Turn-state header is OpenAI sticky routing | `codex-rs/core/src/client.rs` module docs |

## Appendix B. Evidence in Claude Code docs (2.1.270)

| Claim | Page |
|---|---|
| `ANTHROPIC_BASE_URL` without a credential keeps the claude.ai login and its billing | gateways.md, llm-gateway-protocol.md |
| OAuth capability rides in `anthropic-beta`; forward verbatim | llm-gateway-protocol.md |
| Paths: `/v1/messages?beta=true`, `/v1/messages/count_tokens`, `HEAD /api/hello`; fast-mode and WebFetch checks bypass the gateway | llm-gateway-protocol.md |
| Attribution block stable per conversation since 2.1.181 | llm-gateway-protocol.md |
| Byte watchdog aborts a stream silent for 300 s; forward pings | llm-gateway-protocol.md |
| Retry on rejected thinking signature without earlier thinking blocks; forward error bodies unmodified | llm-gateway-protocol.md |
| Model discovery skipped with claude.ai login only; ids must contain `claude` or `anthropic` | llm-gateway-protocol.md |
| `ANTHROPIC_CUSTOM_MODEL_OPTION[_NAME|_DESCRIPTION]`, unvalidated | model-config.md |
| `CLAUDE_CODE_SUBAGENT_MODEL` and frontmatter `model:` accept full model names | model-config.md, sub-agents.md |
| `fallbackModel` does not trigger on rate-limit errors | model-config.md |
| `/usage` cache line reads cache token fields from any provider | costs.md |
| Desktop, CLI and IDE share `~/.claude/settings.json` | desktop.md, settings.md |
| `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id` headers | llm-gateway-protocol.md |

## Appendix C. DeepSeek API notes

- Base URL `https://api.deepseek.com`. Responses API at `/responses`; Anthropic-compatible API at `/anthropic/v1/messages`. SSE streaming on both.
- Models: `deepseek-flash` (V4.1 Flash: 1M context, 384K max output, vision), `deepseek-v4-pro` (text only). Legacy `deepseek-v4-flash` still accepted. The Anthropic endpoint maps `claude-opus*` → `deepseek-v4-pro`, `claude-sonnet*`/`claude-haiku*` and unknown names → `deepseek-flash`.
- Responses API: no `previous_response_id`, `store` always false, no encrypted reasoning, `function` tools and `apply_patch` custom tool only, built-in tools ignored, unknown parameters ignored.
- Anthropic API: `thinking` supported (`budget_tokens` ignored), `output_config.effort` supported, `cache_control` and beta headers ignored, `document`/`search_result`/`redacted_thinking` unsupported.
- Pricing per 1M tokens, off-peak / peak: Flash input miss 0.15 / 0.30, hit 0.003 / 0.006, output 0.60 / 1.20. V4 Pro input miss 0.66 / 1.32, hit 0.022 / 0.044, output 1.98 / 3.96. Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays.
- Cache: exact-prefix units, persisted at request boundaries and fixed intervals, shared across requests, expire after hours to days. Usage reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.

## Appendix D. Practices copied from DeepSeek's harness

DeepSeek's own agent harness (`deepseek-ai/deepseek-harness`) is the reference for how DeepSeek wants to be called. The switchboard adopts these, detailed in `docs/research/deepseek-harness-learnings.md`:

- Its Codex integration is a loopback Responses-API shim in front of DeepSeek, and its Claude Code integration points `ANTHROPIC_BASE_URL` at `api.deepseek.com/anthropic`. The switchboard is the same shape, extended to keep the frontier models.
- `thinking` is top-level; "no thinking" is `{type: "disabled"}` with `reasoning_effort` omitted; efforts are `low | high | max`. The Messages adapter's adaptive → enabled rule and the Responses adapter's effort mapping follow this.
- `reasoning_content` and thinking blocks are replayed byte-exactly on every turn.
- Assistant content is never `null`, empty tool output never empty. The adapters preserve whatever the clients send and add the placeholder only where a client would otherwise send nothing.
- Cache accounting reads the OpenAI-compatible cached-token field first and DeepSeek's `prompt_cache_hit_tokens` second, and treats prompt totals as inclusive of hits.
- `Retry-After` is honoured up to a cap; beyond it the request is failed rather than slept. An empty completion is retryable. Streams have a 300 s idle watchdog.
- Nothing volatile enters the prefix; out-of-band data travels in headers (`x-deepseek-harness-*`) or namespaced body fields. The switchboard tags its own auxiliary calls the same way and never touches the prefix.
- Compaction requests are prefix extensions of the last request, so summarising is cheap.
