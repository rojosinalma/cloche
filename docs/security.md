# Security

| Area | Measure |
|---|---|
| API and MCP | Bearer token; without a configured token they answer 404 (fail closed) |
| Share pages | No auth in the app: the random share id (32 URL-safe chars) is the key |
| Internet exposure | Not meant to face the internet on its own: put it behind an auth proxy, a VPN or an identity-aware gateway. `CLOCHE_BIND` defaults to loopback |
| External links | The one path meant to face the internet: `/x/<token>/` serves a file or raw share read-only to whoever has the URL. With a gateway in front of the whole site, exempt only `/x` and the static assets those pages load (`/tailor`, `/css`, `/js`, `/favicon.svg`), never `/s`, `/api` or `/mcp`. The token is 32 random bytes, unrelated to the share id, and the `/x` pages never show the id. Links expire (`external_link_default_ttl`, capped by `external_link_max_ttl`), can be revoked one by one and end with the share; downloads through them are logged with the link id and IP. Forms never get links. `external_links_enabled=false` turns every `/x` path into a 404 |
| Paths | Only under `allowed_roots`; `realpath` + containment on create and on every request; `..` and escaping symlinks are refused |
| Zip | Built from a symlink mirror of validated paths only; escaping symlinks are never followed |
| Previews | Served inline with `Content-Security-Policy: sandbox` (an SVG cannot run script); raw shares render HTML on purpose and skip the sandbox |
| Mounts | Host files are mounted read-only; cloche never writes to them |
| Container | Runs as the unprivileged `cloche` user (uid 1000); started as root it only fixes the data directory's ownership and drops privileges before the app starts |
| Callbacks | Outbound only, to the configured `opencode_url`, with HTTP Basic credentials from `.env` |
| Secrets | `.env` is mounted into the container and read by dotenv; nothing is passed through the compose `environment:` block except structural values |

Report a vulnerability privately as described in [`SECURITY.md`](../SECURITY.md).
