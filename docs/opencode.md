# Connecting an opencode agent

cloche speaks MCP (stateless Streamable HTTP, JSON-RPC over `POST /mcp`) and calls back into the
opencode session that created a share. Both sides are configuration.

## Register the MCP server

Add cloche to `opencode.jsonc` (opencode 2.x shape):

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

`CLOCHE_MCP_TOKEN` must be in opencode's environment when it starts. The tools the agent gets are
listed in [`mcp.md`](mcp.md).

## How the integration works

| Topic | How it works |
|---|---|
| Calling session | opencode sends it in the `tools/call` `_meta` (`ai.opencode/sessionID`); `create_share` picks it up, the agent passes nothing. |
| Callback | When a share ends (or a form is submitted), cloche calls `opencode_url` with Basic auth (`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`). |
| `callback_mode=instruction` (default) | Sets an instruction entry (`callback_entry_key`, default `cloche`) on the session: silent, no chat message; the agent sees it as `<context key="cloche">` at its next step. |
| `callback_mode=synthetic` | Queues a synthetic message (visible bubble). |
| `callback_mode=prompt` | Queues a user message that starts a turn: use it when the agent must react at once. |
| Without MCP | curl `POST /api/shares` with `"session": {"id": "$OPENCODE_SESSION_ID"}` (set in every opencode agent shell); the directory is looked up from opencode. |

## Reaching the opencode server

The default `opencode_url` is `http://host.docker.internal:4096`; `compose.yaml` maps
`host.docker.internal` to the host gateway, so an opencode server listening on the host works out of
the box. For a server elsewhere, change the `opencode_url` setting (see
[`configuration.md`](configuration.md)). Callbacks are off until `OPENCODE_SERVER_PASSWORD` is set.
