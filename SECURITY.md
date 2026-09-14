# Security

agents-switchboard sits between your coding agents and the model vendors, holding your ChatGPT token, your claude.ai token, and your DeepSeek key in transit. The design keeps that surface small:

- The router binds to `127.0.0.1` only and refuses any other address without `--allow-remote`, which the installer never sets.
- Vendor routes require a local capability URL minted by `switchboard install`: `/_switchboard/<token>/...`. This token is stored once as `access_token` in the switchboard config and copied only into the clients' base-URL settings. Router-owned local auth failures, including legacy unprotected vendor paths, return HTTP 400 with reinstall guidance. Provider-key failures are also reported as HTTP 400 so they do not look like expired subscription logins.
- Pass-through routes also require the client's own credential header, so a stray local process cannot use the router to reach ChatGPT or Anthropic anonymously.
- The ChatGPT token is sent only to `chatgpt.com`, the Anthropic token only to `api.anthropic.com`, the DeepSeek key only to `api.deepseek.com`. Upstream hosts are fixed in code and can be changed only in the switchboard's own config file, which is created with user-only permissions.
- Request and response bodies are streamed, never stored. The request log holds metadata only: timestamps, routes, models, status codes, token counts.
- Provider keys are stored in the OS keychain when available. On machines without a keychain, the installer puts the provider key in the user-only service environment and configures the switchboard to read it from that environment variable. Provider keys never appear in client config, role files, logs, or command output.
- The local capability token is not a provider key or a vendor credential. It may appear in client base-URL config by design, and must not appear in argv, logs, upstream requests, or human output.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email the maintainer at the address on the GitHub profile, or use GitHub's private vulnerability reporting on this repository. You will get an acknowledgement within a few days.
