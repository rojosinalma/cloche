# API

All `/api` routes need `Authorization: Bearer $CLOCHE_MCP_TOKEN` and return `{ok, message, …}`.
Without a configured token, `/api` and `/mcp` answer 404.

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
| `POST` | `/mcp` | MCP (stateless Streamable HTTP, JSON-RPC); tools in [`mcp.md`](mcp.md) |
| `GET` | `/health` | `{status, version, live_shares}` (no auth) |
| `GET` | `/s/<id>/` | Gallery or form page (the id is the key) |
| `GET` | `/s/<id>/all.zip` | Whole share as a streamed zip |
| `GET` | `/s/<id>/status` | Live state for the open page |
| `POST` | `/s/<id>/stop` | The page's Stop button |
| `PUT` | `/s/<id>/draft` | Save form draft `{answers}` |
| `POST` | `/s/<id>/submit` | Submit form `{answers}`; 422 with per-field `errors` |

## Creating a share

```sh
curl -s http://localhost:9292/api/shares \
  -H "Authorization: Bearer $CLOCHE_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths": ["/home/you/some/folder"], "title": "Build output", "idle_timeout": 3600}'
```

- `paths` are absolute host paths under `allowed_roots`; `~/` expands against `HOST_HOME`.
- `raw: true` serves exactly one folder as a plain static site; it excludes `form`.
- `idle_timeout` in seconds overrides the global default for this share; `0` keeps it up until stopped.
- `session: {"id": "ses_…", "directory": "/path"}` binds the share to an opencode session for the
  callback; `directory` is optional and looked up from opencode when missing.
- `form` is a form spec (`{intro?, fields[]}`); field kinds are `checklist`, `radio`, `select`,
  `text`, `tasklist` and `markdown`. A form share answers `url` like any other and collects
  `draft`/`answers` on the share.

`wait` returns as soon as the share ends or, for form shares, when a submit newer than `since`
(the `submissions` count you last saw) arrives; `timeout` is capped by the `wait_max_timeout` setting.
