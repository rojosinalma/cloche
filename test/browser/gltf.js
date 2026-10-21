// Browser check of the glTF viewer: .glb, .gltf with external buffer and
// texture (?part=), KTX2 textures (in a .glb and next to a .gltf, and the
// notice when the transcoder does not load), Draco and meshopt meshes, an
// unsupported required extension, a missing resource and a broken file
// (notices), the cap, /x links, both themes. Run with: bin/test-instance browser <name> gltf.js
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
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const decoders = () => requests.filter((u) => /libs\/(basis|draco)\/|meshopt_decoder|KTX2Loader|DRACOLoader/.test(u));

  const open = async (name) => {
    if (await page.locator('#preview').isVisible()) await page.keyboard.press('Escape');
    await page.locator(`.file-name[data-name="${name}"]`).first().click();
    await page.locator('#preview').waitFor({ state: 'visible' });
  };
  const visible = (sel) => page.locator(`.preview-view:not([hidden]) ${sel}`).first().isVisible();
  const rendered = () => page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent) ||
    document.querySelector('.preview-view:not([hidden]) .preview-notice'), null, { timeout: 20000 }).catch(() => {});
  const stats = () => page.locator('#preview-stats').textContent();
  const modelNotice = async () => {
    const n = page.locator('.preview-view:not([hidden]) [data-role="notice"]').first();
    return (await n.isVisible()) ? n.textContent() : '';
  };
  // Share of the 3D stage in the texture's orange (230,160,40): the KTX2 checker is on screen.
  // The file's material without its texture is white, so it stays near 0.
  const orange = async () => {
    await page.waitForTimeout(400);
    const png = (await page.locator('.preview-view:not([hidden]) .model-stage').screenshot()).toString('base64');
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] > 80 && d[i] - d[i + 2] > 100) n += 1;
      return n / (d.length / 4);
    }, png);
  };
  const pct = (x) => `${(x * 100).toFixed(1)} %`;

  for (const mode of ['dark', 'light']) {
    await page.goto(`${share.url}?mode=${mode}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    requests.length = 0;
    await open('cube.glb');
    await rendered();
    check(decoders().length === 0, `${mode}: a plain GLB loads no decoder (${decoders().join(', ')})`);
    check(/12 triangles/.test(await stats()) && /20 × 20 × 20 mm/.test(await stats()), `${mode}: GLB renders, 12 triangles, 20 mm (${await stats()})`);
    check(await page.locator('#preview-badge').textContent() === 'GLB', `${mode}: GLB badge`);
    check(await visible('.model-swatch-file'), `${mode}: file colours swatch shown`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/gltf-glb-${mode}.png` });

    requests.length = 0;
    await open('crate-ktx2.glb');
    await rendered();
    check(requests.some((u) => /libs\/basis\/basis_transcoder\.wasm$/.test(u)), `${mode}: the KTX2 GLB loads the Basis transcoder`);
    const glbShare = await orange();
    check(/12 triangles/.test(await stats()) && glbShare > 0.02 && !(await modelNotice()), `${mode}: GLB with a KTX2 texture renders it (${await stats()}, ${pct(glbShare)} orange)`);
    await page.screenshot({ path: `${SHOTS}/gltf-ktx2-${mode}.png` });
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

  // .gltf with its .bin and .ktx2 next to it (?part=).
  await page.keyboard.press('Escape');
  await page.locator('a.file-name', { hasText: /^ktx2\/?$/ }).first().click();
  await page.locator('.file-name[data-name="crate.gltf"]').first().waitFor();
  await open('crate.gltf');
  await rendered();
  const folderShare = await orange();
  check(/12 triangles/.test(await stats()) && folderShare > 0.02, `.gltf with an external .ktx2 renders it (${await stats()}, ${pct(folderShare)} orange)`);
  await page.screenshot({ path: `${SHOTS}/gltf-ktx2-folder.png` });
  await page.goBack();

  // The transcoder does not load: the model shows with plain materials and a notice.
  await page.route('**/examples/jsm/libs/basis/**', (route) => route.abort());
  await open('crate-ktx2.glb');
  await rendered();
  const plainShare = await orange();
  check(/12 triangles/.test(await stats()) && /KTX2 textures could not be decoded/.test(await modelNotice()) && plainShare < 0.005,
    `transcoder blocked: model without textures and a notice (${pct(plainShare)} orange; ${await modelNotice()})`);
  await page.screenshot({ path: `${SHOTS}/gltf-ktx2-blocked.png` });
  await page.unroute('**/examples/jsm/libs/basis/**');

  // Compressed meshes, and an extension the loader does not know.
  for (const name of ['cube-draco.glb', 'cube-meshopt.glb']) {
    await open(name);
    await rendered();
    check(/12 triangles/.test(await stats()) && /20 × 20 × 20 mm/.test(await stats()) && !(await modelNotice()), `${name} renders (${await stats()})`);
  }
  await open('unsupported.gltf');
  await rendered();
  check(/12 triangles/.test(await stats()) && /does not support \(EXT_lights_image_based\)/.test(await modelNotice()),
    `unsupported required extension: model and a notice (${await modelNotice()})`);
  await page.screenshot({ path: `${SHOTS}/gltf-unsupported.png` });

  // Graceful failures: notice, no page errors.
  await open('broken.glb');
  await rendered();
  check(await visible('.preview-notice') && /could not be read/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'broken GLB shows a notice');
  await open('missing.gltf');
  await rendered();
  check(await visible('.preview-notice'), 'missing buffer shows a notice');
  await page.screenshot({ path: `${SHOTS}/gltf-missing.png` });
  // The 404 of the missing buffer is the browser's own network log line, not an app error.
  // The blocked transcoder fails the same way (net::ERR_FAILED).
  const appErrors = errors.filter((e) => !/Failed to load resource: (the server responded with a status of 404|net::ERR_FAILED)/.test(e));
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
  await open('crate-ktx2.glb');
  await rendered();
  const linkShare = await orange();
  check(/12 triangles/.test(await stats()) && linkShare > 0.02, `/x link: KTX2 texture renders (${pct(linkShare)} orange)`);

  const detail = await api('GET', `/api/shares/${share.id}`);
  const counted = detail.downloads.map((d) => d.name);
  check(!counted.some((n) => /checker\.(png|ktx2)|crate\.bin/.test(n)), `resources are not counted (${JSON.stringify(counted)})`);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
