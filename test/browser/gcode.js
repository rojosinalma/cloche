// Browser check of the G-code viewer: Toolpath / Info / Source on plain
// G-code (Bambu, Prusa, Cura), on a .gcode.3mf and on Prusa binary G-code
// (.bgcode, every compression and encoding), the layer range, travel and
// colour controls, broken files (notices), the caps, /x links, both
// themes and two skins. Run with: bin/test-instance browser <name> gcode.js
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
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/gcode`], title: 'viewers gcode', idle_timeout: 0 });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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
  const tab = (view) => page.locator(`#preview-tabs [data-tab="gcode:${view}"]`).click();
  const root = '.preview-view:not([hidden])';
  const visible = (sel) => page.locator(`${root} ${sel}`).first().isVisible();
  const text = (sel) => page.locator(`${root} ${sel}`).first().textContent();
  const toolpath = () => page.waitForFunction(() => {
    const r = document.querySelector('.preview-view:not([hidden])');
    return /layers? ·/.test(document.getElementById('preview-stats').textContent) || (r && !r.querySelector('[data-role="error"]').hidden);
  }, null, { timeout: 30000 }).catch(() => {});
  const stats = () => page.locator('#preview-stats').textContent();
  const infoRow = (label) => page.locator(`${root} .viewer-info-table tr`, { has: page.locator(`th:text-is("${label}")`) }).locator('td').textContent().catch(() => null);
  const infoReady = () => page.locator(`${root} .viewer-info-table tr`).first().waitFor({ timeout: 10000 }).catch(() => {});

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // Plain Bambu G-code: Toolpath, layer range, keys, travel, colour by layer.
  await open('bambu-x2d.gcode');
  check(JSON.stringify(await tabs()) === '["Toolpath","Info","Source"]', 'gcode tabs are Toolpath, Info, Source');
  await toolpath();
  check(/8 layers · [\d,]+ moves/.test(await stats()), `Bambu toolpath: 8 layers (${await stats()})`);
  check(await page.locator('#preview-badge').textContent() === 'G-code', 'G-code badge');
  check(await page.locator(`${root} canvas`).count() === 1, 'one canvas');
  check(/Outer wall/.test(await text('[data-role="legend"]')), 'legend lists the features');
  check(/Layer 8 of 8 · Z 1\.32 mm/.test(await text('[data-role="layer-label"]')), `layer label at the top (${await text('[data-role="layer-label"]')})`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/gcode-toolpath-dark.png` });
  await page.locator(`${root} [data-role="to"]`).evaluate((el) => { el.value = '3'; el.dispatchEvent(new Event('input')); });
  check(/^Layer 4 of 8/.test(await text('[data-role="layer-label"]')), 'To slider picks layer 4');
  await page.locator('#preview-name').click();
  await page.keyboard.press('ArrowDown');
  check(/^Layer 3 of 8/.test(await text('[data-role="layer-label"]')), 'ArrowDown moves the top layer down');
  check(await page.locator('#preview-name').textContent() === 'bambu-x2d.gcode', 'ArrowDown stays on the file');
  await page.locator(`${root} [data-role="from"]`).evaluate((el) => { el.value = '1'; el.dispatchEvent(new Event('input')); });
  check(/^Layers 2–3 of 8/.test(await text('[data-role="layer-label"]')), 'From slider sets the bottom layer');
  await page.locator('.viewer-tools:not([hidden]) [data-role="travel"]').click();
  check(await page.locator('.viewer-tools:not([hidden]) [data-role="travel"]').getAttribute('aria-pressed') === 'true', 'travel toggle');
  await page.locator('.viewer-tools:not([hidden]) .t-segmented-item', { hasText: 'Layer' }).click();
  check(/Layer 1 · Z/.test(await text('[data-role="legend"]')), 'colour by layer shows the layer legend');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/gcode-toolpath-range-dark.png` });
  await page.locator('.viewer-tools:not([hidden]) .t-segmented-item', { hasText: 'Feature' }).click();

  // Info and Source of the same file; switching back keeps the toolpath.
  await tab('info');
  await infoReady();
  check(await infoRow('Printer') === 'Bambu Lab X2D', 'Info: printer');
  check(await infoRow('Estimated time') === '13m 36s', 'Info: estimated time');
  check(await infoRow('Filament weight') === '4.21 g', 'Info: filament weight');
  check(await infoRow('Nozzle temperature') === '220 °C' && await infoRow('Bed temperature') === '55 °C', 'Info: temperatures');
  check(/8 layers/.test(await infoRow('Toolpath') || ''), 'Info: toolpath summary');
  check(!(await page.locator('.viewer-tools:not([hidden]) [data-role="fit"]').isVisible()), 'toolpath tools hidden on Info');
  await page.screenshot({ path: `${SHOTS}/gcode-info-dark.png` });
  await tab('source');
  await page.locator(`${root} .code-lines .line`).first().waitFor();
  check(await page.locator(`${root} .code-lines .line`).count() > 1000, 'Source: lines');
  check(await page.locator(`${root} .code-lines .k`).count() > 100, 'Source: commands highlighted');
  await page.screenshot({ path: `${SHOTS}/gcode-source-dark.png` });
  await tab('toolpath');
  check(await page.locator(`${root} canvas`).count() === 1, 'back on Toolpath: still one canvas');

  // Remembered tab: the next G-code file opens on Source? No: Toolpath was picked last.
  await open('prusa-cube.gcode');
  check(await page.locator('#preview-tabs [aria-pressed="true"]').textContent() === 'Toolpath', 'last tab remembered (Toolpath)');
  await toolpath();
  check(/10 layers/.test(await stats()), `Prusa toolpath: 10 layers (${await stats()})`);
  check(/External perimeter/.test(await text('[data-role="legend"]')), 'Prusa features');
  await tab('info');
  await infoReady();
  check(await infoRow('Printer') === 'MK4S' && /PrusaSlicer 2\.8\.1/.test(await infoRow('Slicer')), 'Prusa info from the end of the file');
  check(await visible('[data-role="thumb"]'), 'Prusa embedded thumbnail');
  await tab('toolpath');
  await open('cura-cube.gcode');
  await toolpath();
  check(/10 layers/.test(await stats()), `Cura toolpath, absolute E: 10 layers (${await stats()})`);

  // Prusa binary G-code: decoded in the worker, Info from the metadata blocks, Source decoded on the server.
  let bgLoads = 0;
  await open('prusa-cube.bgcode');
  check(JSON.stringify(await tabs()) === '["Toolpath","Info","Source"]', 'bgcode tabs are Toolpath, Info, Source');
  await tab('toolpath');
  await toolpath();
  bgLoads++;
  check(/(^|\D)10 layers/.test(await stats()), `bgcode (Heatshrink 12, MeatPack with comments): 10 layers like prusa-cube.gcode (${await stats()})`);
  check(await page.locator('#preview-badge').textContent() === 'Binary G-code', 'Binary G-code badge');
  check(/External perimeter/.test(await text('[data-role="legend"]')), 'bgcode: features from the kept comments');
  check(/Layer 10 of 10 · Z 2\.00 mm/.test(await text('[data-role="layer-label"]')), 'bgcode: layer label');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/gcode-bgcode-dark.png` });
  await tab('info');
  await infoReady();
  check(await infoRow('Printer') === 'MK4S' && /PrusaSlicer 2\.8\.1/.test(await infoRow('Slicer') || ''), 'bgcode Info: printer and slicer from the metadata blocks');
  check(await infoRow('Estimated time') === '9m 41s' && await infoRow('Filament weight') === '1.53 g', 'bgcode Info: print metadata');
  check(await infoRow('Nozzle temperature') === '215 °C' && await infoRow('Bed temperature') === '60 °C', 'bgcode Info: temperatures');
  check(/Heatshrink 12\/4, MeatPack with comments · CRC32/.test(await infoRow('Binary G-code') || ''), `bgcode Info: format (${await infoRow('Binary G-code')})`);
  check(/10 layers/.test(await infoRow('Toolpath') || ''), 'bgcode Info: toolpath summary');
  check(await visible('[data-role="thumb"]'), 'bgcode Info: PNG thumbnail block');
  await page.screenshot({ path: `${SHOTS}/gcode-bgcode-info-dark.png` });
  await tab('source');
  await page.locator(`${root} .code-lines .line`).first().waitFor();
  check(/^M73 P0 R2/.test(await page.locator(`${root} .code-lines .line`).first().textContent()), 'bgcode Source: decoded G-code from the first line');
  check(await page.locator(`${root} .code-lines .line`).count() > 300 && await page.locator(`${root} .code-lines .k`).count() > 200, 'bgcode Source: lines, commands highlighted');
  await page.screenshot({ path: `${SHOTS}/gcode-bgcode-source-dark.png` });
  await tab('toolpath');
  for (const [name, layers, format, what] of [
    ['prusa-cube-hs11.bgcode', 10, /Heatshrink 11\/4, MeatPack · CRC32/, 'Heatshrink 11, MeatPack, layers from Z'],
    ['prusa-cube-deflate.bgcode', 10, /Deflate, no encoding · no checksum/, 'Deflate, no encoding, no checksum'],
    ['prusa-tower.bgcode', 90, /Heatshrink 11\/4, MeatPack with comments/, 'two G-code blocks']
  ]) {
    await open(name);
    await toolpath();
    check(new RegExp(`(^|\\D)${layers} layers`).test(await stats()), `${name} (${what}): ${layers} layers (${await stats()})`);
    await tab('info');
    await infoReady();
    check(format.test(await infoRow('Binary G-code') || ''), `${name}: format row (${await infoRow('Binary G-code')})`);
    if (name === 'prusa-cube-hs11.bgcode') {
      await page.locator(`${root} [data-role="thumb"]`).waitFor();
      check(await page.locator(`${root} [data-role="thumb"]`).evaluate((img) => img.complete && img.naturalWidth === 32), 'QOI thumbnail shown as a 32 px PNG');
      await page.screenshot({ path: `${SHOTS}/gcode-bgcode-qoi-dark.png` });
    }
    await tab('toolpath');
  }
  await open('broken-crc.bgcode');
  await toolpath();
  check(/binary G-code cannot be read: .*CRC32/.test(await text('[data-role="error-text"]')), `bgcode with a bad CRC32: Toolpath notice (${await text('[data-role="error-text"]')})`);
  await tab('source');
  await page.locator(`${root} [data-role="notice"]:not([hidden])`).waitFor({ timeout: 10000 }).catch(() => {});
  check(/CRC32/.test(await text('[data-role="notice"]')), 'bgcode with a bad CRC32: Source notice');
  await tab('info');
  await infoReady();
  check(await infoRow('Printer') === 'MK4S', 'bgcode with a bad CRC32: Info still reads the metadata');
  await tab('toolpath');
  await open('broken-block.bgcode');
  await toolpath();
  check(/unknown block type 9/.test(await text('[data-role="error-text"]')), 'bgcode with an unknown block: Toolpath notice');
  await tab('info');
  await infoReady();
  check(/Unknown block type 9/.test(await text('[data-role="notice"]')) && await infoRow('Printer') === 'MK4S', 'bgcode with an unknown block: Info notice, blocks before it shown');
  await page.screenshot({ path: `${SHOTS}/gcode-bgcode-broken.png` });
  await tab('toolpath');

  // .gcode.3mf: the plate inside, plus the 3D tab of the model viewer.
  await open('bambu.gcode.3mf');
  check(JSON.stringify(await tabs()) === '["Toolpath","Info","Source","3D"]', 'gcode.3mf tabs: Toolpath, Info, Source, 3D');
  await toolpath();
  check(/46 layers/.test(await stats()), `gcode.3mf toolpath: 46 layers (${await stats()})`);
  check(await page.locator('#preview-badge').textContent() === 'G-code 3MF', 'G-code 3MF badge');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/gcode-3mf-dark.png` });
  await tab('info');
  await infoReady();
  check(/^1 of 1/.test(await infoRow('Plate') || ''), 'gcode.3mf Info: plate');
  check(await visible('[data-role="thumb"]'), 'gcode.3mf Info: plate thumbnail');
  await page.screenshot({ path: `${SHOTS}/gcode-3mf-info-dark.png` });
  // Switching to the model viewer's 3D tab and back keeps both mounted.
  await page.locator('#preview-tabs [data-tab="model:model"]').click();
  await page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent) ||
    !document.querySelector('.preview-view:not([hidden]) [data-role="fallback"]')?.hidden, null, { timeout: 20000 }).catch(() => {});
  check(await page.locator('.preview-view[data-viewer="model"]:not([hidden]) canvas').count() === 1, 'gcode.3mf: 3D tab mounts the model viewer');
  await page.screenshot({ path: `${SHOTS}/gcode-3mf-model-dark.png` });
  await tab('toolpath');
  check(/46 layers/.test(await stats()) && await page.locator(`${root} canvas`).count() === 1, 'gcode.3mf: back on Toolpath, stats and canvas kept');

  // Two plates: a picker; every tab follows it.
  await open('two-plates.gcode.3mf');
  await toolpath();
  const plate = page.locator('.viewer-tools:not([hidden]) select[data-role="plate"]');
  check(JSON.stringify(await plate.locator('option').allTextContents()) === '["Plate 1","Plate 2"]', 'two plates: picker');
  check(/External perimeter/.test(await text('[data-role="legend"]')), 'plate 1 is the Prusa toolpath');
  await plate.evaluate((el) => { el.value = '2'; el.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => /WALL-OUTER|Wall outer/.test(document.querySelector('.preview-view:not([hidden]) [data-role="legend"]')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  check(/Wall outer/.test(await text('[data-role="legend"]')), 'plate 2: the Cura toolpath');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/gcode-plates-dark.png` });
  await tab('info');
  check(await page.locator('.viewer-tools:not([hidden]) .t-select-btn').isVisible(), 'plate picker stays on Info');
  await infoReady();
  await page.waitForFunction(() => /2 of 2/.test(document.querySelector('.preview-view:not([hidden]) .viewer-info-table')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check(/^2 of 2/.test(await infoRow('Plate') || '') && /Cura/.test(await infoRow('Slicer') || ''), 'plate 2: Info follows');
  await tab('toolpath');

  // Broken files: notices, no page errors.
  await open('broken.gcode');
  await toolpath();
  check(/No extrusion moves/.test(await text('[data-role="error-text"]')), 'broken G-code: notice');
  await open('broken.gcode.3mf');
  await toolpath();
  check(/cannot be read/.test(await text('[data-role="error-text"]')), `broken gcode.3mf: notice (${await text('[data-role="error-text"]')})`);
  await open('no-plate.gcode.3mf');
  await toolpath();
  check(/no sliced plate/.test(await text('[data-role="error-text"]')), 'gcode.3mf without a plate: notice');
  await tab('info');
  check(/no sliced plate/.test(await text('[data-role="notice"]')), 'gcode.3mf without a plate: Info notice');
  await tab('toolpath');

  // Caps: over gcode_view_max_bytes only Info and Source remain, with a notice.
  await api('PUT', '/api/settings/gcode_view_max_bytes', { value: '1000' });
  await page.reload();
  await open('bambu-x2d.gcode');
  check(JSON.stringify(await tabs()) === '["Info","Source"]', 'over the cap: Info and Source only');
  await infoReady();
  check(/above the 1000 B toolpath limit/.test(await text('[data-role="notice"]')), 'over the cap: notice');
  check(await infoRow('Printer') === 'Bambu Lab X2D', 'over the cap: Info still reads the header');
  await page.screenshot({ path: `${SHOTS}/gcode-cap.png` });
  await api('DELETE', '/api/settings/gcode_view_max_bytes');
  await api('PUT', '/api/settings/gcode_view_source_bytes', { value: '2000' });
  await page.reload();
  await open('bambu-x2d.gcode');
  await tab('source');
  await page.locator(`${root} .code-lines .line`).first().waitFor();
  check(/Showing the first/.test(await text('[data-role="notice"]')) && await page.locator(`${root} .code-lines .line`).count() < 200, 'Source cap: notice and a short head');
  await api('DELETE', '/api/settings/gcode_view_source_bytes');
  await api('PUT', '/api/settings/gcode_view_max_moves', { value: '500' });
  await page.reload();
  await open('bambu-x2d.gcode');
  await tab('toolpath');
  await toolpath();
  check(/move limit/.test(await text('[data-role="notice"]')), 'move cap: notice');
  await api('DELETE', '/api/settings/gcode_view_max_moves');
  await api('PUT', '/api/settings/gcode_view_bgcode_max_bytes', { value: '6000' });
  await page.reload();
  await open('prusa-cube.bgcode');
  await toolpath();
  bgLoads++;
  check(/decode limit/.test(await text('[data-role="notice"]')) && /(^|\D)[1-9] layers? ·/.test(await stats()), `bgcode decode cap: notice, fewer layers (${await stats()})`);
  await api('DELETE', '/api/settings/gcode_view_bgcode_max_bytes');

  // Light mode, and the bootstrap skin.
  for (const q of ['mode=light', 'skin=bootstrap&mode=light', 'skin=bootstrap&mode=dark']) {
    await page.goto(`${share.url}?${q}`);
    await open('bambu.gcode.3mf');
    await toolpath();
    await page.waitForTimeout(300);
    const tag = q.replace(/[=&]/g, '-');
    await page.screenshot({ path: `${SHOTS}/gcode-${tag}.png` });
    await tab('info');
    await infoReady();
    await page.screenshot({ path: `${SHOTS}/gcode-info-${tag}.png` });
    await tab('toolpath');
    await open('prusa-cube.bgcode');
    await toolpath();
    bgLoads++;
    check(/(^|\D)10 layers/.test(await stats()), `bgcode toolpath, ${q}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/gcode-bgcode-${tag}.png` });
    await tab('info');
    await infoReady();
    await page.screenshot({ path: `${SHOTS}/gcode-bgcode-info-${tag}.png` });
    await tab('toolpath');
  }
  await page.goto(`${share.url}?skin=luz&mode=dark`);

  // External link.
  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(link.url);
  await open('prusa-cube.gcode');
  await toolpath();
  check(/10 layers/.test(await stats()), '/x link: toolpath');
  await tab('info');
  await infoReady();
  check(await infoRow('Printer') === 'MK4S', '/x link: info');
  await tab('toolpath');
  await open('prusa-cube.bgcode');
  await toolpath();
  bgLoads++;
  check(/(^|\D)10 layers/.test(await stats()), '/x link: bgcode toolpath');
  await tab('info');
  await infoReady();
  check(await infoRow('Printer') === 'MK4S', '/x link: bgcode info');
  await tab('source');
  await page.locator(`${root} .code-lines .line`).first().waitFor();
  check(await page.locator(`${root} .code-lines .line`).count() > 300, '/x link: bgcode source');
  await tab('toolpath');

  // Downloads: the toolpath fetch counts, Info and Source never.
  const detail = await api('GET', `/api/shares/${share.id}`);
  const counted = detail.downloads.map((d) => d.name);
  console.log('downloads', JSON.stringify(counted));
  const cubeCount = counted.filter((n) => n === 'prusa-cube.gcode').length;
  check(cubeCount === 2, `prusa-cube.gcode counted once per toolpath load (${cubeCount})`);
  // The browser cache may serve a repeated toolpath fetch, so prusa-cube.bgcode counts at most once per load;
  // broken-crc.bgcode had one toolpath load and visits to Info and Source: exactly one count.
  const bgCount = counted.filter((n) => n === 'prusa-cube.bgcode').length;
  check(bgCount >= 1 && bgCount <= bgLoads, `prusa-cube.bgcode counted at most once per toolpath load (${bgCount} of ${bgLoads})`);
  check(counted.filter((n) => n === 'broken-crc.bgcode').length === 1, 'bgcode Info and Source never count');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
