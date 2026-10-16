# Security

| Area | Measure |
|---|---|
| API and MCP | Bearer token; without a configured token they answer 404 (fail closed) |
| Share pages | No auth in the app: the random share id (32 URL-safe chars) is the key |
| Internet exposure | Not meant to face the internet on its own: put it behind an auth proxy, a VPN or an identity-aware gateway. `CLOCHE_BIND` defaults to loopback |
| Paths | Only under `allowed_roots`; `realpath` + containment on create and on every request; `..` and escaping symlinks are refused |
| Zip | Built from a symlink mirror of validated paths only; escaping symlinks are never followed |
| Previews | Served inline with `Content-Security-Policy: sandbox` (an SVG cannot run script); raw shares render HTML on purpose and skip the sandbox |
| Mounts | Host files are mounted read-only; cloche never writes to them |
| Callbacks | Outbound only, to the configured `opencode_url`, with HTTP Basic credentials from `.env` |
| Secrets | `.env` is mounted into the container and read by dotenv; nothing is passed through the compose `environment:` block except structural values |

Report a vulnerability by opening a GitHub issue marked "security", or by contacting me through the
address on my GitHub profile if the details should stay private until fixed.
