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
textures behind the "colours from the file" swatch, and `hooks.setup({ scene, renderer, THREE })` runs once
the renderer exists and may return a cleanup function.

### html

### pdf

### notebook

### diagram

### tree

### archive

### diff

### ansi

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

### step

### geo
