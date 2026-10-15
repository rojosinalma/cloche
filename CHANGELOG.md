# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-16

First public release.

### Added

- Shares: agents share files and folders by absolute host path over REST or MCP and get a URL for the user.
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

[Unreleased]: https://github.com/rojosinalma/cloche/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rojosinalma/cloche/releases/tag/v0.1.0
