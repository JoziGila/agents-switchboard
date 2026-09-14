# DeepSeek integration standard

DeepSeek's own agent harness (`deepseek-ai/deepseek-harness`, summarised in [research/deepseek-harness-learnings.md](research/deepseek-harness-learnings.md)) is the reference for how DeepSeek wants to be called. The switchboard applies its rules at the boundary where a client's request becomes a DeepSeek request: the Responses adapter for Codex and the Messages adapter for Claude Code. Each rule is one named pure function, switched by a provider profile so the same code serves OpenRouter with different settings.

| Harness rule | Enforced by | Without it the client would see |
|---|---|---|
| Only the provider's own effort spellings cross the wire (`low`, `high`, `max`) | `mapEffort` in `src/adapters/responses.js`, applied to `reasoning.effort` and `output_config.effort` | A 400 for `xhigh`, `ultra` or `medium`, which Codex and Claude Code send by default |
| An assistant turn must carry content or tool calls; null content bricks every later turn of the session | `ensureAssistantContent` in both adapters | A 400 on the next turn after any reasoning-only or empty assistant reply, permanently for that session |
| Empty tool output still needs some content on the wire | `ensureToolOutput` (Responses) and `ensureToolResult` (Messages), placeholder `(no output)` | A rejected request after a command that printed nothing |
| Reasoning text is replayed byte-exact on every turn; only the encrypted payload is provider-bound | `cleanReasoningItem`: keeps summary and content, strips `encrypted_content` unless the profile vouches for the item | Lost thinking continuity, and cache misses when reasoning text changes position |
| `thinking` travels as `{type: enabled or disabled}`; nothing client-only rides along | `cleanThinking`: `adaptive` becomes `enabled`, `display` is dropped | A 400 for `thinking.type = "adaptive"`, which Claude Code sends for every model it does not recognise |
| Unsupported fields are removed identically on every request, never reordered, so the cached prefix stays stable | `rewriteResponsesRequest` top-level drop list and `cleanInputItem`; `cleanOutputConfig` | Cache misses from volatile bytes such as `prompt_cache_key` and `client_metadata` |
| Only function tools and the custom tools the provider accepts are sent | `flattenTools` with `profile.customTools` | A 400 for `tool_search`, `web_search`, or namespace wrappers |
| Structured output is not a DeepSeek feature | `cleanOutputConfig` drops `output_config.format` for DeepSeek, keeps it for OpenRouter | A 400 on Claude Code's session-title request |
| Only user and assistant roles inside `messages` | `cleanMessage` converts mid-conversation `system` messages to `user` | A 400 once Claude Code appends a system reminder mid-conversation |
| Document, search-result and redacted-thinking blocks do not exist upstream | `cleanMessage` with `profile.unsupportedBlocks` | A 400 when a PDF or a redacted block is in history |
| Auth failures are the operator's problem, not the client's login | `mapUpstreamError` turns 401, 402 and 403 into a 400 with the provider name and a hint | Codex or Claude Code trying to refresh its own token, and reporting the login as revoked |
| Cache accounting reads the OpenAI-compatible spelling first, DeepSeek's second | `usageFromResponsesEvent`, `usageFromMessagesEvent`, `normalizeUsage` | A status page and a Claude Code `/usage` line that show no cache hits |

## What stays with the clients

Two harness rules cannot be enforced in a proxy and are left to Codex and Claude Code, which already follow them:

- Volatile context belongs at the tail of the conversation, not in the system prompt. Both clients keep their system prompts stable per session; the switchboard only removes fields and never reorders.
- Compaction should replay the exact cached prefix. Both clients own compaction; the phase 2 compaction shim for Codex will build its summary request as a prefix extension of the last request.

## Profiles

`DEEPSEEK_RESPONSES` and `DEEPSEEK_MESSAGES` encode the rules above. `OPENROUTER_RESPONSES` and `OPENROUTER_MESSAGES` relax what OpenRouter supports natively: the four-level effort ladder `minimal`, `low`, `medium`, `high`, adaptive thinking and structured output for Anthropic models, documents, and no placeholders. A route can override `keepEncryptedContent` with a provenance check so that reasoning chains OpenRouter itself produced are replayed intact.
