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
| HTTP app | `app.rb`, `config.ru`, `config/puma.rb` | Roda routes for `/api`, `/mcp`, `/health`, `/s/<id>/…`; JSON helpers `json_ok`/`json_err`; ERB pages in `views/` |
| Share manager | `lib/share_manager.rb` | Create/update/stop shares, validation, result and summary documents, `wait`, retention purge |
| Path guard | `lib/path_guard.rb` | `realpath` + containment against `allowed_roots` on create and on every request |
| File server | `lib/file_server.rb`, `lib/zipper.rb` | Rack::Files-based delivery with range support, download counting, CSP sandbox; streamed zip from a symlink mirror (`zip -r -`) |
| Viewers | `lib/listing.rb`, `lib/text_view.rb`, `lib/model_view.rb`, `public/js/*.js` | Directory listings and MIME kinds; text rendering (Rouge, Redcarpet, CSV); 3D model gating; browser-side preview modal, form UI, three.js viewer |
| Forms | `lib/form.rb` | Form spec normalisation, draft (lenient) and submit (strict) validation |
| MCP server | `lib/mcp_server.rb` | Stateless Streamable HTTP server built on the `mcp` gem; tools wrap the same ShareManager calls as the REST API |
| Callback | `lib/callback.rb`, `lib/worker_pool.rb` | Bounded thread pool delivering end-of-share / submit events to the opencode server |
| Idle sweeper | `lib/idle_sweeper.rb` | One named thread: ends idle shares, keeps in-flight transfer counters, purges expired results |
| Models | `models/database.rb`, `models/share.rb`, `models/download.rb`, `models/setting.rb` | Sequel models over SQLite; `Setting` is the typed runtime config |

How they talk: the browser hits `/s/<id>/…` (no auth; the id is the key) and `/s/<id>/status` for the
live footer. Agents hit `/api/*` or `/mcp` with a bearer token. cloche calls out only to the opencode
server (`opencode_url`) with HTTP Basic auth. Everything else is in-process method calls; there is no
message bus and no second process.

## Data model / storage

SQLite at `DATABASE_PATH` (WAL mode), opened in `models/database.rb`; migrations in `db/migrations/`
run on every boot and are additive only.

- `shares` — `id` (24 random bytes, URL-safe base64), `title`, `raw`, `paths` (JSON list of resolved
  real paths), `session_id`, `session_directory`, `started_at`, `last_activity_at`, `ended_at`,
  `end_reason`, `idle_timeout` (nil = follow the setting, 0 = permanent), and the form columns
  `form`, `draft`, `answers`, `submitted_at`, `submissions`, `draft_saved_at` (JSON text).
- `downloads` — `share_id` (cascade delete), `name`, `ip`, timestamp. Previews and resumed range
  requests are not counted.
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
6. **Retention** — ended shares and their download logs are deleted once `ended_at` is older than
   `result_retention`.

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
- **Instruction entry as the default callback mode.** It adds context to the agent's next step
  without producing a visible message or forcing a turn; `synthetic` and `prompt` exist for clients
  that want either.

## Current scope and non-goals

Today cloche serves files from one host over one mount, authenticates agents with one shared bearer
token, and calls back into opencode. It does not authenticate browsers, write to the shared tree,
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
