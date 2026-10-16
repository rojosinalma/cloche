# Configuration

Two layers: environment variables in `.env` (read by compose for interpolation and by the app with
dotenv) and runtime settings in the database, changed over the API without a restart.

## Environment (`.env`)

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
| `DATABASE_PATH` | `data/cloche.db` | SQLite file (set by `compose.yaml` to `/app/data/cloche.db`) |
| `CLOCHE_ROOTS` | `HOST_HOME` | Seed: comma-separated paths agents may share |
| `PUBLIC_BASE_URL` | `http://localhost:9292` | Seed: base of the URLs handed out |
| `LAN_BASE_URL` | `PUBLIC_BASE_URL` | Seed: base of the second URL (`lan_url`) |
| `OPENCODE_URL` | `http://host.docker.internal:4096` | Seed: opencode server for callbacks |

Seeds are copied into the settings table on first boot only, when the key does not exist yet.
After that the settings below are what counts.

## Settings

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

Or from an agent: `set_setting({key: "idle_timeout", value: 900})`. `DELETE /api/settings/:key`
resets to the default; `GET /api/settings` lists every key with value, default and source.

## Sharing more than one tree

The container sees host paths at the same absolute path. `CLOCHE_SHARE_ROOT` (default `HOST_HOME`)
is the one tree `compose.yaml` mounts read-only; `allowed_roots` narrows what may be shared out of it.
Every extra root outside that tree needs its own `:ro` bind at the same path in a compose override
and an entry in `allowed_roots`.
