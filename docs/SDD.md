# cloche — software design document

## Purpose

cloche hands files from the machine an AI coding agent runs on to a browser, and tells the agent what
happened. An agent (over REST or MCP) names absolute host paths; cloche serves them as a gallery page
with previews, downloads and a zip; when the page is closed, stopped or times out, the agent's opencode
session receives a note with the outcome and the download log. The same mechanism carries forms
(questions the agent asks, answered in the browser) and raw static sites. It replaces ad-hoc "start a
web server in that directory" moments with one long-running service and one URL scheme.

## Architecture

One container, one Ruby process:

| Component | Files | Role |
|---|---|---|
| HTTP app | `app.rb`, `config.ru`, `config/puma.rb` | Roda routes for `/api`, `/mcp`, `/health`, `/s/<id>/…`, `/x/<token>/…`; JSON helpers `json_ok`/`json_err`; ERB pages in `views/` |
| Share manager | `lib/share_manager.rb` | Create/update/stop shares, validation, result and summary documents, `wait`, retention purge |
| Link manager | `lib/link_manager.rb`, `models/link.rb` | External links: create/revoke with TTL validation and caps, token lookup for `/x`, link documents and footer status |
| Path guard | `lib/path_guard.rb` | `realpath` + containment against `allowed_roots` on create and on every request |
| File server | `lib/file_server.rb`, `lib/zipper.rb` | Rack::Files-based delivery with range support, download counting, CSP sandbox; streamed zip from a symlink mirror (`zip -r -`) |
| Viewers | `lib/preview.rb`, `lib/viewers/*.rb`, `lib/listing.rb`, `lib/text_view.rb`, `views/viewers/`, `public/js/preview.js`, `public/js/viewers/*.js` | Viewer registry (match rules, tabs, settings, data endpoints), directory listings and kinds, text rendering (Rouge, Redcarpet, CSV); the preview modal shell and one browser module per viewer (text, image, video, audio, three.js model). Contract: [`viewers.md`](viewers.md) |
| Forms | `lib/form.rb` | Form spec normalisation, draft (lenient) and submit (strict) validation |
| MCP server | `lib/mcp_server.rb` | Stateless Streamable HTTP server built on the `mcp` gem; tools wrap the same ShareManager calls as the REST API |
| Callback | `lib/callback.rb`, `lib/worker_pool.rb` | Bounded thread pool delivering end-of-share / submit events to the opencode server |
| Idle sweeper | `lib/idle_sweeper.rb` | One named thread: ends idle shares, keeps in-flight transfer counters, purges expired results |
| Models | `models/database.rb`, `models/share.rb`, `models/download.rb`, `models/setting.rb` | Sequel models over SQLite; `Setting` is the typed runtime config |

How they talk: the browser hits `/s/<id>/…` (no auth; the id is the key) and `/s/<id>/status` for the
live footer; people the share is passed on to hit `/x/<token>/…`, the same gallery read-only. Agents hit `/api/*` or `/mcp` with a bearer token. cloche calls out only to the opencode
server (`opencode_url`) with HTTP Basic auth. Everything else is in-process method calls; there is no
message bus and no second process.

## Data model / storage

SQLite at `DATABASE_PATH` (WAL mode), opened in `models/database.rb`; migrations in `db/migrations/`
run on every boot and are additive only.

- `shares` — `id` (24 random bytes, URL-safe base64), `title`, `raw`, `paths` (JSON list of resolved
  real paths), `session_id`, `session_directory`, `started_at`, `last_activity_at`, `ended_at`,
  `end_reason`, `idle_timeout` (nil = follow the setting, 0 = permanent), and the form columns
  `form`, `draft`, `answers`, `submitted_at`, `submissions`, `draft_saved_at` (JSON text).
- `downloads` — `share_id` (cascade delete), `link_id` (set when the download came through an
  external link), `name`, `ip`, timestamp. Previews and resumed range requests are not counted.
- `links` — `id`, `token` (32 random bytes, URL-safe base64, unique), `share_id` (cascade delete),
  `created_at`, `expires_at` (nil = until revoked), `revoked_at`. A link is live while it is neither
  revoked nor expired and its share is live.
- `settings` — `key`/`value` text; types are declared in `Setting` (`INTEGER_KEYS`, `BOOLEAN_KEYS`,
  `LIST_KEYS`), defaults in `Setting.defaults`, env seeds copied in by `Setting.seed_defaults!` on
  first boot only.

Host files are never copied: the host tree is bind-mounted read-only at the same absolute path, so a
stored path is valid inside and outside the container. Zips are built from a temporary directory of
symlinks that is removed when the stream closes.

## Key flows

1. **Create a share** — `POST /api/shares` or `create_share`: `ShareManager.create` validates every
   path through `PathGuard.validate_paths` (absolute, exists, inside a root), the session id format,
   the idle timeout and the optional form spec; inserts the row; returns the summary with `url` and
   `lan_url` built from the base-URL settings.
2. **Browse** — `GET /s/<id>/` renders the gallery (or form, or the raw site's index). Every file
   request re-resolves the relative path against the share entry (`PathGuard.resolve`), so a symlink
   that escapes the root is refused at request time, not just at creation. Each successful 200/206
   response counts a download and touches `last_activity_at`.
3. **Idle timeout** — the sweeper wakes at a fraction of the shortest live timeout, touches shares
   with transfers in flight and stops the others whose `last_activity_at` is older than their
   effective timeout. Stopping sets `ended_at`/`end_reason` and enqueues the callback.
4. **Callback** — `Callback.push` looks up the session's directory if the share has none, then
   according to `callback_mode` either `PUT`s an instruction entry (silent), queues a synthetic
   message, or queues a prompt. Failures are logged with backtrace and never retried; the result is
   still readable via `get_share`/`wait_share`.
5. **Forms** — `PUT /s/<id>/draft` saves partial answers (lenient), `POST /s/<id>/submit` validates
   strictly, bumps `submissions`, fires a `:submitted` callback and keeps the share open so the
   answers can be revised; `wait` with `since` returns on the next submit.
6. **Retention** — ended shares, their download logs and their links are deleted once `ended_at` is
   older than `result_retention`.
7. **External link** — `POST /s/<id>/links` (the page's Share link dialog), `POST /api/shares/<id>/links`
   or `create_link`: `LinkManager.create` refuses forms, ended shares, a switched-off feature, a `ttl`
   over `external_link_max_ttl` and more than `external_link_max_live` live links, then stores a new
   token. `GET /x/<token>/…` looks the token up, answers 410 when the link or the share has ended, sets
   the request's URL prefix on the share (`Share#base_path`, read by `Listing.base`) and the link
   (`Share#via_link`, read by the download counter), and runs the same gallery routes as `/s` minus
   stop, draft, submit and links. The sweeper treats a live link like a transfer in flight, so the
   share does not idle out while one exists.

## Configuration surface

Documented in [`configuration.md`](configuration.md). Structural values (bind, port, mount, token,
opencode credentials) come from `.env`; tunables (timeouts, caps, URLs, callback behaviour) are
settings rows read with `Setting.get` on every use, so `PUT /api/settings/:key` takes effect on the next
request without a restart. Four env vars act as first-boot seeds for settings.

## Decisions and rationale

- **Single Puma process.** The sweeper, worker pool and in-flight counters are in-memory; a second
  process would need shared state for no gain at this request volume.
- **Share id as the only key for pages.** The receiving side is a browser owned by whoever the agent
  is talking to; a login would add friction without adding a second party. Exposure beyond a trusted
  network belongs to a proxy in front (see [`security.md`](security.md)).
- **Fail closed without a token.** `/api` and `/mcp` answer 404, not 401, when `CLOCHE_MCP_TOKEN` is
  unset: an unconfigured instance reveals nothing.
- **Paths are stored resolved and re-checked per request**, because files under a shared folder can
  change between creation and download.
- **Zip via the system `zip` from a symlink mirror** instead of a Ruby zip library: streaming output
  with no temp archive, and the mirror makes "only validated paths" a property of the file system
  rather than of per-entry code.
- **Callbacks are best-effort, one shot.** The authoritative record is the share row; an agent that
  needs certainty calls `wait_share`.
- **Settings in the database, env as seeds.** Changing a timeout should not require a restart or a
  compose edit.
- **External links in their own table, with their own token** (2026-10-21). A second, revocable and
  expiring key lets a share reach people outside the gateway without ending the share to cut them off
  and without ever handing out the `/s` id, which also grants Stop. The gateway exempts `/x` and the
  static assets only.
- **URL prefix per request, not per view** (2026-10-21). The route sets `Share#base_path` (`/s/<id>` or
  `/x/<token>`) and every link the views and the text viewer build follows it, so `/x` reuses the
  gallery, preview and zip code unchanged.
- **Links live only while the share lives, and hold it** (2026-10-21). Stopping a share ends every link;
  a live link keeps the share from idling out, so a link handed out for seven days works for seven days.
  Forms never get links: their answers belong to the agent session.
- **A cap on live links per share** (`external_link_max_live`, 2026-10-21), so the set a share can carry
  stays bounded; revoked and expired links go with the share at retention.
- **Viewers as a registry found by file name** (2026-10-21). Each viewer is one server module in
  `lib/viewers/` and one browser module in `public/js/viewers/`; the server discovers the modules under
  `Viewers::`, the browser imports a module only when one of its tabs opens. Adding a viewer touches no
  shared list, so several can be built in parallel without editing the same lines.
- **Every matching viewer adds tabs** (2026-10-21). A file is not one kind with one view: an SVG is an
  image and a text file, an HTML page renders and has a source. The tab bar is the union of the views of
  every viewer that matches, in priority order; the highest one sets the file's kind and icon. The last
  tab picked is remembered per primary viewer in the browser.
- **One data route for every viewer** (2026-10-21). `?data=<viewer>[&part=<part>]` runs only when that
  viewer matches the file, after the usual `PathGuard` resolution, under `/s` and `/x` alike. The main
  part counts once as a download; parts and media previews do not. Bytes go out with a CSP (`sandbox`
  unless the viewer needs `allow-scripts`) and `nosniff`.
- **Viewer settings declared by the viewer** (2026-10-21). A viewer lists its keys with typed defaults
  and `Setting` merges them in, so a viewer's cap ships with the viewer and changes like any other
  setting. Key names: `<viewer>_view_<what>`.
- **Viewer libraries from a pinned CDN** (2026-10-21). three.js, and the libraries later viewers need,
  load from jsDelivr with the exact version in the URL, only when the viewer opens. The image stays
  small and no JavaScript build step exists.
- **Instruction entry as the default callback mode.** It adds context to the agent's next step
  without producing a visible message or forcing a turn; `synthetic` and `prompt` exist for clients
  that want either.

## Current scope and non-goals

Today cloche serves files from one host over one mount, authenticates agents with one shared bearer
token, and calls back into opencode. It does not authenticate browsers (external links are bearer URLs, not accounts), write to the shared tree,
accept uploads, or notify anything other than an opencode server. Those are the current boundaries of
the implementation, not design limits; the callback module and the settings layer are where new
targets or auth schemes would plug in.

## Operations

- **Logs**: stdout, one global logger (`lib/logger.rb`), subsystem prefixes (`[share]`, `[idle]`,
  `[callback]`, `[zipper]`, `[mcp]`, `[db]`); `LOG_LEVEL` in `.env`; `mcp_debug` setting for raw MCP
  bodies.
- **Health**: `GET /health` → `{status, version, live_shares}`, no auth.
- **State**: `./data/cloche.db` (plus WAL files); back it up with the container stopped or with the
  SQLite backup API. Deleting it resets settings to the seeds.
- **Upgrade**: `docker compose pull && docker compose up -d`; migrations run on boot and are additive,
  so rolling back the image is safe. Image tags: `latest`, `X.Y.Z`, `X.Y`, `sha-<short>` on
  `ghcr.io/rojosinalma/cloche` (`.github/workflows/publish-image.yml`).
