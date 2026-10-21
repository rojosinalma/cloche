// Browser check of the STEP viewer: Info only while no cad-render URL is set,
// then 3D through cad-render (convert, cache, model view), a broken file with
// cad-render's reason, an unreachable cad-render, the size cap, /x links and
// both themes. Run with:
//   bin/test-instance up <name> <port> <dir of the CA file>
//   bin/test-instance browser <name> step.js <cad-render URL> [<CA file>]
// Env (set by bin/test-instance): BASE_URL, TOKEN, FIXTURES, SHOTS.
const { chromium } = require('playwright');

const { BASE_URL, TOKEN, FIXTURES, SHOTS = '/tmp' } = process.env;
const [CAD_URL, CA_FILE = ''] = process.argv.slice(2);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const api = async (method, path, body) => {
  const r = await fetch(`${BASE_URL}${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
};
const set = (key, value) => api('PUT', `/api/settings/${key}`, { value });
const reset = (key) => api('DELETE', `/api/settings/${key}`);

(async () => {
  if (!CAD_URL) { console.error('usage: step.js <cad-render URL> [<CA file>]'); process.exit(2); }
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/step`], title: 'viewers step', idle_timeout: 0 });
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
  const root = '.preview-view:not([hidden])';
  const text = (sel) => page.locator(`${root} ${sel}`).first().textContent();
  const visible = (sel) => page.locator(`${root} ${sel}`).first().isVisible();
  const infoRow = (label) => page.locator(`${root} .viewer-info-table tr`, { has: page.locator(`th:text-is("${label}")`) }).locator('td').textContent().catch(() => null);
  const infoReady = () => page.locator(`${root} .viewer-info-table tr`).first().waitFor({ timeout: 10000 }).catch(() => {});
  const model = () => page.waitForFunction(() => /triangles/.test(document.getElementById('preview-stats').textContent) ||
    !document.querySelector('.preview-view:not([hidden]) [data-role="convert-error"]')?.hidden, null, { timeout: 120000 }).catch(() => {});

  // Off by default: Info only, with the notice and a download button.
  await reset('step_view_cad_render_url');
  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await open('bracket.step');
  check((await tabs()).length === 0, 'no cad-render URL: one view, no tab bar');
  await infoReady();
  check(/no cad-render URL/.test(await text('[data-role="notice"]')), 'no cad-render URL: notice');
  check(await visible('[data-role="download"] a'), 'no cad-render URL: download button');
  check(await infoRow('Created with') === 'build123d (Open CASCADE STEP processor 8.0)', 'Info: STEP header');
  check(/^AP214/.test(await infoRow('Schema') || ''), 'Info: schema');
  await page.screenshot({ path: `${SHOTS}/step-off-dark.png` });

  // On: 3D through cad-render.
  await set('step_view_cad_render_url', CAD_URL);
  if (CA_FILE) await set('step_view_cad_render_ca_file', CA_FILE);
  await page.reload();
  await open('bracket.step');
  check(JSON.stringify(await tabs()) === '["3D","Info"]', 'STEP tabs are 3D, Info');
  await model();
  const stats = await page.locator('#preview-stats').textContent();
  check(/triangles · 30 × 20 × 10 mm/.test(stats), `STEP renders through cad-render (${stats})`);
  check(await page.locator('#preview-badge').textContent() === 'STEP', 'STEP badge');
  check(await page.locator(`${root} canvas`).count() === 1, 'one canvas');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/step-3d-dark.png` });
  await page.locator('#preview-tabs [data-tab="step:info"]').click();
  await infoReady();
  await page.waitForFunction(() => /cached/.test(document.querySelector('.preview-view:not([hidden]) .viewer-info-table')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check(/s by cad-render, .* STL, .*\(cached\)/.test(await infoRow('Conversion') || ''), `Info: conversion time, cached (${await infoRow('Conversion')})`);
  check(!(await page.locator('.viewer-tools:not([hidden]) [data-role="reset"]').isVisible()), '3D tools hidden on Info');
  await page.screenshot({ path: `${SHOTS}/step-info-dark.png` });
  await page.locator('#preview-tabs [data-tab="step:model"]').click();
  check(await page.locator('.viewer-tools:not([hidden]) [data-role="reset"]').isVisible(), '3D tools back on 3D');

  // Light mode and the bootstrap skin, from the cache.
  for (const q of ['mode=light', 'skin=bootstrap&mode=light']) {
    await page.goto(`${share.url}?${q}`);
    await open('bracket.step');
    await model();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/step-3d-${q.replace(/[=&]/g, '-')}.png` });
  }
  await page.goto(`${share.url}?skin=luz&mode=dark`);

  // Broken STEP: cad-render's reason, no page error.
  await open('broken.step');
  await model();
  check(/cad-render could not convert this file: .*ERR StepFile/.test(await text('[data-role="convert-error-text"]')), `broken STEP: cad-render's reason (${await text('[data-role="convert-error-text"]')})`);
  await page.screenshot({ path: `${SHOTS}/step-broken.png` });

  // Unreachable cad-render: a notice with the reason.
  await set('step_view_cad_render_url', 'http://127.0.0.1:9');
  await page.reload();
  await open('broken.step');
  await model();
  check(/not reachable/.test(await text('[data-role="convert-error-text"]')), 'unreachable cad-render: notice');
  await set('step_view_cad_render_url', CAD_URL);

  // Cap: above step_view_max_bytes the file has Info only.
  await set('step_view_max_bytes', '1000');
  await page.reload();
  await open('bracket.step');
  await infoReady();
  check((await tabs()).length === 0 && /above the 1000 B STEP conversion limit/.test(await text('[data-role="notice"]')), 'over the cap: Info only, notice');
  await reset('step_view_max_bytes');

  // External link: the cached STL.
  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(link.url);
  await open('bracket.step');
  await model();
  check(/triangles/.test(await page.locator('#preview-stats').textContent()), '/x link: STEP renders');

  const detail = await api('GET', `/api/shares/${share.id}`);
  const counted = detail.downloads.map((d) => d.name);
  console.log('downloads', JSON.stringify(counted));
  check(counted.every((n) => n === 'bracket.step'), 'only the STL fetch of a shown model counts');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await reset('step_view_cad_render_url');
  await reset('step_view_cad_render_ca_file');
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
