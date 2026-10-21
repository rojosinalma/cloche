# Development

| Task | How |
|---|---|
| Live reload | `RACK_ENV=development` in `.env` plus a `compose.override.yaml` that mounts the checkout: `services: {cloche: {volumes: [".:/app"]}}`; code changes apply on the next request (`rack-unreloader`) |
| Run without Docker | `bundle install && bundle exec puma -C config/puma.rb` (Ruby 3.3, system `zip`) |
| Database | SQLite at `DATABASE_PATH` (`data/cloche.db`); migrations in `db/migrations` are additive and run on every boot |
| Image | `docker compose up -d --build` builds from the local `Dockerfile` instead of pulling |
| Syntax check | `ruby -wc app.rb lib/*.rb models/*.rb` |
| Smoke test | `curl -s localhost:9292/health` → `{"status":"ok","version":"0.2.0","live_shares":0}` |
| Test instance | `bin/test-instance up <name> <port>`: a throwaway instance of this checkout (below) |
| Browser check | `bin/test-instance browser <name> viewers-core.js`: the preview modal and the core viewers in Chromium |

## Layout

```
app.rb              Roda app: routes, JSON helpers, page rendering
config.ru           boot: dotenv, unreloader, seeds, idle sweeper
config/puma.rb      single process, 4–16 threads
db/migrations/      Sequel migrations (additive only)
lib/                business logic (share_manager, path_guard, file_server, zipper, form,
                    text_view, listing, preview, callback, mcp_server, idle_sweeper, worker_pool)
lib/viewers/        one module per preview viewer (text, image, video, audio, model, …)
models/             Sequel models: Share, Download, Setting; database.rb opens the DB
views/              ERB templates (layout, gallery, form, preview modal, text card…)
views/viewers/      modal markup per viewer
public/             CSS and browser JS (preview modal shell, form, links)
public/js/viewers/  one browser module per viewer
test/fixtures/      sample files per viewer; test/browser/ Playwright checks
bin/test-instance   throwaway instance for development and browser checks
```

How viewers plug in, and how to add one: [`viewers.md`](viewers.md).

## Test instance

`bin/test-instance` starts a separate container from the published image with this checkout mounted
read-only at `/app` (live reload on), a scratch database under `${TMPDIR:-/tmp}/cloche-test/<name>/`,
its own bearer token, a port on `127.0.0.1`, and `test/fixtures/` (plus any folders you name) as the only
allowed roots. It never reads the checkout's `.env`, so it cannot call back into an opencode server.
Run several at once on distinct names and ports.

```sh
bin/test-instance up dev 9601 ~/Pictures   # start; extra folders are shared read-only
bin/test-instance share dev                # share test/fixtures, print the URL
bin/test-instance share dev ~/Pictures     # share something else
bin/test-instance link dev <share-id>      # external link (/x/<token>/) for that share
bin/test-instance browser dev viewers-core.js
bin/test-instance logs dev
bin/test-instance down dev                 # remove the container and the scratch state
```

`browser` runs a script from `test/browser/` in a Playwright container (`PLAYWRIGHT_IMAGE`, default
`mcr.microsoft.com/playwright:v1.56.1-noble`) on the host network, with `BASE_URL`, `TOKEN`, `FIXTURES`
and `SHOTS` (the scratch folder, for screenshots) in its environment. A script prints one line per check
and exits non-zero on a failure. `CLOCHE_IMAGE` picks another cloche image, `CLOCHE_TEST_DIR` another
scratch root.

Single Puma process on purpose: the idle sweeper, the callback worker pool and the in-flight
transfer counters live in memory and must be shared by every request. See [`SDD.md`](SDD.md) for the
design.
