// Browser check of the glTF viewer: .glb, .gltf with external buffer and
// texture (?part=), a missing resource and a broken file (notices), the cap,
// /x links, both themes. Run with: bin/test-instance browser <name> gltf.js
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
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/gltf`], title: 'viewers gltf', idle_timeout: 0 });
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
  const visible = (sel) => page.locator(`.preview-view:not([hidden]) ${sel}`).first().isVisible();
  const rendered = () => page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent) ||
    document.querySelector('.preview-view:not([hidden]) .preview-notice'), null, { timeout: 20000 }).catch(() => {});
  const stats = () => page.locator('#preview-stats').textContent();

  for (const mode of ['dark', 'light']) {
    await page.goto(`${share.url}?mode=${mode}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await open('cube.glb');
    await rendered();
    check(/12 triangles/.test(await stats()) && /20 × 20 × 20 mm/.test(await stats()), `${mode}: GLB renders, 12 triangles, 20 mm (${await stats()})`);
    check(await page.locator('#preview-badge').textContent() === 'GLB', `${mode}: GLB badge`);
    check(await visible('.model-swatch-file'), `${mode}: file colours swatch shown`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/gltf-glb-${mode}.png` });
  }

  await page.keyboard.press('Escape');
  await page.locator('a.file-name', { hasText: 'textured' }).first().click();
  await page.locator('.file-name[data-name="crate.gltf"]').first().waitFor();
  await open('crate.gltf');
  await rendered();
  check(/12 triangles/.test(await stats()), `.gltf with external buffer and texture renders (${await stats()})`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/gltf-textured.png` });
  await page.goBack();

  // Graceful failures: notice, no page errors.
  await open('broken.glb');
  await rendered();
  check(await visible('.preview-notice') && /could not be read/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'broken GLB shows a notice');
  await open('missing.gltf');
  await rendered();
  check(await visible('.preview-notice'), 'missing buffer shows a notice');
  await page.screenshot({ path: `${SHOTS}/gltf-missing.png` });
  // The 404 of the missing buffer is the browser's own network log line, not an app error.
  const appErrors = errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e));
  errors.length = 0;
  errors.push(...appErrors);

  // A part outside the share is 404, a traversal too.
  const cube = await page.locator('.file-name[data-name="cube.glb"]').first().getAttribute('data-href');
  const out = await fetch(`${BASE_URL}${cube}?data=gltf&part=${encodeURIComponent('../core/cube.stl')}`);
  check(out.status === 404, `part outside the folder of the file is 404 (${out.status})`);
  const crate = `${share.url.replace(/\/$/, '')}/p/0/textured/crate.gltf`;
  const ok = await fetch(`${crate}?data=gltf&part=${encodeURIComponent('textures/checker.png')}`);
  check(ok.status === 200 && ok.headers.get('content-type') === 'image/png', `part next to the file is served (${ok.status} ${ok.headers.get('content-type')})`);

  // Cap: the standard notice.
  await api('PUT', '/api/settings/gltf_view_max_bytes', { value: '100' });
  await page.reload();
  await open('cube.glb');
  check(/above the 100 B viewer limit/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'gltf cap notice');
  await api('DELETE', '/api/settings/gltf_view_max_bytes');

  // External link.
  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(`${link.url}?mode=dark`);
  await open('cube.glb');
  await rendered();
  check(/12 triangles/.test(await stats()), '/x link: GLB renders');

  const detail = await api('GET', `/api/shares/${share.id}`);
  const counted = detail.downloads.map((d) => d.name);
  check(!counted.some((n) => /checker\.png|crate\.bin/.test(n)), `resources are not counted (${JSON.stringify(counted)})`);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
