# Development

| Task | How |
|---|---|
| Live reload | `RACK_ENV=development` in `.env` plus a `compose.override.yaml` that mounts the checkout: `services: {cloche: {volumes: [".:/app"]}}`; code changes apply on the next request (`rack-unreloader`) |
| Run without Docker | `bundle install && bundle exec puma -C config/puma.rb` (Ruby 3.3, system `zip`) |
| Database | SQLite at `DATABASE_PATH` (`data/cloche.db`); migrations in `db/migrations` are additive and run on every boot |
| Image | `docker compose up -d --build` builds from the local `Dockerfile` instead of pulling |
| Syntax check | `ruby -wc app.rb lib/*.rb models/*.rb` |
| Smoke test | `curl -s localhost:9292/health` → `{"status":"ok","version":"0.2.0","live_shares":0}` |

## Layout

```
app.rb              Roda app: routes, JSON helpers, page rendering
config.ru           boot: dotenv, unreloader, seeds, idle sweeper
config/puma.rb      single process, 4–16 threads
db/migrations/      Sequel migrations (additive only)
lib/                business logic (share_manager, path_guard, file_server, zipper, form,
                    text_view, model_view, listing, callback, mcp_server, idle_sweeper, worker_pool)
models/             Sequel models: Share, Download, Setting; database.rb opens the DB
views/              ERB templates (layout, gallery, form, preview modal, text card…)
public/             CSS and browser JS (preview modal, form, three.js model viewer)
```

Single Puma process on purpose: the idle sweeper, the callback worker pool and the in-flight
transfer counters live in memory and must be shared by every request. See [`SDD.md`](SDD.md) for the
design.
