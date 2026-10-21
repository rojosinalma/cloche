# Security

| Area | Measure |
|---|---|
| API and MCP | Bearer token; without a configured token they answer 404 (fail closed) |
| Share pages | No auth in the app: the random share id (32 URL-safe chars) is the key |
| Internet exposure | Not meant to face the internet on its own: put it behind an auth proxy, a VPN or an identity-aware gateway. `CLOCHE_BIND` defaults to loopback |
| External links | The one path meant to face the internet: `/x/<token>/` serves a file or raw share read-only to whoever has the URL. With a gateway in front of the whole site, exempt only `/x` and the static assets those pages load (`/tailor`, `/css`, `/js`, `/favicon.svg`), never `/s`, `/api` or `/mcp`. The token is 32 random bytes, unrelated to the share id, and the `/x` pages never show the id. Links expire (`external_link_default_ttl`, capped by `external_link_max_ttl`), can be revoked one by one and end with the share; downloads through them are logged with the link id and IP. Forms never get links. `external_links_enabled=false` turns every `/x` path into a 404 |
| Paths | Only under `allowed_roots`; `realpath` + containment on create and on every request; `..` and escaping symlinks are refused |
| Zip | Built from a symlink mirror of validated paths only; escaping symlinks are never followed |
| Previews | Served inline with `Content-Security-Policy: sandbox` and `nosniff` (an SVG cannot run script); raw shares render HTML on purpose and skip the sandbox |
| HTML previews | Rendered in a frame with `sandbox allow-scripts` and the same CSP: the page's scripts run, but in an opaque origin, so they cannot read cloche's pages, cookies or storage, navigate the top page or open popups. Its stylesheets, images and scripts load through `?data=html&part=`, resolved by `PathGuard` inside the share, with `Access-Control-Allow-Origin: *` so module scripts and fonts load in that origin. Notebook HTML outputs sit in their own sandboxed frames where only cloche's height script runs |
| Parsing | Trees, notebooks, diffs, PDF info and archive listings are read on the server with size, node, entry and time caps (`<viewer>_view_*`). YAML loads safely with aliases off; archives are listed, never extracted; GPX and KML lose their doctype before parsing, so no external entity loads. File text reaches the page as text, never as markup |
| Outbound from viewers | The server calls a cad-render service only when `step_view_cad_render_url` is set (STEP to STL, cached in container tmp). The viewer's browser loads libraries from jsDelivr and, for maps, tiles from `geo_view_tile_url` (OpenStreetMap by default, origin-only referrer; empty = no tile requests) |
| Mounts | Host files are mounted read-only; cloche never writes to them |
| Container | Runs as the unprivileged `cloche` user (uid 1000); started as root it only fixes the data directory's ownership and drops privileges before the app starts |
| Callbacks | Outbound only, to the configured `opencode_url`, with HTTP Basic credentials from `.env` |
| Secrets | `.env` is mounted into the container and read by dotenv; nothing is passed through the compose `environment:` block except structural values |

Report a vulnerability privately as described in [`SECURITY.md`](../SECURITY.md).
