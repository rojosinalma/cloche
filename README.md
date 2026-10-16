# cloche

Hand files from an AI coding agent's machine to your browser, and get told when you looked at them.

An agent creates a **share** (REST or MCP) of files and folders by absolute host path and gives you a
link. You open a gallery page: images, video, audio, text (highlighted source; Markdown, JSON, JSONL
and CSV rendered) and 3D models (STL, 3MF, OBJ) preview in one modal, every file downloads on its own
or as a streamed zip, and a download log records what went out. A share can also be a **form**
(checklists, radio/select, free text, Markdown task lists) that you answer in the browser, or a **raw**
static site served from one folder. Shares end after an idle timeout (configurable per share, or
never). When a share ends or a form is submitted, the agent's [opencode](https://opencode.ai) session
gets a silent note saying how it ended, what you downloaded or what you answered. The MCP server
means agents need no curl and pass no session id. Named after the dome a waiter lifts off the plate.

![A cloche share: file table with view and download buttons, "Download all" and "Stop serving"](docs/screenshots/gallery.png)

More screenshots (image grid, text viewer, 3D viewer) are in [`docs/screenshots/`](docs/screenshots/).
Configuration, API, MCP tools, security and development notes are documented in [`docs/`](docs/).

## Requirements

- Docker and Docker Compose (the published image is `ghcr.io/rojosinalma/cloche`, linux/amd64 and linux/arm64)
- A current browser with ES modules and WebGL for the 3D viewer; the pages load Bootstrap 5.3.3,
  Bootstrap Icons 1.11.3 and three.js 0.186.1 from jsdelivr
- For callbacks: an opencode 2.x server reachable from the container

## Setup

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

Open `url`. Data (SQLite) lives in `./data`. To let an agent create shares itself, register the MCP
server as described in [`docs/opencode.md`](docs/opencode.md).

## License

[MIT](LICENSE)
