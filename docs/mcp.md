# MCP tools

`POST /mcp` is a stateless Streamable HTTP MCP server (JSON-RPC, bearer auth, same token as the API).
Registering it in opencode is described in [`opencode.md`](opencode.md). When the client sends the
calling session in `_meta` (`ai.opencode/sessionID`), `create_share` and `create_form` bind the share
to it and the callback reaches that session without the agent passing anything.

| Tool | Does |
|---|---|
| `create_share` | Share paths (optionally `raw`, `idle_timeout`, `title`); returns the `url` |
| `create_form` | Ask questions: `fields[]` (checklist, radio, select, text, tasklist, markdown), optional `paths` shown under the form |
| `update_share` | Change a live share's `idle_timeout` (seconds, `0` = never) |
| `list_shares` | Live and recently ended shares |
| `get_share` | One share with downloads, form, draft, answers, result |
| `stop_share` | End a share now |
| `wait_share` | Block until ended / submitted (`since`) / timeout |
| `get_settings` | All settings with value, default and source |
| `set_setting` | Change one setting (`key`, `value`) |

Tool results are the same JSON documents the REST API returns (`{ok, message, …}`), so an agent can
switch between the two freely. The server's `instructions` text tells the agent the allowed roots,
how the end-of-share callback arrives and when to use `wait_share` instead.

Set the `mcp_debug` setting to `true` to log the raw request bodies while debugging a client.
