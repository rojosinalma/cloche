// Browser check of the preview modal shell and the core viewers (text, image,
// video, audio, model): tabs, remembered tab, keyboard, caps, /x links, both
// themes. Run with: bin/test-instance browser <name> viewers-core.js
// Env (set by bin/test-instance): BASE_URL, TOKEN, FIXTURES, SHOTS.
const { chromium } = require('playwright');

const { BASE_URL, TOKEN, FIXTURES, SHOTS = '/tmp' } = process.env;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const api = async (method, path, body) => {
  const r = await fetch(`${BASE_URL}${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
};

(async () => {
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/core`], title: 'viewers core', idle_timeout: 0 });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const open = async (name) => {
    if (await page.locator('#preview').isVisible()) await page.keyboard.press('Escape');
    await page.locator(`.file-name[data-name="${name}"]`).first().click();
    await page.locator('#preview').waitFor({ state: 'visible' });
  };
  const tabs = () => page.locator('#preview-tabs:not([hidden]) [data-tab]').allTextContents();
  const pressed = () => page.locator('#preview-tabs [aria-pressed="true"]').textContent().catch(() => null);
  const visible = (sel) => page.locator(`.preview-view:not([hidden]) ${sel}`).first().isVisible();

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.screenshot({ path: `${SHOTS}/gallery-dark.png` });

  // Markdown: Pretty / Source tabs, Pretty first, Source remembered across files and reloads.
  await open('readme.md');
  await page.locator('.md-body').waitFor();
  check(JSON.stringify(await tabs()) === '["Pretty","Source"]', 'markdown tabs are Pretty, Source');
  check(await pressed() === 'Pretty', 'markdown opens on Pretty');
  check(await page.locator('#preview-badge').textContent() === 'Markdown', 'markdown badge');
  check(await visible('[data-role="copy"]') || await page.locator('.viewer-tools:not([hidden]) [data-role="copy"]').isVisible(), 'copy button shown');
  await page.screenshot({ path: `${SHOTS}/markdown-pretty-dark.png` });
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  check(await visible('.view-pane[data-pane="source"]') && !(await visible('.view-pane[data-pane="pretty"]')), 'Source tab shows the source pane only');
  await page.keyboard.press('Escape');
  await open('rows.csv');
  await page.locator('.text-card').waitFor();
  check(await pressed() === 'Source', 'Source remembered for the next text file');
  await page.reload();
  await open('readme.md');
  await page.locator('.text-card').waitFor();
  check(await pressed() === 'Source', 'Source remembered after a reload');
  await page.keyboard.press('1');
  check(await pressed() === 'Pretty', 'key 1 picks the first tab');
  await page.locator('#preview-tabs [data-tab="text:pretty"]').focus();
  await page.keyboard.press('ArrowRight');
  check(await pressed() === 'Source', 'ArrowRight inside the tab bar moves to the next tab');
  check(await page.locator('#preview-name').textContent() === 'readme.md', 'ArrowRight inside the tab bar stays on the file');
  await page.keyboard.press('1');

  // JSON that does not parse drops Pretty: one tab, no bar, notice shown.
  await open('broken.json');
  await page.locator('.text-card').waitFor();
  check((await tabs()).length === 0, 'broken JSON has no tab bar');
  check(await visible('.file-view-notice'), 'broken JSON shows the notice');
  check(await visible('.view-pane[data-pane="source"]'), 'broken JSON shows the source');

  await open('rows.csv');
  await page.locator('.csv-table').waitFor();
  check(await visible('.csv-table'), 'CSV renders as a table');

  await open('script.rb');
  await page.locator('.code-lines').waitFor();
  check((await tabs()).length === 0 && await page.locator('#preview-badge').textContent() === 'Ruby', 'code: no tabs, Ruby badge');
  check(/2 lines|5 lines/.test(await page.locator('#preview-stats').textContent()), 'code: line count');

  // Image, and SVG with Image / Source.
  await open('pixel.png');
  await page.waitForFunction(() => document.querySelector('.preview-view:not([hidden]) .preview-image')?.naturalWidth > 0);
  check(true, 'PNG loads');
  await page.keyboard.press('z');
  check(await page.locator('#preview.zoomed').count() === 1, 'z zooms the image');
  await page.keyboard.press('z');
  await open('logo.svg');
  check(JSON.stringify(await tabs()) === '["Image","Source"]', 'SVG tabs are Image, Source');
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .code-lines').waitFor();
  check(await visible('.code-lines'), 'SVG Source shows the source');
  await page.screenshot({ path: `${SHOTS}/svg-raw-dark.png` });
  await page.locator('#preview-tabs [data-tab="image:image"]').click();
  check(await visible('.preview-image'), 'SVG back to Image');

  // Video and audio.
  await open('clip.webm');
  await page.waitForFunction(() => document.querySelector('.preview-view:not([hidden]) video')?.readyState >= 1);
  check(true, 'video loads');
  await open('tone.wav');
  await page.waitForFunction(() => document.querySelector('.preview-view:not([hidden]) audio')?.readyState >= 1);
  check(true, 'audio loads');

  // 3D model.
  await open('cube.stl');
  await page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent) ||
    !document.querySelector('.preview-view:not([hidden]) [data-role="error"]')?.hidden, null, { timeout: 20000 });
  check(/12 triangles/.test(await page.locator('#preview-stats').textContent()), 'STL renders (12 triangles)');
  check(await page.locator('#preview-badge').textContent() === 'STL', 'STL badge');
  check(await page.locator('.preview-view:not([hidden]) canvas').count() === 1, 'one canvas');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/model-dark.png` });

  // ←/→ step through files; Esc closes and clears the hash.
  const before = await page.locator('#preview-name').textContent();
  await page.locator('#preview-stage').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  check(!(await page.locator('#preview').isVisible()) && !page.url().includes('#v='), 'Esc closes and clears #v=');
  await open('readme.md');
  await page.keyboard.press('ArrowRight');
  check(await page.locator('#preview-name').textContent() !== 'readme.md', `ArrowRight moves on (was ${before})`);
  await page.keyboard.press('Escape');

  // Caps: a viewer limit below the file size shows the notice without fetching.
  await api('PUT', '/api/settings/model_view_max_bytes', { value: '100' });
  await page.reload();
  await open('cube.stl');
  check(/above the 100 B viewer limit/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'model cap notice');
  await api('DELETE', '/api/settings/model_view_max_bytes');

  // Deep link with #v= opens the modal.
  const deep = await page.locator('.file-name[data-name="readme.md"]').first().getAttribute('data-href');
  await page.goto(`${share.url}#v=${deep}`);
  await page.locator('.md-body').waitFor();
  check(await page.locator('#preview').isVisible(), 'deep link #v= opens the preview');

  // Light theme screenshots.
  await page.goto(`${share.url}?mode=light`);
  await open('readme.md');
  await page.locator('.md-body').waitFor();
  await page.screenshot({ path: `${SHOTS}/markdown-pretty-light.png` });
  await open('cube.stl');
  await page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/model-light.png` });
  await open('logo.svg');
  await page.screenshot({ path: `${SHOTS}/svg-image-light.png` });
  await page.keyboard.press('Escape');

  // External link: the same modal under /x/<token>/.
  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(link.url);
  await open('readme.md');
  await page.locator('.md-body').waitFor();
  check((await page.locator('.preview-view:not([hidden]) [data-viewer]').count()) >= 0 && await visible('.md-body'), '/x link: markdown preview');
  await open('cube.stl');
  await page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent), null, { timeout: 20000 }).catch(() => {});
  check(/triangles/.test(await page.locator('#preview-stats').textContent()), '/x link: model preview');
  await page.screenshot({ path: `${SHOTS}/x-link-model.png` });

  // Downloads: each viewer fetch counted once, media previews not at all.
  const detail = await api('GET', `/api/shares/${share.id}`);
  const counted = detail.downloads.map((d) => d.name).sort();
  console.log('downloads', JSON.stringify(counted));
  check(!counted.some((n) => /\.(png|svg|webm|wav)$/.test(n) && !/logo\.svg/.test(n)), 'media previews are not counted');

  // Bar layout: the tools are one row that never splits, every row shares one centre, the counter is one
  // line; on a phone the tools sit under the name. Busy bars: tree (filter), gcode (most tools), geo, model.
  const barShare = await api('POST', '/api/shares', { paths: [`${FIXTURES}/tree/config.json`, `${FIXTURES}/gcode/two-plates.gcode.3mf`, `${FIXTURES}/geo/route.geojson`, `${FIXTURES}/core/cube.stl`], title: 'bar layout', idle_timeout: 0 });
  const bars = [['config.json', '.tree-view .tree-item'], ['two-plates.gcode.3mf', '[data-role="toolpath-tools"]:not([hidden])'], ['route.geojson', '[data-role="fit"]:not([disabled])'], ['cube.stl', '[data-role="reset"]:not([disabled])']];
  const barLayout = () => page.evaluate(() => {
    const shown = (e) => e && e.getClientRects().length > 0;
    const mid = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; };
    const rows = (els) => els.map(mid).reduce((out, m) => (out.some((x) => Math.abs(x - m) < 1) ? out : [...out, m]), []);
    const meta = ['#preview-icon', '#preview-name', '#preview-badge', '.preview-bar > .file-size', '#preview-count'].map((s) => document.querySelector(s)).filter(shown);
    const tools = [...document.querySelectorAll('.preview-tools :is(.t-btn, .t-input, .t-segmented, .t-select-btn)')].filter((e) => shown(e) && !e.parentElement.closest('.t-segmented'));
    const rects = tools.map((e) => e.getBoundingClientRect());
    const count = document.createRange(); count.selectNodeContents(document.getElementById('preview-count'));
    return { metaRows: rows(meta), toolRows: rows(tools), countLines: new Set([...count.getClientRects()].map((r) => Math.round(r.top))).size,
             overlap: rects.slice(1).some((r, i) => r.left < rects[i].right - 1.5), left: Math.min(...rects.map((r) => r.left)) };
  });
  for (const skin of ['luz', 'bootstrap']) {
    await page.goto(`${barShare.url}?skin=${skin}&mode=dark`);
    for (const [name, ready] of bars) {
      await page.setViewportSize({ width: 1400, height: 900 });
      await open(name);
      if (name === 'config.json') await page.locator('#preview-tabs [data-tab="tree:tree"]').click();
      await page.locator(`.preview-view:not([hidden]) ${ready}, .viewer-tools:not([hidden]) ${ready}`).first().waitFor({ timeout: 20000 });
      for (const width of [1300, 900, 400]) {
        await page.setViewportSize({ width, height: 700 });
        await page.waitForTimeout(100);
        const l = await barLayout();
        const one = l.metaRows.length === 1 && l.toolRows.length === 1 && Math.abs(l.metaRows[0] - l.toolRows[0]) < 1;
        const under = l.toolRows.length === 1 && l.toolRows[0] > Math.max(...l.metaRows) + 10;
        const ok = l.toolRows.length === 1 && (one || under) && (width > 640 || under) && l.metaRows.length <= (width > 640 ? 1 : 2) && l.countLines === 1 && !l.overlap && l.left >= 0;
        check(ok, `${skin} ${width}px ${name}: ${one ? 'one row' : under ? 'tools under the name' : 'split'} ${JSON.stringify(l)}`);
      }
    }
  }
  // 900px: a JSON tree still fits one row (the filter shrinks first); 400px: the gcode plate list opens unclipped.
  await page.setViewportSize({ width: 900, height: 700 });
  await open('config.json');
  await page.locator('.tree-view .tree-item').first().waitFor();
  const tree900 = await barLayout();
  check(tree900.metaRows.length === 1 && tree900.toolRows.length === 1 && Math.abs(tree900.metaRows[0] - tree900.toolRows[0]) < 1, `900px JSON tree: one bar row ${JSON.stringify(tree900)}`);
  await page.setViewportSize({ width: 400, height: 700 });
  await open('two-plates.gcode.3mf');
  await page.locator('.viewer-tools:not([hidden]) [data-role="toolpath-tools"]:not([hidden])').waitFor({ timeout: 20000 });
  await page.locator('.viewer-tools:not([hidden]) .t-select-btn').click();
  const list = page.locator('.viewer-tools:not([hidden]) .t-select-list');
  await list.waitFor();
  check(await list.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.height > 20 && el.contains(hit); }), '400px: the plate list opens over the stage, not clipped');
  await page.screenshot({ path: `${SHOTS}/bar-gcode-400.png` });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 900 });

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
