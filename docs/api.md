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
| `GET` | `/api/shares/:id/links` | Every external link of the share, any state |
| `POST` | `/api/shares/:id/links` | Create an external link: `{ttl?}` → 201 with `url` |
| `DELETE` | `/api/shares/:id/links/:link_id` | Revoke one link |
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
| `GET` `POST` | `/s/<id>/links` | The page's Share link dialog: live links, create `{ttl}` |
| `DELETE` | `/s/<id>/links/<link_id>` | The dialog's Revoke |
| `GET` | `/x/<token>/…` | External link: the gallery read-only (no auth; the token is the key) |
| `GET` | `/x/<token>/status` | Live state of the link for the open page |

## Creating a share

```sh
curl -s http://localhost:9292/api/shares \
  -H "Authorization: Bearer $CLOCHE_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths": ["/home/you/some/folder"], "title": "Build output", "idle_timeout": 3600}'
```

- `paths` are absolute host paths under `allowed_roots`; `~/` expands against `HOST_HOME`.
- `raw: true` serves exactly one folder as a plain static site; it excludes `form`.
- `idle_timeout` in seconds overrides the global default for this share; `0` keeps it up until stopped. Agents should only send `0` when the person they work for asks for a share that stays up.
- `session: {"id": "ses_…", "directory": "/path"}` binds the share to an opencode session for the
  callback; `directory` is optional and looked up from opencode when missing.
- `form` is a form spec (`{intro?, fields[]}`); field kinds are `checklist`, `radio`, `select`,
  `text`, `tasklist` and `markdown`. A form share answers `url` like any other and collects
  `draft`/`answers` on the share.

`wait` returns as soon as the share ends or, for form shares, when a submit newer than `since`
(the `submissions` count you last saw) arrives; `timeout` is capped by the `wait_max_timeout` setting.

## External links

An external link is a second key to a file share or a raw share. It opens the same gallery under
`/x/<token>/` (a 43-character random token), read-only: no Stop button, no Share link button, and the
share id appears nowhere on those pages. Use it when the person you send the files to cannot pass
whatever guards `/s/<id>/`. Form shares never get links, because their answers go back to the agent
session.

```sh
curl -s http://localhost:9292/api/shares/$ID/links \
  -H "Authorization: Bearer $CLOCHE_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ttl": 604800}'
```

- `ttl` is in seconds; `0` keeps the link until it is revoked. The names `1h`, `24h`, `7d`, `30d`
  and `never` work too. Without `ttl` the `external_link_default_ttl` setting applies.
- `external_link_max_ttl` (when not `0`) rejects longer links and links without an expiry with 422.
- While a link is live the share does not idle out; its idle clock starts again when the last link
  ends. Stopping the share ends every link.
- Revoked, expired and ended links answer 410 with a page that names nothing of the share; unknown
  tokens answer 404, and so does every `/x` path while `external_links_enabled` is `false`.

A link document:

| Field | Meaning |
|---|---|
| `id` | Link id, for `DELETE …/links/:link_id` |
| `url` | `<public_base_url>/x/<token>/`, the address to hand out |
| `state` | `live`, `revoked`, `expired` or `share ended` |
| `created_at`, `expires_at` | ISO 8601; `expires_at` is `null` for a link that lives until revoked |
| `ttl`, `ttl_label` | Seconds (`0` = until revoked) and the same as text, e.g. `7 days` |
| `revoked_at` | ISO 8601 or `null` |
| `downloads` | Downloads that came through this link |

Errors: 403 when `external_links_enabled` is `false`, 404 for an unknown link, 409 when the share has
ended or already has `external_link_max_live` live links, 422 for a form share or a bad `ttl`.

The share documents carry the links too: the summary (`GET /api/shares`, create, update) lists the
live links under `links`; `GET /api/shares/:id` lists every link and marks each download with
`via` (`share` or `link <id>`); the `result` of a share that ever had a link adds
`external_downloads` and `links`.
