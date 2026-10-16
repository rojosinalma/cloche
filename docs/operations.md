# Operations

## Health

`GET /health` (no auth) answers `{"status":"ok","version":"X.Y.Z","live_shares":N}`. The image's
`HEALTHCHECK` calls it every 30 s, so `docker ps` shows `healthy` once Puma is up.

## User and permissions

The image runs as the unprivileged user `cloche` (uid/gid 1000). `compose.yaml` passes
`user: ${CLOCHE_UID:-1000}:${CLOCHE_GID:-1000}`:

| Situation | What to do |
|---|---|
| `./data` belongs to your account and your uid is 1000 | nothing |
| Your uid is not 1000 | set `CLOCHE_UID`/`CLOCHE_GID` in `.env` to `id -u`/`id -g` |
| `./data` was created by Docker as root | set `CLOCHE_UID=0` and `CLOCHE_GID=0`: the entrypoint `chown`s the data directory to `cloche` and drops to it before Puma starts |

The process never runs as root. The shared tree is mounted read-only, so it only has to be readable
by that uid; `.env` is mounted read-only and has to be readable by it too.

## State and backups

`./data/cloche.db` (plus `-wal`/`-shm`) holds shares, download logs and settings. Back it up with the
container stopped, or online with `sqlite3 data/cloche.db ".backup cloche-backup.db"`. Deleting it
resets the settings to their seeds. Keep it on local disk; SQLite over network filesystems is slow
and prone to locking problems.

## Upgrades

```sh
docker compose pull && docker compose up -d
```

Migrations run on boot and are additive, so rolling back to an older image is safe. Image tags on
`ghcr.io/rojosinalma/cloche`: `latest` (default branch), `X.Y.Z` and `X.Y` (releases), `sha-<short>`.
