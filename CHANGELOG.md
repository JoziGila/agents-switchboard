# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Loopback router with byte-for-byte pass-through to the ChatGPT backend and the Anthropic API, and DeepSeek adapters for the Responses and Messages dialects.
- Codex model catalog injection with a forked ETag, so DeepSeek models appear in the picker and are valid for `spawn_agent`.
- Claude Code custom model option and subagent default, so DeepSeek Flash appears in `/model` and runs every subagent.
- Installer for both clients with marker-guarded, backed-up, reversible config edits; role files (`explorer`, `worker`, `reviewer`, `senior`); delegation policy block; login service on macOS, Linux and Windows; keychain-backed secrets.
- CLI: `install`, `uninstall`, `serve`, `doctor`, `test`, `status`, `logs`, `roles`, `failover`.
- Status page and JSON endpoint with per-model and per-role token counts, cache hit ratio, and estimated spend.

### Safety
- The router never answers a client with HTTP 401; both clients treat it as an expired login.
- The installer starts the service, waits for health, and completes a real turn per client through the router before editing any client configuration.
