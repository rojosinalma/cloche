# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- External links: a share of files or a raw site can be passed on read-only under `/x/<token>/`, with
  its own random token that never reveals the share id. Each link expires after 1 hour, 24 hours, 7 days,
  30 days or when revoked; a share with a live link does not idle out, and stopping the share ends every
  link. Form shares never get links.
- A "Share link" button on the gallery opens a dialog to pick the expiry, create a link, copy it and revoke
  live links.
- REST `GET`/`POST /api/shares/:id/links`, `DELETE /api/shares/:id/links/:link_id` and the MCP tools
  `create_link`, `list_links`, `revoke_link`.
- Settings `external_links_enabled`, `external_link_default_ttl`, `external_link_max_ttl` and
  `external_link_max_live`.
- The download log marks downloads that came through a link (`via` in the share detail,
  `external_downloads` and `links` in the result).

- The preview modal shows tabs when a file has more than one view, and remembers the last tab picked
  for each kind of file. Keys `1`–`9` pick a tab. SVG files open on Image with a Source tab for the source.
- Viewers are modules: one in `lib/viewers/` and one in `public/js/viewers/` per viewer, found by name,
  with a single data route `?data=<viewer>`. How to add one: `docs/viewers.md`.
- `bin/test-instance` runs a throwaway instance of a checkout for development and browser checks.
- Map viewer for GeoJSON, GPX and KML (and `.json` files that hold GeoJSON): the shapes on OpenStreetMap
  tiles, with their properties on a click; settings `geo_view_*` set the tile server, the caps and more.
- HTML viewer: pages render in a sandboxed frame with their stylesheets, scripts and images, next to Source.
- PDF viewer: Document in the browser's own PDF viewer, and Info with pages, title, author and producer.
- Notebook viewer: Jupyter notebooks with Markdown, highlighted code and saved outputs, never executed.
- Diagram viewer: Mermaid and Graphviz files drawn in the theme's colours, also inside Markdown code blocks.
- Tree viewer for JSON, JSONC, JSON5, YAML, TOML and JSON Lines: a Tree tab with folding, a filter, typed
  values and click-to-copy paths.
- Archive viewer for ZIP, tar (gz, bz2, xz) and 7z: a Contents tab that lists folders, sizes and dates
  without extracting anything.
- Diff viewer for `.diff` and `.patch` files: Unified and Side by side tabs with file and hunk headers and
  per-file folding.
- ANSI viewer for terminal output: a Coloured tab with SGR colours from the palette, for `.ansi` files and
  any text file with escapes.
- glTF files (`.glb`, and `.gltf` with the buffers and textures next to it) open in the 3D view with
  their own materials.
- glTF files with KTX2 (Basis Universal) textures, in a `.glb` or next to a `.gltf`. The transcoder and the
  Draco and meshopt decoders load only when a file needs them; a transcoder that does not load, or a
  required extension the viewer does not know, gives a notice over the model.
- G-code and Bambu Studio / Orca `.gcode.3mf` files open on a Toolpath tab (moves coloured by feature or
  layer, travel moves, a layer range), with Info from the slicer's header and the Source next to it.
- Prusa binary G-code (`.bgcode`) opens in the G-code viewer too: Toolpath, Info from its metadata and
  thumbnail blocks, and the decoded Source (Deflate and Heatshrink, MeatPack, CRC32 checked); setting
  `gcode_view_bgcode_max_bytes` caps the decoded size.
- STEP files open in the 3D view when `step_view_cad_render_url` points at a cad-render service, which
  converts them to STL (cached, with the conversion time on the Info tab); without it they show their header.

### Changed

- The default theme is the luz skin with the Ayu palette (a choice saved in the browser still wins).
- Text Pretty/Source is a tab bar like every other viewer; `?text=1` and `?model=1` still work as older
  spellings of `?data=text` and `?data=model`.
- The tab that shows a file's text is called Source everywhere (it was Raw), the same word the G-code
  viewer uses.

## [0.2.1] - 2026-10-16

### Changed

- Icons come from tailor's subsetted SVG sprite (`public/tailor/icons.svg`, 47 Bootstrap Icons declared with
  `tailor apply --icons`) as `<svg class="t-icon">` elements; the Bootstrap Icons web font and its vendored
  files are gone, so a page loads one small sprite instead of a font and a stylesheet.
- `app.css` dropped the rules that tailor core 0.5.1 now covers: responsive hiding (`t-hide` on the date
  column and the navbar pickers), the row-action cluster (plain buttons in `t-col-actions`), the size/date
  columns on `t-col-shrink`. What stays is cloche's own: the preview overlay, the text viewer, the 3D colour
  rail, the form action bar and the field header.

## [0.2.0] - 2026-10-16

### Changed

- MCP server `instructions` cut to three lines (what cloche is and how to hand over the URL, the automatic
  callback, the idle default); the allowed roots now sit in the `paths` schema of `create_share`/`create_form`
  (refreshed from the live setting on every request) and the viewer, form and housekeeping notes moved into
  the tool descriptions. Clients that inject the instructions into every turn pay ~60 % fewer tokens for it.
- The UI is built on [tailor](https://github.com/rojosinalma/tailor): the vendored `public/tailor/` files
  (core, 8 skins, 21 palettes) replace Bootstrap 5 and the Dracula stylesheet; the pages look the same by
  default (bootstrap skin, Dracula palette) and gain skin and palette pickers plus a light/dark toggle in the
  navbar. Bootstrap Icons are served locally instead of from a CDN.
- Dialogs are native `<dialog>` elements, toasts come from tailor, and the 3D viewer reads its colours from
  the active palette.
- Licence to AGPL-3.0 (was MIT).
- The image runs as the unprivileged user `cloche` (uid 1000) and has a `HEALTHCHECK`; `compose.yaml`
  sets `user:` from `CLOCHE_UID`/`CLOCHE_GID`. Started as root, the entrypoint fixes the data directory's
  ownership and drops privileges before the app starts.
- The base image is pinned to `ruby:3.3.12-slim-trixie`, and the bundle installs from the lockfile
  (now with `aarch64-linux-gnu`).

### Added

- `GET /health` reports `version`.
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, Dependabot for Bundler,
  GitHub Actions and Docker.
- A `run-tests` workflow: syntax check, boot smoke test and `compose.yaml` validation on every pull request.
- `docs/operations.md`: health check, container user and permissions, backups, upgrades.

### Upgrade notes

- The container no longer runs as root. If `./data` belongs to root, or your uid is not 1000, see
  [`docs/operations.md`](docs/operations.md) → "User and permissions" before upgrading.

## [0.1.0] - 2026-10-16

First public release.

### Added

- Shares: agents share files and folders by absolute host path over REST or MCP and get a URL to hand out.
- Gallery page: image/video/audio previews, folder navigation with breadcrumbs, per-file downloads, Stop button, idle countdown, light/dark theme.
- Raw shares: serve one folder as a plain static site (HTML renders, relative links work).
- Text viewer: syntax highlighting for any text file, pretty forms for Markdown (GFM), JSON, JSONL and CSV/TSV.
- 3D viewer: STL, 3MF (incl. Bambu Studio / Orca projects) and OBJ in the browser with three.js.
- Preview modal: one overlay for every previewable file, keyboard navigation and `#v=` deep links.
- Form shares: checklists, radio/select, text, Markdown task lists and static Markdown; server-side drafts, resubmittable Submit.
- Callbacks into the creating opencode session when a share ends or a form is submitted, in three modes: `instruction`, `synthetic`, `prompt`.
- MCP server (stateless Streamable HTTP): `create_share`, `create_form`, `update_share`, `list_shares`, `get_share`, `stop_share`, `wait_share`, `get_settings`, `set_setting`.
- Settings API: `GET /api/settings`, `PUT /api/settings/:key`, `DELETE /api/settings/:key`; changes apply without a restart.
- Per-share idle timeouts, including permanent shares (`idle_timeout: 0`).
- Streamed zip downloads of a whole share or one folder; escaping symlinks are never followed.
- Download log per share (name, time, IP); previews and resumed range requests are not counted.
- Docker image published to GHCR (`ghcr.io/rojosinalma/cloche`) by GitHub Actions.

[Unreleased]: https://github.com/rojosinalma/cloche/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/rojosinalma/cloche/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rojosinalma/cloche/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rojosinalma/cloche/releases/tag/v0.1.0
