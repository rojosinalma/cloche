# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/rojosinalma/cloche/security/advisories/new)
(Security tab → "Report a vulnerability"). Do not open a public issue. You will get an
acknowledgement within a week and a fix or a statement before any public disclosure.

## Supported versions

Only the latest release receives fixes. Upgrade `ghcr.io/rojosinalma/cloche` to the newest `X.Y.Z`
tag before reporting.

## What the app holds

cloche serves files from the host it runs on, so a flaw can expose more than the share it was meant
for. Keep in mind:

1. The share id in the URL is the only key to a share. Put the instance behind an authenticating
   reverse proxy before you expose it outside a trusted network.
2. `/api` and `/mcp` require the bearer token `CLOCHE_MCP_TOKEN`; without one they answer 404.
3. Paths are checked against `CLOCHE_ROOTS` on create and on every request; escaping symlinks are
   refused. Mount only the tree you want to share, read-only.
4. The container runs as an unprivileged user and needs no capabilities and no Docker socket.
5. Callbacks go only to the configured opencode server, with the credentials from `.env`.

The full threat model is in [`docs/security.md`](docs/security.md).
