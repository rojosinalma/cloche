# Viewers

Every file in a share opens in the preview modal over the gallery. What the modal can show comes from
viewers: one server module and one browser module per viewer, found by file name, with no list to edit.
A file can match several viewers; each one adds its views, and every view is a tab in the modal bar
(an SVG gets Image and Raw, Markdown gets Pretty and Raw).

## How a file opens

1. The gallery asks every viewer whether it matches the file (`Preview.matching`). The one with the
   highest `priority` is the primary viewer: it sets the file's kind (icon, media grid).
2. The trigger carries `data-viewers`: per matching viewer its id, its data URL and its views.
3. The modal builds one tab per view, in viewer priority order. It opens on the tab last picked for that
   primary viewer (`localStorage` key `cloche.preview-tab.<primary>`), else on the first one.
4. The first time a tab of a viewer becomes active, the modal clones the viewer's template, imports
   `public/js/viewers/<id>.js` and calls its `mount(ctx)`. Switching between tabs of the same viewer
   calls `show(view)`; switching to another viewer hides this one (`hide()`), it stays mounted. Moving to
   another file or closing calls `dispose()` on every mounted viewer.
5. A file over the viewer's size cap never loads: that viewer's tab shows the standard "above the …
   viewer limit" notice with a download button.

Keys: `1`–`9` pick a tab, `←`/`→` move between tabs while focus is in the tab bar (between files
otherwise), `Esc` closes. A viewer can claim keys through its `key(e)` handler.

## Adding a viewer

Files, all new; `<id>` is the viewer id (lower case, `_` between words):

| File | What |
|---|---|
| `lib/viewers/<id>.rb` | Server module `Viewers::<Id>`: match rule, views, settings, data endpoint |
| `public/js/viewers/<id>.js` | Browser module: `export function mount(ctx)` |
| `views/viewers/<id>.erb` | Optional markup: `[data-slot="tools"]` goes into the bar, `[data-slot="body"]` into the stage |
| `test/fixtures/<id>/` | Sample files for the test instance |
| `test/browser/<id>.js` | Optional Playwright check, run with `bin/test-instance browser` |

Shared files get one edit each, in the place prepared for it:

| File | Edit |
|---|---|
| `public/css/app.css` | Rules under the viewer's own `/* viewer: <id> */` marker; add the marker before `/* ─── Form shares` if it is missing |
| `docs/viewers.md` | Settings and notes in the viewer's section under "Viewers" below |
| `CHANGELOG.md` | One line under `[Unreleased]` → `Added` |

A viewer never edits `app.rb`, `lib/listing.rb`, `models/setting.rb` or `public/js/preview.js`. If it
needs something the contract lacks, extend the contract first, on its own.

### Server module

```ruby
# frozen_string_literal: true

module Viewers
  module Html
    extend Preview::Viewer

    RENDERED = Preview::View.new(id: "rendered", label: "Rendered", tip: "The page as a browser shows it")

    def self.icon = "filetype-html"            # tailor sprite name, without "bi-"
    def self.priority = 20                    # text is 10, media and 3D 50
    def self.exts = %w[html htm xhtml]
    def self.views(_target) = [RENDERED]
    def self.settings = { "html_view_max_bytes" => 5 * 1024 * 1024 }
    def self.max_bytes_key = "html_view_max_bytes"

    def self.data(ctx) = ctx.send_file(csp: "sandbox allow-scripts")
  end
end
```

Everything has a default in `Preview::Viewer` (`lib/preview.rb`):

| Method | Default | Meaning |
|---|---|---|
| `id` | from the module name (`GeoJson` → `geo_json`) | Viewer id: file names, `?data=<id>`, CSS marker |
| `kind` | `id.to_sym` | Kind of a file this viewer is primary for |
| `label` | `id.capitalize` | Label of the default single view, and of the viewer in messages |
| `icon` | `file-earmark` | Icon of a file this viewer is primary for |
| `priority` | `0` | Higher first: primary viewer and tab order |
| `exts` | `[]` | Extensions (lower case, no dot) the default `match?` accepts |
| `binary?` | `false` | `true` keeps the text sniffer off these extensions |
| `match?(target)` | `exts.include?(target.ext)` | Override for names or content sniffing |
| `views(target)` | one view `id`/`label` | The tabs, in order; may depend on the file |
| `settings` | `{}` | Setting keys with typed defaults |
| `max_bytes_key` | `nil` | The setting that caps the file size; `nil` = no cap |
| `src(link)` | `"#{link}?data=<id>"` when `data` exists | URL the browser module gets as `ctx.src` |
| `data(ctx)` | none | The data endpoint; absent = the viewer fetches nothing from the server |

`target` (`Preview::Target`) offers `path`, `name`, `basename` (lower case), `ext`, `size` and `text?`,
all lazy. Sniffing reads the file: keep it to a bounded prefix.

### Settings

A viewer declares its keys in `settings`, with typed defaults (Integer, `true`/`false`, Array, String).
`Setting` merges them after its own keys, so `Setting.get`, the settings API and `get_settings` show
them like any other key, and a change applies on the next request. Name them `<id>_view_<what>`
(`html_view_max_bytes`, `archive_view_max_entries`). Two viewers declaring the same key is an error.

### Data route

`GET <file>?data=<id>[&part=<part>]` under `/s/<id>/p/<n>/…` and under `/x/<token>/p/<n>/…` alike.
`gallery_served` re-resolves the path through `PathGuard` first, then `Preview.data` checks that viewer
`<id>` matches the file and has a `data` method, else 404. So a viewer only ever serves files it
matches.

`ctx` (`Preview::Context`) carries `share`, `index`, `rel`, `real` (the resolved path), `name`, `part`,
`params`, `viewer`, `size`, `too_large?` and `download_href`, and answers with:

| Helper | Answer |
|---|---|
| `ctx.send_file(csp: "sandbox", type: nil, count: part.nil?, path: real)` | The bytes, inline, with ranges; the CSP header you pass (`"sandbox"` by default, `nil` for none) and `nosniff` |
| `ctx.html(string, count: part.nil?)` | An HTML fragment, `no-store`, CSP `sandbox` |
| `ctx.json(data, count: part.nil?)` | A JSON body, `no-store` |
| `ctx.render(template, **locals)` | An ERB view rendered to a string (for `ctx.html`) |
| `ctx.count!` | Count the download now (once per request; HEAD and resumed ranges never count) |
| `ctx.not_found!` | The 404 page |

Counting: the main part (no `part`) counts once per fetch, like a download. Secondary parts (a
converted file, a listing page, a thumbnail) pass `count: false`, or use a `part` so the default does it.
Anything the endpoint writes (a converted file, a cache) needs a cap and an eviction rule, and lives in
the container's temp directory, never next to the shared file.

`?text=1` and `?model=1` still work: they are the older spellings of `?data=text` and `?data=model`.

### Browser module

```js
// public/js/viewers/html.js
export function mount(ctx) {
  const frame = ctx.$('[data-role="frame"]');
  frame.src = ctx.src;
  return {
    show(view) { /* one of this viewer's view ids became active */ },
    hide() { /* another viewer's tab is active now */ },
    key(e) { return false; /* true = handled, the modal ignores the key */ },
    dispose() { frame.removeAttribute('src'); }
  };
}
```

`mount` may be `async`. Every handle method is optional. `ctx` gives:

| Field | What |
|---|---|
| `item` | `{ name, href, download, size, format, kind }` of the open file |
| `viewer` | `{ id, views, label, max, max_label }` |
| `src` | The viewer's data URL |
| `view` | The active view id (a getter) |
| `root`, `tools` | The viewer's stage root and its slot in the bar, with the template already in them |
| `$(selector)` | First match in `root`, then in `tools` |
| `box`, `stage` | The modal and its stage, for the rare viewer that needs them |
| `signal` | Aborted on dispose: pass it to `fetch` and `addEventListener` |
| `isActive()` | Whether this viewer's tab is the active one |
| `setBadge(text)`, `setStats(text)` | The badge after the name and the text after the size (`" · 12 lines"`), shown while this viewer is active |
| `hideView(id)` | Drop one of this viewer's tabs for this file (Pretty for JSON that does not parse) |
| `notice(message, icon)` | Replace the root with the standard notice and download button |
| `enhance(element)` | Hand `[data-enhance="<module>"]` elements inside `element` to that module's `enhance(nodes, ctx)` |
| `load(name)` | Import another module from `public/js/viewers/` with its cache-busting URL |
| `icon(name)`, `humanSize(bytes)`, `toast(tone, message)` | Helpers |

Rules:

1. One file per viewer. A helper shared by two of your viewers is a module in `public/js/viewers/` too,
   imported with `await ctx.load('<name>')`: a plain relative `import` skips the cache-busting suffix.
2. Libraries load from jsDelivr with the exact version in the URL, in a constant at the top of the
   module: `const LIB = 'https://cdn.jsdelivr.net/npm/<package>@<x.y.z>/<path>.mjs';`.
   three.js comes from the import map in `views/preview_modal.erb` (`three`, `three/addons/`).
   A library's stylesheet is a `<link>` the module adds once to `document.head`.
3. Markup: `data-role` attributes, never ids (the template is cloned per file). Use the shared classes:
   `.preview-panel` for the standard panel, `.preview-overlay` for a loading or error layer,
   `.file-view-notice` for a notice line, tailor components for the rest.
4. Content from the file never runs on the cloche origin. Rendered HTML and anything with scripts goes
   into an `<iframe sandbox="allow-scripts">` whose `src` is a `?data=` URL served with
   `csp: "sandbox allow-scripts"`, never `allow-same-origin`.
5. Known values are picked, not typed: a tab, a toggle, a slider or a select; a search box is the only
   free text.
6. Check both themes and at least two palettes; colours come from `--t-*` tokens only.

### Enhancing rendered content

A viewer that renders HTML (the text viewer's Markdown, a notebook) can mark parts for another module:
`<div data-enhance="diagram">…</div>`. After rendering it calls `ctx.enhance(container)`; the modal
imports `public/js/viewers/diagram.js` once and calls its `export function enhance(nodes, ctx)`.

## Testing

`bin/test-instance` runs a throwaway instance from your checkout (see [development.md](development.md)):

```sh
bin/test-instance up web 9601            # own container, scratch DB, test/fixtures shared
bin/test-instance share web              # prints the share URL
PLAYWRIGHT_IMAGE=playwright-gpu:1.56.1 \
  bin/test-instance browser web viewers-core.js
bin/test-instance down web
```

Before merging a viewer: `test/browser/viewers-core.js` still passes, your own check passes, and
`ruby -wc` is clean on every Ruby file you touched.

## Viewers

Each viewer's settings and notes live in its own section here.

### text

Matches every file `TextView.text?` accepts: known text extensions and names, else a sniff of the
first bytes (no NUL byte, valid UTF-8). Views: Pretty (Markdown, JSON, JSON Lines, CSV, TSV) and Raw.
Data: `?data=text`, the rendered card; counts once.

| Key | Default | Meaning |
|---|---|---|
| `text_view_max_bytes` | `2097152` | Larger text files are download-only |
| `text_view_max_rows` | `500` | Rows shown of a CSV/TSV table |
| `text_view_sniff_bytes` | `8192` | Bytes read to detect text in unknown file types |

### image, video, audio

Match by extension, priority 50, no settings. They load `?preview=1`, which the gallery thumbnails use
too and which never counts.

### model

STL, 3MF and OBJ in three.js. Data: `?data=model`, the file's bytes; counts once.

| Key | Default | Meaning |
|---|---|---|
| `model_view_max_bytes` | `104857600` | Larger 3D models are download-only |

Other viewers reuse the 3D view: their template renders `viewers/model`, and their module calls
`(await ctx.load('model')).mount(ctx, hooks)`. `hooks.object` is an `Object3D` the viewer parsed itself
(Z up, millimetres; nothing is fetched then), `hooks.keepMaterials` keeps the file's own materials and
textures behind the "colours from the file" swatch, `hooks.setup({ scene, renderer, THREE })` runs once
the renderer exists and may return a cleanup function, and `hooks.notice` is a line of text shown in the
notice bar over the model once it is on screen (something the file holds that the view leaves out).

### html

HTML pages (`.html`, `.htm`, `.xhtml`), priority 20. Views: Rendered; the text viewer adds Raw (the
source). Data: `?data=html`, the page; counts once.

The page loads in an `<iframe sandbox="allow-scripts">` and the response carries
`Content-Security-Policy: sandbox allow-scripts`, so its scripts run in an opaque origin: no cookies, no
storage, no access to the gallery, no top navigation, also when the URL is opened on its own. Relative
references in the page and in its stylesheets (`src`, `href`, `srcset`, `poster`, `url()`, `@import`) are
rewritten to `?data=html&part=<path in the share entry>`: each part goes through `PathGuard`, is served with
the same CSP and `Access-Control-Allow-Origin: *` (module scripts and fonts are CORS requests from the
opaque origin) and never counts. Linked pages and stylesheets are rewritten in turn. A URL a script builds
at run time is not rewritten and reaches the plain file route. A page without a background shows on the
browser's white canvas in both modes.

| Key | Default | Meaning |
|---|---|---|
| `html_view_max_bytes` | `5242880` | Larger pages are not rendered (Raw keeps its own cap); linked pages and stylesheets above it are sent without rewriting |

### pdf

PDFs, priority 20, binary. Views: Document and Info. Data: `?data=pdf`, the file (counts once);
`?data=pdf&part=info`, the details as JSON (never counts).

Document is the browser's built-in viewer (Chromium's, Firefox's pdf.js) in a plain `<iframe>`: a
`sandbox` attribute on the frame blocks the built-in viewer in Chromium, while the response header
`Content-Security-Policy: sandbox` does not, in Chromium or Firefox. The response is `application/pdf` with
`nosniff`, so the bytes never run as a page on this origin. Headless Chromium needs the full build
(`channel: 'chromium'` in Playwright); the headless shell downloads PDFs instead.

Info reads the header, the trailer's `/Info` and the page tree with the standard library: object streams
(PDF 1.5+) are inflated with Zlib within the scan limit. Encrypted files show no title or author (their
strings are encrypted).
The viewer has no modal-level cap so Info stays available for any size; above `pdf_view_max_bytes` the
Document tab shows the limit notice and never fetches the file.

| Key | Default | Meaning |
|---|---|---|
| `pdf_view_max_bytes` | `104857600` | Larger PDFs show Info only |
| `pdf_view_info_max_bytes` | `16777216` | Larger files show the version only in Info; also the most bytes inflated per file |

### notebook

Jupyter notebooks (`.ipynb`, nbformat 4), priority 20. Views: Notebook; the text viewer adds Raw (the
JSON). Data: `?data=notebook`, the rendered cells; counts once. Nothing in the notebook runs.

Markdown cells use the text viewer's renderer (raw HTML escaped, links through the share, diagrams handed
to the diagram module). Code cells are highlighted with Rouge in the kernel's language. Saved outputs:
streams (stderr in the warning colour), errors with the ANSI codes stripped, and per rich output the
first of `text/html`, `text/markdown`, `image/svg+xml`, `image/png`/`jpeg`/`gif`, `application/json`,
`text/plain`. Images are `data:` URLs in `<img>`, so an SVG runs nothing. HTML outputs sit in an
`<iframe sandbox="allow-scripts">` built from `srcdoc`, with a CSP that allows only a per-render nonce
script reporting the height and `data:` images: the notebook's scripts and remote resources stay
blocked. The frame takes the page's colour scheme.

| Key | Default | Meaning |
|---|---|---|
| `notebook_view_max_bytes` | `20971520` | Larger notebooks show Raw only (within the text viewer's cap) |

### diagram

Mermaid (`.mmd`, `.mermaid`) and Graphviz (`.dot`, `.gv`) sources, priority 20. Views: Diagram; the text
viewer adds Raw (the source). Data: `?data=diagram`, the source as plain text; counts once.

Mermaid (`mermaid@12.2.0`) runs with `securityLevel: "strict"` and the `base` theme, its colours taken
from the `--t-*` tokens; it redraws when tailor switches mode, palette or skin. Graphviz
(`@viz-js/viz@3.31.0`, WebAssembly) output loses scripts, `foreignObject`, images, event handlers and
any link that is not http(s); kept links open in a new tab. Graphviz's default black and white follow
the theme in CSS, colours set in the file stay. A source that does not parse shows a notice with the
parser's reason; Raw still shows the source.

The module also exports `enhance(nodes, ctx)`: TextView wraps fenced ` ```mermaid `, ` ```dot ` and
` ```graphviz ` blocks in `<div data-enhance="diagram" data-diagram="mermaid|dot">`, so Markdown files and
notebook Markdown cells draw them. A block that does not draw keeps its code, with a notice above it.

| Key | Default | Meaning |
|---|---|---|
| `diagram_view_max_bytes` | `1048576` | Larger diagram sources show Raw only |

### tree

JSON, JSONC, JSON5, YAML (`.yaml`, `.yml`), TOML and JSON Lines (`.jsonl`, `.ndjson`, one tree per line).
Priority 15, so Tree is the first tab, before the text viewer's Pretty and Raw. The server parses the file
and sends a capped node list (`?data=tree`, counts once; a file that does not parse answers
`{ok: false, message}` and does not count): stdlib JSON (comments and trailing commas for JSONC), Psych's
safe loader for YAML (plain data, dates and symbols only), `tomlrb` for TOML and a small reader in the module
for JSON5. Parsing on the server keeps the node cap ahead of the browser and needs no client library.
Keys keep the file order; numbers travel as text, so large integers keep every digit.

The browser renders lazily (a folded branch has no DOM), filters keys and values (`/` focuses the filter),
expands or collapses everything, and copies a node's path (`.servers[1].host`, `["key with space"]`) on
click. A file that does not parse drops the Tree tab and names the reason in a toast; a JSON Lines line that
does not parse is an error node.

| Key | Default | Meaning |
|---|---|---|
| `tree_view_max_bytes` | `2097152` | Larger files get no tree (Raw still works up to the text limit) |
| `tree_view_max_nodes` | `20000` | Nodes sent; the tree is cut there with a notice |
| `tree_view_max_depth` | `100` | Deeper nesting is refused |
| `tree_view_expand_depth` | `2` | Levels open when the tree loads |
| `tree_view_yaml_aliases` | `false` | Expand YAML aliases and merge keys; off, such a file gets no tree |

### archive

ZIP, tar (`.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`) and 7z. One view, Contents: a read-only folder
tree with sizes, dates, the entry count and the total uncompressed size. Nothing is extracted and no entry is
served. ZIP is read from its central directory in Ruby (ZIP64 included), with no tool and no decompression,
so a zip bomb lists like any other zip. Tar goes through GNU `tar --list`, 7z through `7z l` (the `7zip`
package in the image); both run without stdin, stop at the entry cap and are killed at the time limit.
`?data=archive` answers the listing as JSON and never counts: the listing is not the file.

| Key | Default | Meaning |
|---|---|---|
| `archive_view_max_bytes` | `4294967296` | Larger archives are download-only |
| `archive_view_max_entries` | `10000` | Entries listed; the rest is cut with a notice (ZIP still reports the total) |
| `archive_view_timeout` | `10` | Seconds a `tar` or `7z` listing may run |

### diff

`.diff` and `.patch` files: `git diff`, `git format-patch` (the mail header and message show above the
diff) and `diff -u`. Views Unified (first) and Side by side, next to the text viewer's Raw. The browser
parses the text from `?data=diff` (counts once): file headers with added, deleted, renamed and binary
states, hunk headers, line numbers and +/− counts. Each file folds on its own and the fold holds across both
views. A file with no file header or hunk drops both tabs and says so in a toast.

| Key | Default | Meaning |
|---|---|---|
| `diff_view_max_bytes` | `2097152` | Larger diffs show Raw only |

### ansi

Terminal output with ANSI escapes. `.ansi` files always match; any other text file (`.log`, `.out`, …)
matches when its first `ansi_view_sniff_bytes` hold an escape sequence (`ESC [`), so a log without colours
keeps Raw alone. View Coloured, first, next to the text viewer's Raw. The browser reads the text from
`?data=ansi` (counts once) and applies SGR: the 16 colours map to palette tokens, 256-colour and truecolour
values to the nearest palette hue or grey (so every palette and both modes stay readable); bold, dim,
italic, underline, strike, inverse and hidden. Other escapes (cursor moves, titles, OSC links) are dropped;
a lone carriage return starts the line again. Text goes into the page as text nodes only.

| Key | Default | Meaning |
|---|---|---|
| `ansi_view_max_bytes` | `2097152` | Larger files show Raw only |
| `ansi_view_sniff_bytes` | `4096` | Bytes read to look for escapes in files that are not `.ansi` |

### gltf

glTF 2.0 in the 3D view of the model viewer (its template renders `viewers/model`; `gltf.js` parses with
three.js's `GLTFLoader`, Draco and meshopt included, and calls `model.js` with `hooks.object` and
`hooks.keepMaterials`). glTF is Y up in metres: the scene is turned Z up and scaled to millimetres, so the
size in the bar is right. The file's own materials and textures are the "colours from the file" swatch;
metallic ones get a room environment. Data: `?data=gltf`, the file, counts once;
`?data=gltf&part=<uri>`, a buffer or texture a `.gltf` names, resolved against the file's folder through
`PathGuard`, so it only serves files of the same share entry (a single shared `.gltf` has no
neighbours: its external resources are 404 and the tab shows the notice); never counts. KTX2 textures
are not supported (no transcoder).

| Key | Default | Meaning |
|---|---|---|
| `gltf_view_max_bytes` | `104857600` | Larger glTF files are download-only |

### gcode

Sliced G-code (`.gcode`, `.gco`) and Bambu Studio / Orca Slicer `.gcode.3mf` bundles (a zip with
`Metadata/plate_<n>.gcode`). Priority 60, above the model viewer, so a `.gcode.3mf` opens on Toolpath and
keeps the model viewer's 3D tab as the last one. `binary?` keeps the text viewer's Raw tab off; Source
replaces it at any size.

- Toolpath: the file is parsed in a Web Worker (from a Blob URL; a bundle is unzipped there with fflate).
  Extrusion moves are lines coloured by feature (`; FEATURE:` from Bambu and Orca, `;TYPE:` from
  PrusaSlicer and Cura) or by layer; travel moves on a toggle; a From/To layer range whose top layer
  stays bright while the ones below dim (`↑`/`↓` move the top layer, `Shift` by 10; `F` fits the view;
  `T` toggles travel); the bed outline and grid from the slicer's printable area. Layers follow the slicer's
  layer comments (`; CHANGE_LAYER`, `;LAYER_CHANGE`, `;LAYER:`), else a new Z. `G2`/`G3` arcs (I/J) are
  drawn as 1 mm segments; `G90`/`G91`, `M82`/`M83`, `G92` and `G28` are followed.
- Info: slicer, printer, profiles, time, filament length and weight, layer height, layers, height,
  nozzle, temperatures, bed type and flavour, read on the server from the first and the last
  `gcode_view_info_bytes` (PrusaSlicer writes its settings last), plus the embedded thumbnail (PNG or JPG
  `; thumbnail begin` block, or the bundle's `Metadata/plate_<n>.png`). A bundle with several plates gets
  a plate picker that every tab follows.
- Source: the first `gcode_view_source_bytes` with light highlighting.

Data: `?data=gcode`, the file, counts once (the Toolpath fetch); `&part=info` and `&part=source` (JSON,
`&plate=<n>` for a bundle) never count. Above `gcode_view_max_bytes` the file has Info and Source only, with
a notice; Info still reads the header. Prusa binary G-code (`.bgcode`) is not matched: it needs heatshrink
and MeatPack decoders.

| Key | Default | Meaning |
|---|---|---|
| `gcode_view_max_bytes` | `104857600` | Larger files get no Toolpath (Info and Source only) |
| `gcode_view_max_moves` | `2000000` | Moves (extrusion and travel segments) the Toolpath draws at most; a notice says when it cuts |
| `gcode_view_source_bytes` | `524288` | Bytes of the file the Source tab shows |
| `gcode_view_info_bytes` | `262144` | Bytes read from each end of the file for Info, and the largest thumbnail kept |

### step

STEP (`.step`, `.stp`) as a mesh in the 3D view, converted on the server by cad-render
(`POST <url>/convert`, `file` + `format=stl`). Views: 3D and Info. The conversion starts when the 3D tab
is first shown: `?data=step&part=convert` (JSON) converts or finds the cached STL, and answers with
cad-render's reason on a failure; `?data=step` then sends the STL and counts once; `&part=info` (JSON:
file size, the STEP header, the conversion) never counts. Without a cad-render URL, or above
`step_view_max_bytes`, the file has Info only, with a notice and a download button.

The STL cache lives in the container's temp directory (`$TMPDIR/cloche-step`), keyed by real path, mtime
and size, and is bounded by `step_view_cache_max_bytes` and `step_view_cache_max_files`: the least
recently used entries go first. At most `step_view_max_jobs` conversions run at once (another file gets a
"try again" notice); a second request for a file that is converting waits for it, up to
`step_view_timeout`. The 3D markup is the model viewer's (`viewers/model` in a nested template), mounted
with `hooks.object` once the STL is there. Info rows share `info-table.js` and the `.viewer-info` styles
with gcode.

| Key | Default | Meaning |
|---|---|---|
| `step_view_cad_render_url` | `""` | cad-render base URL; empty = no 3D view for STEP |
| `step_view_cad_render_ca_file` | `""` | Extra CA certificate (PEM path inside the container) for an HTTPS cad-render with a private CA |
| `step_view_timeout` | `120` | Seconds to wait for cad-render (connect, send, answer) |
| `step_view_max_bytes` | `52428800` | Larger STEP files are not sent for conversion (Info only) |
| `step_view_max_jobs` | `2` | Conversions running at once |
| `step_view_cache_max_bytes` | `524288000` | Size of the STL cache; also the largest STL accepted |
| `step_view_cache_max_files` | `200` | Entries in the STL cache |

### geo

GeoJSON (`.geojson`), GPX, KML, and `.json` files whose root object has a GeoJSON `type`
(`FeatureCollection`, `Feature` or a geometry). The `.json` check reads only the first
`geo_view_sniff_bytes` and walks the tokens far enough to find the root's `type` key; it never parses
the whole file. View: Map, before the text viewer's Raw (and Pretty for `.json`). Priority 30, kind
`geo`, icon `map`. Data: `?data=geo`, the file's bytes; counts once.

| Key | Default | Meaning |
|---|---|---|
| `geo_view_max_bytes` | `20971520` | Larger files get no map (Raw follows the text viewer's own cap) |
| `geo_view_max_features` | `10000` | Files with more features show a notice instead of the map |
| `geo_view_max_points` | `200000` | Files with more coordinates (every vertex and every point) show a notice instead of the map |
| `geo_view_sniff_bytes` | `8192` | Bytes of a `.json` file read to look for the root `type` |
| `geo_view_tile_url` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Tile template (`{z}`, `{x}`, `{y}`, `{s}`); empty draws the shapes on the plain background and requests nothing outside |
| `geo_view_tile_attribution` | `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors` | Credit line for the tiles; only text and `http(s)` links are kept |
| `geo_view_tile_max_zoom` | `19` | Deepest zoom the tile server offers |

Notes:

1. Libraries: Leaflet 1.9.4 (`leaflet-src.esm.js` and `leaflet.css`) and @tmcw/togeojson 7.1.3, both
   from jsDelivr, loaded when a Map tab opens.
2. GPX and KML become GeoJSON in the browser with togeojson, not on the server: no XML parser runs in
   cloche, and the file is fetched once either way. The viewer drops any `<!DOCTYPE …>` before it hands
   the text to `DOMParser`, so no entity is declared or fetched; a file that still uses one is refused
   as not well-formed.
3. Tracks and routes are lines, waypoints and placemarks are markers, polygons are filled areas. A
   `GeometryCollection` splits into its parts. Features without a geometry are skipped. Colours come
   from `--t-accent` (lines), `--t-hue-cyan` (areas) and `--t-hue-orange` (points); in dark mode the
   tiles go through a CSS invert filter.
4. A click on a shape opens its properties: the `name` (or `title`) as the heading, the rest as a table,
   all as text. Long values are cut at 300 characters.
5. The tiles load in the viewer's browser, on `/s` and `/x` pages alike, with only the page's origin as
   the referrer. The settings reach the browser as data attributes in `views/viewers/geo.erb`.
6. A file that does not parse, or is not GeoJSON, shows a notice with the download button on the Map
   tab; Raw still shows the source.
