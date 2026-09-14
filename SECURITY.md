# Security

agents-switchboard sits between your coding agents and the model vendors, holding your ChatGPT token, your claude.ai token, and your DeepSeek key in transit. The design keeps that surface small:

- The router binds to `127.0.0.1` only and refuses any other address without `--allow-remote`, which the installer never sets.
- Pass-through routes require the client's own credential header, so a stray local process cannot use the router to reach a vendor anonymously.
- The ChatGPT token is sent only to `chatgpt.com`, the Anthropic token only to `api.anthropic.com`, the DeepSeek key only to `api.deepseek.com`. Upstream hosts are fixed in code and can be changed only in the switchboard's own config file, which is created with user-only permissions.
- Request and response bodies are streamed, never stored. The request log holds metadata only: timestamps, routes, models, status codes, token counts.
- The DeepSeek key is stored in the OS keychain. It never appears in client config, role files, logs, or command output.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email the maintainer at the address on the GitHub profile, or use GitHub's private vulnerability reporting on this repository. You will get an acknowledgement within a few days.
