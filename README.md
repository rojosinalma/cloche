# cloche

Hand files from an AI coding agent's machine to your browser, and get told when you looked at them.

<!-- TODO: add screenshot -->
![gallery](docs/screenshot-gallery.png)

An agent creates a **share** (REST or MCP) and gives you a link. You open a gallery page, preview and
download. When the share ends, the agent's [opencode](https://opencode.ai) session gets a silent
note saying how it ended and what you downloaded. Named after the dome a waiter lifts off the plate.

## What it does

- **Shares**: files and folders by absolute host path, any number at once, from any number of sessions.
- **Previews**: images, video, audio, text (highlighted source; Markdown, JSON, JSONL, CSV rendered) and 3D models (STL, 3MF, OBJ) in one modal.
- **Forms**: checklists, radio/select, free text and Markdown task lists you answer in the browser; every Submit reaches the agent.
- **Callback**: the creating opencode session learns when a share ended, why, and what was downloaded.
- **MCP**: a Streamable HTTP MCP server, so agents need no curl and pass no session id.
- **Downloads**: per-file, streamed zip of a share or folder, and a download log (name, time, IP).
- **Idle timeouts**: shares end after 30 min without activity (configurable per share, or never).

## Quick start

```sh
git clone https://github.com/rojosinalma/cloche.git
cd cloche
cp .env.example .env
```

Edit `.env`: set `HOST_HOME` (e.g. `/home/you`) and `CLOCHE_MCP_TOKEN` (`openssl rand -hex 32`);
set `OPENCODE_SERVER_PASSWORD` if you want callbacks. Then:

```sh
docker compose up -d        # pulls ghcr.io/rojosinalma/cloche:latest (or builds with --build)
```

Open <http://localhost:9292> and create a first share:

```sh
curl -s http://localhost:9292/api/shares \
  -H "Authorization: Bearer $CLOCHE_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths": ["/home/you/some/folder"], "title": "Build output"}'
```

```json
{ "ok": true, "message": "Share created", "id": "kX3…", "url": "http://localhost:9292/s/kX3…/", "…": "…" }
```

Open `url`. Data (SQLite) lives in `./data`.

## Connect an agent (opencode)

Register the MCP server in `opencode.jsonc` (opencode 2.x shape):

```jsonc
{
  "mcp": {
    "servers": {
      "cloche": {
        "type": "remote",
        "url": "http://localhost:9292/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:CLOCHE_MCP_TOKEN}" }
      }
    }
  }
}
```

`CLOCHE_MCP_TOKEN` must be in opencode's environment when it starts.

| Topic | How it works |
|---|---|
| Calling session | opencode sends it in the `tools/call` `_meta` (`ai.opencode/sessionID`); `create_share` picks it up, the agent passes nothing. |
| Callback | When a share ends (or a form is submitted), cloche calls `OPENCODE_URL` with Basic auth (`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`). |
| `callback_mode=instruction` (default) | Sets an instruction entry (`callback_entry_key`, default `cloche`) on the session: silent, no chat message; the agent sees it as `<context key="cloche">` at its next step. |
| `callback_mode=synthetic` | Queues a synthetic message (visible bubble). |
| `callback_mode=prompt` | Queues a user message that starts a turn: use when the agent must react at once. |
| Without MCP | curl `POST /api/shares` with `"session": {"id": "$OPENCODE_SESSION_ID"}` (set in every opencode agent shell); the directory is looked up from opencode. |

## Configuration

### Environment (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `CLOCHE_MCP_TOKEN` | — | Bearer for `/api` and `/mcp`; unset = both answer 404 |
| `OPENCODE_SERVER_PASSWORD` | — | Basic auth password for callbacks; unset = callbacks off |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic auth username for callbacks |
| `HOST_HOME` | — (required) | Host home dir; host paths are mounted at the same absolute path |
| `CLOCHE_SHARE_ROOT` | `HOST_HOME` | Host dir bind-mounted read-only into the container |
| `CLOCHE_BIND` | `127.0.0.1` | Host interface of the published port |
| `CLOCHE_PORT` | `9292` | Host port |
| `RACK_ENV` | `production` | `development` = live code reload |
| `LOG_LEVEL` | `info` | Log level |
| `CLOCHE_ROOTS` | `HOST_HOME` | Seed: comma-separated paths agents may share |
| `PUBLIC_BASE_URL` | `http://localhost:9292` | Seed: base of the URLs handed to the user |
| `LAN_BASE_URL` | `PUBLIC_BASE_URL` | Seed: base of the second URL (`lan_url`) |
| `OPENCODE_URL` | `http://host.docker.internal:4096` | Seed: opencode server for callbacks |

Seeds are copied into the settings table on first boot only, when the key does not exist yet.
After that the settings below are what counts.

### Settings

| Key | Default | Meaning |
|---|---|---|
| `allowed_roots` | `CLOCHE_ROOTS` | Paths agents may share (list) |
| `idle_timeout` | `1800` | Seconds idle before a share ends (per-share override possible) |
| `public_base_url` | `PUBLIC_BASE_URL` | Base of `url` |
| `lan_base_url` | `LAN_BASE_URL` | Base of `lan_url` |
| `result_retention` | `86400` | Seconds ended shares and their logs are kept |
| `opencode_url` | `OPENCODE_URL` | opencode server for callbacks |
| `callback_pool_size` | `2` | Callback worker threads |
| `callback_queue_size` | `100` | Pending callbacks before new ones are dropped |
| `callback_open_timeout` | `5` | Callback connect timeout (s) |
| `callback_read_timeout` | `15` | Callback read timeout (s) |
| `callback_mode` | `instruction` | `instruction`, `synthetic` or `prompt` |
| `callback_entry_key` | `cloche` | Instruction entry key in the session |
| `callback_history` | `3` | Shares listed in the instruction entry |
| `wait_max_timeout` | `300` | Cap for `wait` (s) |
| `mcp_debug` | `false` | Log raw MCP request bodies |
| `text_view_max_bytes` | `2097152` | Larger text files are download-only |
| `text_view_max_rows` | `500` | Rows shown of a CSV/TSV table |
| `text_view_sniff_bytes` | `8192` | Bytes read to detect text in unknown file types |
| `model_view_max_bytes` | `104857600` | Larger 3D models are download-only |
| `form_max_fields` | `50` | Fields per form |
| `form_max_options` | `1000` | Options per choice field / task items per task list |
| `form_text_max_chars` | `4000` | Cap for text answers |
| `form_max_bytes` | `524288` | Body cap for form specs, drafts and submits |
| `form_bulk_threshold` | `8` | Options from which a checklist gets filter/all/none tools |
| `form_idle_timeout` | `86400` | Default idle timeout of form shares (s) |
| `instance_name` | container hostname | Reported as `instance` in results and callbacks |

Change a setting without a restart:

```sh
curl -s -X PUT http://localhost:9292/api/settings/idle_timeout \
  -H "Authorization: Bearer $CLOCHE_MCP_TOKEN" -H "Content-Type: application/json" \
  -d '{"value": 900}'
```

Or from an agent: `set_setting({key: "idle_timeout", value: 900})`. `DELETE /api/settings/:key` resets to the default.

## API

All `/api` routes need `Authorization: Bearer $CLOCHE_MCP_TOKEN` and return `{ok, message, …}`.

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/shares` | Create: `{paths[], title?, raw?, idle_timeout?, form?, session?}` → 201 with `url` |
| `GET` | `/api/shares` | Live and recently ended shares |
| `GET` | `/api/shares/:id` | One share: downloads, form/draft/answers, `result` once ended |
| `PATCH` | `/api/shares/:id` | `{idle_timeout}` (seconds, `0` = never); restarts the clock |
| `DELETE` | `/api/shares/:id` | Stop (reason `stopped via api`) |
| `POST` | `/api/shares/:id/wait?timeout=&since=` | Block until ended, a new form submit, or timeout |
| `GET` | `/api/settings` | `{settings: [{key, value, default, source}]}` |
| `PUT` | `/api/settings/:key` | `{value}`; 422 on a bad type, 404 on an unknown key |
| `DELETE` | `/api/settings/:key` | Reset to default |
| `POST` | `/mcp` | MCP (stateless Streamable HTTP, JSON-RPC) |
| `GET` | `/health` | `{status, live_shares}` (no auth) |
| `GET` | `/s/<id>/` | Gallery or form page (the id is the key) |
| `GET` | `/s/<id>/all.zip` | Whole share as a streamed zip |
| `GET` | `/s/<id>/status` | Live state for the open page |
| `POST` | `/s/<id>/stop` | The page's Stop button |
| `PUT` | `/s/<id>/draft` | Save form draft `{answers}` |
| `POST` | `/s/<id>/submit` | Submit form `{answers}`; 422 with per-field `errors` |

### MCP tools

| Tool | Does |
|---|---|
| `create_share` | Share paths (optionally `raw`, `idle_timeout`); returns the `url` |
| `create_form` | Ask questions: `fields[]` (checklist, radio, select, text, tasklist, markdown), optional `paths` |
| `update_share` | Change a live share's `idle_timeout` |
| `list_shares` | Live and recently ended shares |
| `get_share` | One share with downloads, answers, result |
| `stop_share` | End a share now |
| `wait_share` | Block until ended / submitted (`since`) / timeout |
| `get_settings` | All settings with value, default and source |
| `set_setting` | Change one setting (`key`, `value`) |

## Security

| Area | Measure |
|---|---|
| API and MCP | Bearer token; without a configured token they answer 404 (fail closed) |
| Share pages | No auth in the app: the random share id (32 chars) is the key |
| Internet exposure | Not built for it on its own: put it behind your own auth proxy, a VPN or Cloudflare Access. `CLOCHE_BIND` defaults to loopback |
| Paths | Only under `allowed_roots`; `realpath` + containment on create and on every request; `..` and escaping symlinks are refused |
| Zip | Built from a symlink mirror of validated paths only; escaping symlinks are never followed |
| Previews | Served inline with `Content-Security-Policy: sandbox` (an SVG cannot run script) |
| Mounts | Host files are mounted read-only; cloche never writes to them |

## Built for a homelab

cloche was developed for one homelab running opencode and [openchamber](https://github.com/openchamber/openchamber),
and has only been run there. Everything specific to that setup is configuration, so it should work
elsewhere, but it has not been tested on other setups. Issues and pull requests are welcome.

## Browser requirements

A current browser with ES modules and WebGL (3D viewer). Loaded from jsdelivr: Bootstrap 5.3.3,
Bootstrap Icons 1.11.3, three.js 0.186.1.

## Development

| Task | How |
|---|---|
| Live reload | `RACK_ENV=development` in `.env` plus a `compose.override.yaml` that mounts the checkout: `services: {cloche: {volumes: [".:/app"]}}`; code changes apply on the next request |
| Run locally | `bundle install && bundle exec puma -C config/puma.rb` (Ruby 3.3, system `zip`) |
| Database | SQLite at `DATABASE_PATH` (`data/cloche.db`); migrations in `db/migrations` are additive and run on every boot |
| Image | `docker compose up -d --build` |

Single Puma process on purpose: the idle sweeper and transfer counters live in memory.

## License

[MIT](LICENSE)
