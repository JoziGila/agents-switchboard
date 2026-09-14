# agents-switchboard

Run your coding agents' **subagents on DeepSeek V4.1 Flash** while the main session keeps the GPT or Claude model from your subscription. Works with **Codex** (desktop and CLI) and **Claude Code** (desktop, CLI, IDE). One command configures both.

```
git clone https://github.com/JoziGila/agents-switchboard && cd agents-switchboard
npm ci
node bin/switchboard.js install
```

Verified on 2026-09-14 with Codex 0.154 and Claude Code 2.1.270: an explorer subagent spawned from a GPT‑6 session ran 14 requests on DeepSeek Flash with a 94% prefix-cache hit ratio, and a Claude Code explorer ran on Flash too, for under one cent in total.

## What you get

- **Cheap subagents.** `explorer`, `worker` and `reviewer` roles run on DeepSeek Flash: 1M context, roughly 50× cheaper than a frontier model, and a prefix cache that makes repeated exploration nearly free. A `senior` role escalates to your frontier model when Flash fails.
- **Your subscription, untouched.** The orchestrating session still runs on GPT‑6 or Claude through the ChatGPT or claude.ai login you already have. The router forwards that traffic byte for byte.
- **DeepSeek in both pickers.** It appears in Codex's model list and in Claude Code's `/model`, so it can be the main model with one click.
- **Quota failover** (phase 2). When you hit the subscription's usage limit, the router finishes the turn on DeepSeek and keeps going until the limit resets.
- **Nothing patched, everything reversible.** Config edits are marker-guarded and backed up. `switchboard uninstall` puts both clients back.

## How it works

Neither client can pick a provider per subagent, but both can be pointed at a different base URL while keeping subscription auth. The switchboard is a loopback router at that URL.

```
Codex ── openai_base_url ──▶ 127.0.0.1:4141/backend-api/codex ──┬─ gpt-*      ─▶ chatgpt.com (unchanged, your ChatGPT token)
                                                                └─ deepseek-* ─▶ api.deepseek.com/responses
Claude Code ── ANTHROPIC_BASE_URL ──▶ 127.0.0.1:4141/anthropic ──┬─ claude-*   ─▶ api.anthropic.com (unchanged, your claude.ai token)
                                                                 └─ deepseek-* ─▶ api.deepseek.com/anthropic/v1/messages
```

Requests are routed by model. GPT and Claude traffic passes through untouched, including every header and the compressed body. DeepSeek-bound requests get a small, deterministic rewrite (fields DeepSeek does not support are removed, nothing is reordered) so DeepSeek's prefix cache keeps hitting. Full design, with references into the Codex source and the Claude Code gateway docs, in [SPEC.md](SPEC.md).

## OpenRouter too

Any OpenRouter model works as a main model or a subagent in both clients: give the router an OpenRouter key at install time (optional), then use OpenRouter's own ids, `deepseek/deepseek-v4.1-flash`, `qwen/qwen3-coder`, `~anthropic/claude-opus-latest`. The id's `vendor/model` shape is what routes it; nothing to register. Models you list under `[upstream.openrouter] models` in `~/.agents-switchboard/config.toml` also show up in the Codex picker. Every OpenRouter request carries `provider.require_parameters` so tools and reasoning never get silently dropped, a stable session id so the conversation sticks to the provider holding its prefix cache, and attribution headers; put `sort = "throughput"` or `data_collection = "deny"` under `[upstream.openrouter.provider]` to tune it. OpenRouter's own encrypted reasoning chains are sent back only to OpenRouter, and its reported cost feeds the status page.

## Install

Requirements: Node 22.15+, Codex and/or Claude Code signed in with your subscription, a DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com).

`node bin/switchboard.js install` does the following, in this order, and stops at the first failure without touching your clients:

1. Detects Codex and Claude Code and asks for the DeepSeek key (stored in the OS keychain, never in a file).
2. Optionally asks for an OpenRouter key. Probes each provider on both API dialects.
3. Registers and starts the login service (launchd on macOS, systemd user unit on Linux, scheduled task on Windows) and waits for `/switchboard/health`.
4. Completes a real turn per client **through** the router using only a command-line override, so nothing on disk has changed yet.
5. Only then edits `~/.codex/config.toml` and `~/.claude/settings.json` (backed up first), writes the role files, and appends a delegation policy to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. Both configs are pre-flighted before step 3, so a conflict or a corrupt file stops the install with nothing changed.
6. Runs `doctor`.

Restart the desktop apps once so they refetch models. Sessions already open keep their old connection.

What the clients end up with:

| Codex (`~/.codex/config.toml`) | Claude Code (`~/.claude/settings.json`) |
|---|---|
| `openai_base_url` → the router | `env.ANTHROPIC_BASE_URL` → the router |
| `[agents] default_subagent_model = "deepseek-flash"` | `env.CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-flash[1m]"` |
| `[features] multi_agent_v2 = false` | `env.ANTHROPIC_CUSTOM_MODEL_OPTION*` (picker entry) |
| `~/.codex/agents/{explorer,worker,reviewer,senior}.toml` | `~/.claude/agents/{explorer,worker,reviewer,senior,Explore,Plan}.md` (the last two replace Claude's built-ins, which otherwise ignore the subagent model) |

## Commands

| Command | Purpose |
|---|---|
| `install [--codex] [--claude] [--port N] [--pro] [--openrouter-key K] [--dry-run]` | Configure detected clients, store the keys, start the service. `--pro` puts `reviewer` and `senior` on DeepSeek V4 Pro; `--dry-run` previews every file change. |
| `doctor` | Check service, port, client config, subscription auth, DeepSeek key, upstream reachability, versions. |
| `test` | Spawn a real explorer in each client and prove from the router log that it ran on DeepSeek. |
| `status` | Routes, failover state, per-model and per-role tokens, cache hit ratio, estimated spend. Also at http://127.0.0.1:4141/switchboard/ |
| `logs [-n N]` | Tail the request log (metadata only). |
| `roles [--pro] [--reset]` | Rewrite the role files. |
| `failover on\|off\|reset` | Control quota failover. |
| `uninstall [--purge]` | Restore both clients and remove the service; a config the installer never touched is left byte-identical. `--purge` also deletes every provider's keychain entry. |

## Safety

- Loopback only. Your ChatGPT token goes only to `chatgpt.com`, your claude.ai token only to `api.anthropic.com`, your DeepSeek key only to `api.deepseek.com`.
- The router never answers a client with HTTP 401, because both clients treat that as an expired login and start a token refresh.
- The installer never points a client at a router it has not just proven healthy with a real round trip.
- Bodies are streamed, never stored. The log holds metadata only. See [SECURITY.md](SECURITY.md).

## Troubleshooting

- **"API Error: Connection refused" in Claude Code, or Codex cannot reach its backend.** The router is down. `switchboard doctor` says why; `launchctl kickstart -k gui/$UID/dev.agents-switchboard` restarts it on macOS. If you want out immediately: `switchboard uninstall`.
- **DeepSeek models missing from the Codex picker, or a Codex subagent says its task was "encrypted by the vendor".** A Codex process that started before the install (usually the desktop app) still talks to chatgpt.com directly and keeps rewriting the shared models cache. Quit and reopen the Codex app; `switchboard doctor` reports this as "codex models cache served by the router".
- **A subagent answers with "no DeepSeek API key configured".** Run `switchboard install` again and enter the key.
- **Claude Code warns that `deepseek-flash` is not in its catalog.** Harmless; the `[1m]` suffix the installer sets tells it the real context window.

## Status and roadmap

Phase 1 is complete and verified end to end. Phase 2 adds quota failover and the cost dashboard; phase 3 splices WebSockets through for GPT traffic and re-enables Codex multi-agent v2 after verification. Details in [SPEC.md §16](SPEC.md#16-roadmap). Not yet on npm; run from a checkout.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT.
