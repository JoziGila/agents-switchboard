# agents-switchboard

Run your coding agents' **subagents on DeepSeek V4.1 Flash** while the main session keeps using the GPT or Claude model from your subscription. Works with **Codex** (desktop and CLI) and **Claude Code** (desktop, CLI, IDE). One command configures both.

```
npx agents-switchboard install
```

## What it does

`agents-switchboard` is a small loopback router. Codex and Claude Code are pointed at it through the base-URL setting each of them already supports, and keep using their normal subscription logins. The router forwards GPT and Claude traffic unchanged, and sends any request for a DeepSeek model to DeepSeek's native Responses API or Anthropic-compatible API.

- **Cheap subagents.** `explorer`, `worker`, `reviewer` roles run on DeepSeek Flash, roughly 50x cheaper than a frontier model, with a 1M context and a prefix cache that makes repeated exploration nearly free. A `senior` role escalates to your frontier model when Flash fails.
- **Full use of your subscription.** The orchestrating session still runs on GPT‑6 or Claude, through the ChatGPT or claude.ai login you already have.
- **DeepSeek in the picker.** It shows up in both apps' model pickers, so it can be the main model with one click.
- **Quota failover.** When you hit your subscription's usage limit, the router finishes the turn on DeepSeek and keeps going until the limit resets.
- **Nothing patched, everything reversible.** Config edits are marker-guarded and backed up. `npx agents-switchboard uninstall` puts everything back.

## Why a router

Neither client can choose a provider per subagent. Codex discards `model_provider` in role files since August 2026 and children inherit the parent's provider; Claude Code has one `ANTHROPIC_BASE_URL` for everything and its fallback chain ignores rate limits. Both, however, let that one provider be re-pointed while keeping subscription auth. The router lives at that point and dispatches by model. The [spec](SPEC.md) has the full argument with source references.

## Status

Phase 1 is implemented: router with both pass-throughs, both DeepSeek adapters, Codex catalog injection, WebSocket decline, installer for both clients, role files, delegation policy, `doctor`, `test`, `status`. Verified end to end with the real Codex CLI through the router against ChatGPT. Not yet published to npm; run from a checkout with `node bin/switchboard.js <command>`. See [SPEC.md](SPEC.md) for the design and roadmap.

## Requirements

- Node 22+
- Codex CLI or desktop app, and/or Claude Code
- A DeepSeek API key from platform.deepseek.com

## Commands

| Command | Purpose |
|---|---|
| `install` | Configure detected clients, store the key, register the login service |
| `doctor` | Check service, config, auth, upstreams, versions |
| `test` | Spawn a real subagent and prove it ran on DeepSeek |
| `status` | Routes, failover state, tokens, cache hit ratio, spend |
| `roles` | Rewrite role files (`--pro` for an all-DeepSeek fleet) |
| `failover on\|off\|reset` | Control quota failover |
| `uninstall` | Restore both clients from backup |

## Security

Binds to `127.0.0.1` only. Your ChatGPT token goes only to `chatgpt.com`, your Anthropic token only to `api.anthropic.com`, your DeepSeek key only to `api.deepseek.com`. Keys live in the OS keychain. Bodies are streamed, never stored. Details in [SPEC.md §13](SPEC.md#13-security-and-privacy).

## License

MIT
