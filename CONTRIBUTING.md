# Contributing

Issues and pull requests are welcome.

## Running it locally

```sh
cp .env.example .env            # set HOST_HOME and CLOCHE_MCP_TOKEN
docker compose up -d --build    # builds from the Dockerfile instead of pulling the image
```

For live reload, set `RACK_ENV=development` in `.env` and add a `compose.override.yaml` that mounts
the checkout (`services: {cloche: {volumes: [".:/app"]}}`). Without Docker: Ruby 3.3, the system `zip`
binary, then `bundle install && bundle exec puma -C config/puma.rb`. Details in
[`docs/development.md`](docs/development.md).

## Tests

There is no automated suite yet. `.github/workflows/run-tests.yml` runs the syntax check, boots the
app against a fresh database and validates `compose.yaml` on every pull request. Before a PR, run the
same locally:

```sh
ruby -wc app.rb config.ru lib/*.rb models/*.rb db/migrations/*.rb
curl -s localhost:9292/health
```

and exercise what you changed through the API or the browser (create a share, open it, stop it,
check the callback log line). Tests that cover critical logic — path containment, form validation,
settings typing — are very welcome.

## Code style and layout

- Ruby, Roda, Sequel; `snake_case` methods, `CamelCase` classes, frozen constants, keyword arguments
  for multi-parameter methods.
- Routes in `app.rb` orchestrate (validate → call `lib/` → return JSON); business logic lives in
  `lib/`, schema and model methods in `models/`.
- Every action endpoint returns `{ok, message, …}` via `json_ok`/`json_err`.
- No hardcoded tunables: anything that could need changing is a `Setting` (defaults in
  `models/setting.rb`, documented in `docs/configuration.md`).
- Migrations are additive and run on every boot; never drop or rename a column.
- No unbounded in-memory collections: pools, queues and counters have a cap or an eviction rule.

## Commits and PRs

- Plain, descriptive commit messages in the imperative ("Add form shares", "Fix zip of empty folder").
  No attribution trailers.
- Every commit is signed (GPG or SSH, `git commit -S`, or `commit.gpgsign=true`); `main` only takes
  signed commits.
- One logical change per PR, with the docs updated in the same PR when behaviour or configuration
  changes. Add a line under `[Unreleased]` in `CHANGELOG.md`.

## Documentation

| File | What goes there |
|---|---|
| `README.md` | Description, requirements, installation, usage, development, licence — nothing else |
| `SECURITY.md` | How to report a vulnerability, supported versions |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `docs/configuration.md` | Environment variables and settings |
| `docs/operations.md` | Health check, container user and permissions, backups, upgrades |
| `docs/api.md` | REST endpoints and payloads |
| `docs/mcp.md` | MCP tools |
| `docs/opencode.md` | Registering the MCP server and how callbacks reach a session |
| `docs/security.md` | Threat model and measures |
| `docs/development.md` | Running from source, layout, live reload |
| `docs/SDD.md` | Design: architecture, data model, flows, decisions |
| `CHANGELOG.md` | Keep a Changelog, Semantic Versioning |

## Releasing

1. Bump `Cloche::VERSION` in `lib/version.rb` and move the `[Unreleased]` entries in `CHANGELOG.md`
   under a new version heading with the date; update the compare links.
2. Commit, then create a signed tag and push both: `git tag -s vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.
3. `.github/workflows/publish-image.yml` builds `linux/amd64` and `linux/arm64` and pushes
   `ghcr.io/rojosinalma/cloche:X.Y.Z`, `:X.Y` and `:sha-<short>`; pushes to `main` refresh `:latest`.
4. Create the GitHub release from the tag with the changelog section as its notes:
   `gh release create vX.Y.Z --title "cloche X.Y.Z" --notes-file <section>`.

## License

By contributing you agree that your contribution is licensed under the
[GNU Affero General Public License v3.0](LICENSE), like the rest of the project.
