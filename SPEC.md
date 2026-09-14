# agents-switchboard — Specification

Status: draft v0.3, 2026-09-14. Both base-URL contracts verified live on this machine (§2.1).
Reviewed against: openai/codex `main` @ 2f8603f (CLI 0.154.0, desktop runtime 0.154.0-alpha.6.2); Claude Code 2.1.270 and its gateway protocol docs; DeepSeek API docs (Responses API, Anthropic-compatible API, context caching, pricing) as of 2026-09-14.

## 1. Summary

`agents-switchboard` is a loopback HTTP router that sits between your coding agents and the model backends. Codex and Claude Code keep using their normal subscription logins and believe they are talking to OpenAI and Anthropic. The switchboard forwards those requests unchanged, and sends any request for a DeepSeek model to DeepSeek instead.

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
   http://127.0.0.1:4141/backend-api/codex│ /backend-api/codex/responses               │
 ───────────────────────────────────────▶│     gpt-*      ── pass-through ─────────────┼─▶ chatgpt.com/backend-api/codex/responses
                                         │     deepseek-* ── responses adapter ────────┼─▶ api.deepseek.com/responses
                                         │     other      ── pass-through ─────────────┼─▶ chatgpt.com/backend-api/codex/*
 Claude Code desktop / CLI / IDE         │                                            │
 ANTHROPIC_BASE_URL =                    │ /anthropic/v1/messages                     │
   http://127.0.0.1:4141/anthropic       │     claude-*   ── pass-through ─────────────┼─▶ api.anthropic.com/v1/messages
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

Runtime: Node 22+, no native modules, single npm package `agents-switchboard`, binary `switchboard`. Every Codex and Claude Code user already has npm.

## 4. Routing

### 4.1 Route table

| Client | Request | Upstream | Handling |
|---|---|---|---|
| Codex | `GET /backend-api/codex/models` | OpenAI | Proxy, merge catalog, rewrite ETag (§5.1). |
| Codex | `POST /backend-api/codex/responses`, DeepSeek model | DeepSeek | Responses adapter (§6). |
| Codex | `POST /backend-api/codex/responses`, other model | OpenAI | Pass-through; failover hook (§8). |
| Codex | WebSocket upgrade on `/responses` | none | 426; Codex drops to HTTP for that session (§7). The upgrade carries `x-codex-routing-hint`, so phase 3 can splice GPT sockets through. |
| Codex | anything else under `/backend-api/codex/` | OpenAI | Pass-through: usage, compaction, realtime, connectors, memories. |
| Claude | `POST /anthropic/v1/messages`, DeepSeek model | DeepSeek | Messages adapter (§6). |
| Claude | `POST /anthropic/v1/messages`, other model | Anthropic | Pass-through; failover hook (§8). |
| Claude | `POST /anthropic/v1/messages/count_tokens`, DeepSeek model | local | 404. Claude Code falls back to its character estimate. |
| Claude | `HEAD /anthropic/api/hello` | local | 200. Connection-warming probe. |
| Claude | anything else under `/anthropic/` | Anthropic | Pass-through. |
| any | `/switchboard/*` | local | Status and control. |

A model is DeepSeek-bound when its id, after stripping a Claude-style `[1m]` suffix, appears in the DeepSeek catalog the switchboard serves. For Codex the id comes from the `x-codex-routing-hint` header, so GPT bodies are never decompressed; for Claude Code it comes from the JSON body. The catalog is the single source of truth for both the Codex picker entries and the routing decision, so a model can never be advertised without a route.

### 4.2 Pass-through contract

Pass-through means: method, path, query, every request header, every request byte, every response header, every response byte. The switchboard adds nothing and removes nothing. This is what keeps ChatGPT auth, `chatgpt-account-id`, `session_id`, `originator`, `x-codex-*` sticky routing, `anthropic-beta` with its OAuth capability, `anthropic-version`, `cache_control`, the system-prompt attribution block, rate-limit headers, and every future capability working without the switchboard knowing about them.

### 4.3 DeepSeek-bound headers

Authorization is replaced with the DeepSeek key (`Authorization: Bearer` for the Responses API, `x-api-key` for the Anthropic-compatible API). Client-identifying and backend-specific headers are dropped: `chatgpt-account-id`, `session_id`, `originator`, `x-codex-*`, `x-claude-code-*`, `anthropic-beta`, `anthropic-version`. `x-claude-code-agent-id` and `x-openai-subagent` are read for attribution before being dropped.

## 5. Models in the picker

### 5.1 Codex: catalog injection

Codex fetches `GET {base_url}/models?client_version=…`, caches it in `~/.codex/models_cache.json`, and revalidates by ETag. The picker, the effort menu, per-model tool wiring, base instructions, and the `spawn_agent` model whitelist all derive from that list.

The switchboard proxies the request, appends the bundled DeepSeek entries, and rewrites the ETag to `"<upstream-etag>+sb<catalog-hash>"` so a catalog change invalidates the cache while upstream changes still propagate. No `model_catalog_json` is written: a static catalog would freeze OpenAI's live list.

The bundled entries (`catalog/deepseek.models.json`) are the ones DeepSeek ships in its own Codex setup script (`cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh` v1.3.0), carried verbatim because they encode DeepSeek's tested choices:

| Field | deepseek-flash | Why it matters |
|---|---|---|
| `shell_type` | `shell_command` | Plain function tools. GPT‑6 Astra uses `unified_exec` and `tool_mode = code_mode_only`; DeepSeek needs neither. |
| `apply_patch_tool_type` | `freeform` | DeepSeek's Responses API accepts one custom tool name, `apply_patch`. |
| `use_responses_lite` | `false` | Tools stay in `tools`, not folded into the input. |
| `multi_agent_version` | `v2` | Keeps the slug eligible for `spawn_agent`. |
| `supported_reasoning_levels` | low, high, max | Passed through as `reasoning.effort`. |
| `default_reasoning_summary` | `none` | DeepSeek returns no summaries; the UI does not wait for one. |
| `context_window` | 1,048,576 at 95% | Matches the API. |
| `input_modalities` | text, image | Flash accepts images. V4 Pro is text only. |
| `base_instructions` | 17.7 KB, identical for every role | The shared cache prefix (§9). |
| `prefer_websockets` | `false` | HTTP only. |

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
2. `input`: delete `encrypted_content` from every `reasoning` item; remove items left empty. Relevant when a child is spawned with `fork_turns` from a GPT parent. Reasoning text that DeepSeek itself returned is never touched: DeepSeek recovers a turn's thinking signature by hashing that exact text, and its own harness replays it on every turn for that reason (docs/research/deepseek-harness-learnings.md).
3. `tools`: keep `function` and the `apply_patch` custom tool. Flatten `namespace` wrappers into their members. Remove `web_search`, `image_generation`.
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
7. `output_config.format` (structured output, used by Claude Code's session-title call) is removed with a log line; DeepSeek supports only `effort` there. The title may then fail to parse, which Claude Code tolerates.

Response handling:

- SSE forwarded unchanged (`message_start`, `content_block_*`, `message_delta`, `message_stop`, `ping`).
- Ping insurance: Claude Code aborts a stream silent for 300 s. If DeepSeek sends no bytes for 20 s, the switchboard emits `event: ping` itself.
- Usage normalisation: if the final usage lacks `cache_read_input_tokens` but carries DeepSeek's `prompt_cache_hit_tokens`, the switchboard fills `cache_read_input_tokens` and `cache_creation_input_tokens: 0` so `/usage` shows the prompt-cache line and per-model figures for DeepSeek turns.
- Error bodies forwarded unmodified. Claude Code matches on upstream error wording to decide its own recovery, and wrapping breaks that.

Thinking blocks across providers: Anthropic rejects thinking blocks it did not sign. When a conversation that ran on DeepSeek returns to Claude (failback, or the user switching models), the switchboard strips assistant `thinking` blocks that carry no signature from Anthropic-bound requests. Claude Code would recover on its own after one rejected request; stripping saves that round trip.

## 7. WebSocket policy (Codex)

The built-in OpenAI provider advertises WebSocket support and Codex tries to upgrade `/responses` once per session. The upgrade carries no model, so it cannot be routed. Version 1 declines with 426; Codex calls `force_http_fallback` and continues over HTTP with full request bodies, which is exactly what a stateless backend needs. Cost: a slower first request per session and no incremental appends for GPT traffic, which affects latency, not correctness. Version 3 accepts the upgrade, reads the first `response.create` frame to learn the model, splices GPT sockets through to `wss://chatgpt.com`, and closes DeepSeek sockets with a retryable error so only those sessions drop to HTTP. Claude Code does not use WebSockets.

## 8. Quota failover

### 8.1 Triggers

| Client | Signal |
|---|---|
| Codex | HTTP 429 from ChatGPT with body `error.type = "usage_limit_reached"`, plus `x-codex-primary-used-percent`, `x-codex-primary-reset-at`, `x-codex-rate-limit-reached-type` headers (`codex-api/src/api_bridge.rs`). |
| Claude Code | HTTP 429 from Anthropic with `error.type = "rate_limit_error"` and the subscription's unified-limit signal (`anthropic-ratelimit-unified-status: rejected` header, or a message naming a session, weekly, or model limit). The documented `retry-after`-style per-minute limits are not a trigger: they are transient and both clients retry them. |

The exact Claude 429 for subscriptions is not in public docs. Phase 2 captures one and pins it as a fixture before failover ships for Claude Code.

### 8.2 Behaviour

With `failover.enabled = true`, on a trigger the switchboard:

1. records `exhausted_until` per client from the reset header (`x-codex-primary-reset-at`, `anthropic-ratelimit-unified-reset`), else `error.resets_at`, else `retry-after`, else now + 5 min;
2. rewrites the request for the fallback model (§8.3) and sends it to DeepSeek;
3. streams the DeepSeek response back, so the turn completes;
4. logs one line and flips the status page to "failover active for <client> until <time>".

While `exhausted_until` is in the future, that client's frontier-bound requests go straight to the fallback. After it passes, the next request tries the frontier upstream again. `switchboard failover reset` clears the state. Failover is per client, not per session, because the quota is per account.

### 8.3 Reshaping frontier-shaped bodies

Claude Code: swap `model`, apply §6.2. DeepSeek maps Claude model names itself, so even an unswapped body would land on Flash; the swap is for clarity and for the `message_start.model` echo, which makes `/usage` attribute the turn to DeepSeek.

Codex: swap `model`, apply §6.1. Bodies built for `use_responses_lite` models (GPT‑6 Astra) additionally need the `additional_tools` developer item lifted into `tools`, the base-instructions developer message lifted into `instructions`, and `namespace` tools flattened. Phase 2 ships Codex failover for plain-function-tool models (gpt‑5.5, gpt‑5.6 family); phase 3 adds the responses-lite conversion and validates it against GPT‑6 Astra.

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

Cache hygiene the installer applies only if the keys are absent: keep default compaction thresholds; for Claude Code leave `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` unset (the extra fields are ignored by DeepSeek and needed by Claude); for Codex leave `context_management.experimental_mode` at its current value but warn if it is on, since it rewrites history more often.

## 10. Client configuration

All edits are marker-guarded, idempotent, and preceded by a timestamped backup under `~/.agents-switchboard/backups/`. The installer refuses to coexist with settings that would redirect or mask the provider, reports them, and stops rather than editing around them: for Codex `profile`, `oss_provider`, a `model_provider` other than `openai`, a different `openai_base_url`, or `model_catalog_json`; for Claude Code `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, a different `ANTHROPIC_BASE_URL`, or any `CLAUDE_CODE_USE_*` provider flag (each would switch billing off the subscription or bypass the switchboard).

### 10.1 Codex: `~/.codex/config.toml`

```toml
# >>> agents-switchboard >>>
openai_base_url = "http://127.0.0.1:4141/backend-api/codex"

[agents]
default_subagent_model = "deepseek-flash"
default_subagent_reasoning_effort = "high"
max_concurrent_threads_per_session = 8

[features]
multi_agent_v2 = false
# <<< agents-switchboard <<<
```

`multi_agent_v2` stays off in phase 1: v2 leans on server-side turn state and incremental appends that only the OpenAI backend implements, while v1 sends complete histories. Re-enabling is a phase 3 verification item.

Role files in `~/.codex/agents/`, named after the built-in roles so they replace them:

```toml
# explorer.toml
name = "explorer"
description = "Fast, read-only codebase exploration on DeepSeek Flash: find files, trace call paths, summarise modules, answer questions about existing code."
model = "deepseek-flash"
model_reasoning_effort = "low"
sandbox_mode = "read-only"
developer_instructions = """
You are an explorer. Answer the parent's question about the codebase with file paths and line references. Do not modify files. Do not speculate beyond what you read. Be brief.
"""
```

```toml
# worker.toml
name = "worker"
description = "Implementation on DeepSeek Flash for bounded, fully specified changes: a function, a test, a migration, a refactor within one module."
model = "deepseek-flash"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
You are a worker. Implement exactly the task the parent specified, run the relevant tests, and report the diff summary and test output. If the task is under-specified or you are blocked, stop and say what you need instead of guessing.
"""
```

```toml
# reviewer.toml
name = "reviewer"
description = "Independent review on DeepSeek Flash: check a diff for bugs, missing tests and spec mismatches before the parent accepts it."
model = "deepseek-flash"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
You are a reviewer. Read the diff and the surrounding code. Report concrete defects with file and line, ranked by severity. Do not restate the diff. Say clearly when you find nothing.
"""
```

```toml
# senior.toml
name = "senior"
description = "Escalation on a frontier GPT model. Use only after a Flash worker failed twice, or for cross-module design work."
model = "gpt-5.5"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
You are the senior engineer. You receive tasks a faster model could not complete. Read the previous attempt's report first, then solve the task end to end.
"""
```

`senior` needs an explicit model because `default_subagent_model` is applied before the role file. `switchboard roles --pro` moves `reviewer` and `senior` to `deepseek-v4-pro` for an all-DeepSeek fleet.

### 10.2 Claude Code: `~/.claude/settings.json`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141/anthropic",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-flash",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "deepseek-flash",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "DeepSeek Flash",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "DeepSeek V4.1 Flash · 1M context · via switchboard"
  },
  "modelSettings": {
    "deepseek-flash": { "effort": "high" }
  }
}
```

Existing keys are merged, not replaced. The desktop app, the CLI and the IDE extensions all read this file.

Role files in `~/.claude/agents/`:

```markdown
---
name: explorer
description: Fast, read-only codebase exploration on DeepSeek Flash. Use for finding files, tracing call paths, summarising modules, answering questions about existing code.
model: deepseek-flash
tools: Read, Grep, Glob, Bash
---
You are an explorer. Answer the parent's question about the codebase with file paths and line references. Do not modify files. Do not speculate beyond what you read. Be brief.
```

`worker` (model `deepseek-flash`, all tools), `reviewer` (model `deepseek-flash`, read-only tools) and `senior` (model `inherit`, so it runs on whatever frontier model the session uses) follow the same pattern with the instructions from §10.1. The built-in `Explore` and `Plan` agents already follow `CLAUDE_CODE_SUBAGENT_MODEL`, so they run on Flash without a file.

### 10.3 Delegation policy

The same marked block is appended to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`, so the parent model delegates by estimated capability rather than by habit:

```markdown
<!-- agents-switchboard delegation policy -->
## Delegation

Subagents run on DeepSeek Flash by default: fast, 1M context, roughly 50x cheaper than this session's model. Use them freely for bounded work; keep judgement here.

- explorer: any question about existing code. Spawn several in parallel for independent questions. Trust their file references; verify only what you change.
- worker: implementation that fits in one message: exact files, exact behaviour, how to test. Split larger tasks first.
- reviewer: every non-trivial diff before you accept it.
- senior: only after a worker failed twice on the same task, or for cross-module design decisions. Pass the failed attempt's report.

Do not delegate: choosing an approach, resolving ambiguity with the user, anything that depends on screenshots or images unless you describe them in text first.
<!-- /agents-switchboard -->
```

## 11. CLI and installer

`npx agents-switchboard <command>`. No global install required.

| Command | Effect |
|---|---|
| `install [--codex] [--claude] [--port N]` | Detects installed clients (default: both present ones). Asks for the DeepSeek key once and stores it in the keychain. Probes DeepSeek on both dialects. Backs up and edits each client's config, writes role files and the delegation block, registers the login service, starts it, runs `doctor`. Idempotent. |
| `doctor` | Service running; port bound; each client's base URL correct; subscription auth present per client; upstreams reachable; DeepSeek key valid on both dialects; Codex `/models` served with DeepSeek entries; client versions within the supported ranges. Exit code reflects health. |
| `test` | Codex: `codex exec` spawns an explorer; verifies from the switchboard log that a `deepseek-flash` request reached DeepSeek and from `~/.codex/state_*.sqlite` that the child recorded `model = deepseek-flash`. Claude Code: `claude -p` runs a prompt that invokes the explorer subagent; verifies a request with `x-claude-code-agent-id` and model `deepseek-flash` reached DeepSeek. Prints the evidence. |
| `status` | Routes, failover state per client, per-model tokens, cache hit ratio per role, estimated spend today. |
| `logs` | Tails the request log. |
| `roles [--pro] [--reset]` | Rewrites role files for both clients. |
| `failover on\|off\|reset` | Toggles or clears failover state. |
| `serve` | Runs the router in the foreground. What the service runs. |
| `uninstall [--purge]` | Stops and removes the service, restores each client's config from the backup it made, removes role files and delegation blocks. `--purge` also deletes the keychain entry. |

Login service: `launchd` user agent on macOS (`~/Library/LaunchAgents/dev.agents-switchboard.plist`), `systemd --user` unit on Linux, Scheduled Task at logon on Windows. `KeepAlive`, logs to `~/.agents-switchboard/switchboard.log` with size rotation.

Secrets: macOS Keychain via `security`, Linux Secret Service via `secret-tool` when present, Windows Credential Manager via `cmdkey`. Without a keychain, the installer falls back to an env var in the service definition and says so. The key never appears in client config, role files, logs, or `test` output.

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

[failover]
enabled = true
model = "deepseek-flash"
```

## 12. Observability

- `GET /switchboard/status`: version, uptime, listen address, per-upstream health (last success, last error), failover state per client, per-model counters (requests, input tokens, cache-hit tokens, output tokens, estimated USD from bundled off-peak and peak rates and the current UTC time), cache hit ratio per role, keyed by `x-openai-subagent` and `x-claude-code-agent-id`.
- `GET /switchboard/`: the same as one HTML page.
- Request log: one JSON line per request with timestamp, client, route, model, upstream, status, duration, tokens, cache hits, role. No bodies, no headers, no tokens.

## 13. Security and privacy

- Binds to `127.0.0.1` only. Any other address requires `--allow-remote`, which the installer never sets.
- Requests without `Authorization` or `x-api-key` on a pass-through route are rejected, so a stray local process cannot reach ChatGPT or Anthropic anonymously through the router. Tokens are not validated locally; the upstream does that.
- The ChatGPT token goes only to `chatgpt.com`, the Anthropic OAuth token only to `api.anthropic.com`, the DeepSeek key only to `api.deepseek.com`. Hosts are pinned in code and overridable only in the switchboard's own config file, created with user-only permissions.
- Bodies are streamed, never stored. Logs hold metadata only.
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
| 2 | Quota failover for Claude Code and for function-tool GPT models. Captured 429 fixtures. Cost and cache dashboards. Local compaction shim for DeepSeek main sessions in Codex, built as a prefix extension of the last request (same instructions, tools and history, directive appended last) so the summary call itself is mostly cache hits, the way DeepSeek's harness does it. |
| 3 | WebSocket splice for GPT traffic. Responses-lite reshaping for GPT‑6 Astra failover. Codex multi-agent v2 verification. |
| 4 | Any Responses- or Messages-compatible upstream as a subagent provider; per-role cost budgets. |

## 17. Risks and open questions

- Either vendor may restrict base-URL overrides with subscription auth. Mitigation: `doctor` detection, an honest README, no silent workaround.
- Codex `force_http_fallback` after a declined upgrade is read from source, not observed; phase 1 verifies it and, if Codex retries the upgrade on every request, pulls the WebSocket splice forward.
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
