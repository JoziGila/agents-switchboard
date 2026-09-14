# What DeepSeek's own harness teaches about talking to DeepSeek

Source: a local checkout of `deepseek-ai/deepseek-harness` (dsh), read on 2026-09-14. Paths below are relative to that repo. These are the practices the switchboard copies; the spec cites this file.

## Wire facts

- Production path is Chat Completions at `{base}/chat/completions` with `Authorization: Bearer`, `accept: text/event-stream`, always `stream: true` with `stream_options.include_usage: true` (`packages/llm/llm-deepseek/src/adapter.ts`, `serialize.ts`).
- Web search uses the Anthropic-compatible surface at `https://api.deepseek.com/anthropic/v1/messages`, sending both `x-api-key` and `Authorization: Bearer` so either an official endpoint or a proxy accepts it (`packages/web/web-search-deepseek/src/provider.ts`).
- Codex on DeepSeek, in their own e2e test, is a loopback Responses-API shim that forwards to DeepSeek (`packages/subagent/subagent-codex/tests/deepseek-responses-bridge.ts`), configured with `wire_api = "responses"`, `requires_openai_auth = false`, `disable_response_storage = true`. The same shape as the switchboard.
- Claude Code on DeepSeek, in their e2e test, points `ANTHROPIC_BASE_URL` at `https://api.deepseek.com/anthropic` (the client appends `/v1/messages`) and pins `ANTHROPIC_MODEL`, all three `ANTHROPIC_DEFAULT_*_MODEL` aliases, and `CLAUDE_CODE_SUBAGENT_MODEL` (`packages/subagent/subagent-claude-code/tests/real-deepseek.e2e.ts`).
- `thinking` is a top-level field, `{type: "enabled" | "disabled"}`. `reasoning_effort` is `low | high | max` only. "Off" is expressed as `thinking.type = disabled` with `reasoning_effort` omitted, never as an unknown effort string (`types.ts`, `serialize.ts`).
- `top_p` is never sent. `temperature` only when a caller asks. `max_tokens` defaults to 256K per model, context window 1M.
- Assistant `content` is never `null`; empty text is `""`. Empty tool output is sent as the literal `(no output)`. The live API 400s on null content with no tool calls, and because the message is durable in the log it would break every later turn.
- Usage: read `prompt_tokens_details.cached_tokens` first, `prompt_cache_hit_tokens` second; `prompt_tokens` includes cache hits. Usage may arrive on the finish chunk or a trailing usage-only chunk (`translate.ts`).
- Request id: `x-request-id`, then `x-deepseek-request-id`. Errors: 401/403 auth, 413 invalid request, 429 rate limit, 400 with context-window text is overflow, 5xx server. Retries: 5, 500 ms initial, 10 s cap, 10% jitter; `Retry-After` honoured in both forms but a delay above the cap aborts instead of sleeping. A terminal `stop` with zero content is retried as an empty response. Idle watchdog 300 s per read.

## Reasoning passback

`reasoning_content` is replayed on every assistant turn, including turns without tool calls, concatenated into one string exactly as received (`serialize.ts` ≈ L217, Agent Note `2026-08-19-deepseek-reasoning-passback-every-turn.md`). DeepSeek's thinking-mode guide requires it on tool-call turns; sending it everywhere lets a gateway that re-encodes for another vendor recover the thinking signature by hashing that exact text. They tried stripping it to save tokens and reverted: the text sits at a fixed position, is identical on every later request, so the prefix stays stable and only the first request spanning the change loses reuse. They refused to make it a switch: "A knob whose wrong position fails silently is worse than the tokens."

## Prefix discipline

- The system prompt is an ordered registry with integer section orders and code-unit name tie-breaks, so it renders byte-identically on every machine. Variables are `{{name}}`, unknown ones throw. Only `provider`, `model`, `cwd` exist, all session-stable (`packages/core/system-prompt/src/index.ts`).
- Anything that can change mid-session (sandbox policy, approval policy, delegation) is a runtime context rendered as a user message appended at the tail, re-emitted only when its text changes (`packages/core/agent-loop/src/runtime-context.ts`). Time context is opt-in, appended, throttled. AGENTS.md changes append a new baseline rather than rewriting the old one.
- Tools are ordered lexicographically or by a pinned order; a snapshot test asserts the tool set never changes across steps of a session. Schemas are cloned at assembly so nothing can mutate them between turns.
- The live model catalog is never rendered into a tool description: "catalog changes would rewrite an early cache-prefix definition." Model discovery is an on-demand tool.
- Fork children inherit provider and model and add no child-only system section or tool ahead of the inherited history; the child's return instruction goes into the initial user task. "A child-only system-prompt section or tool schema ahead of the inherited history defeats that payoff."
- Every package README has a mandatory "KV Cache effect" section, enforced by a script. Stock phrase for the good case: "Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries."
- Out-of-band metadata (`x-deepseek-harness-*` headers, `dsh_*` body fields) never enters messages, system prompt, or tool schemas. Compaction calls carry `x-deepseek-harness-compact: 1`.
- Images go through the Files API with stable ids; inline base64 is a per-request fallback, and one request never mixes the two. Image offloading happens in quanta so the prefix is rewritten rarely.

## Compaction

- Thresholds: 80% of the window triggers, 16% verbatim tail retained (800K and 160K on 1M). A model-free tool-result pruner runs first (head 4096 chars, tail 1024, middle replaced), then the LLM summary only if still over.
- The replaced span is always the head, cut backwards to a tool-call-balanced boundary. Ordinary growth is append-only; compaction invalidates from token 0 once.
- The summarisation request is built as a prefix extension of the last routed request: the recorded exact `system` and `tools`, the replayed history, then the directive as the final user message, so the summary call itself bills mostly as cache hits (`packages/compaction/compaction-basic/src/summarizer.ts`, `region.ts` `buildSummarizationInput`). The checkpoint is wrapped in `<compacted-summary>` and framed as established background.
- Overflow (400 context-window) triggers prune plus compact with zero retained tail and one retry.

## Effort ladder

`off` for simple tasks, `low` for routine or latency-sensitive, `high` default, `max` for the hardest quality-first tasks. Session-title generation forces thinking off. No per-task-kind policy beyond that; effort is per route.
