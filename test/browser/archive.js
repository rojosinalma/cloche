// Browser check of the archive viewer (ZIP, tar in every compression, 7z):
// one Contents tab, folder tree, sizes, caps, unreadable files, /x links, both
// modes and two skins. Run with: bin/test-instance browser <name> archive.js
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
const setting = (key, value) => (value === undefined ? api('DELETE', `/api/settings/${key}`) : api('PUT', `/api/settings/${key}`, { value }));

(async () => {
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/archive`], title: 'archive viewer', idle_timeout: 0 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const open = async (name) => {
    if (await page.locator('#preview').isVisible()) await page.keyboard.press('Escape');
    await page.locator(`.file-name[data-name="${name}"]`).first().click();
    await page.locator('#preview').waitFor({ state: 'visible' });
  };
  const view = (sel) => page.locator(`.preview-view:not([hidden]) ${sel}`);
  const waitRows = () => view('.archive-table tbody tr').first().waitFor();
  const stats = () => page.locator('#preview-stats').textContent();
  const row = (name) => view(`.archive-table tbody tr:has(.archive-label:text-is("${name}"))`).first();

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  for (const [file, badge] of [['sample.zip', 'ZIP'], ['sample.tar', 'TAR'], ['sample.tar.gz', 'TAR.GZ'], ['sample.tgz', 'TGZ'],
    ['sample.tar.bz2', 'TAR.BZ2'], ['sample.tar.xz', 'TAR.XZ'], ['sample.7z', '7Z']]) {
    await open(file);
    await waitRows();
    check(await page.locator('#preview-tabs').isHidden(), `${file}: one view, no tab bar`);
    check(await page.locator('#preview-badge').textContent() === badge, `${file}: badge ${badge}`);
    check(/13 entries · 19\.\d KB uncompressed/.test(await stats()), `${file}: entry count and total size (${await stats()})`);
    check(await row('project').getAttribute('aria-expanded') === 'true' && await row('README.md').isVisible(), `${file}: the single top folder opens`);
    check(await row('naïve file.txt').count() === 0, `${file}: nested folders start folded`);
  }

  await open('sample.zip');
  await waitRows();
  await page.screenshot({ path: `${SHOTS}/archive-zip-dark.png` });
  await row('with space').click();
  check(await row('naïve file.txt').isVisible(), 'click opens a folder');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  check(await row('leaf.txt').isVisible(), 'Expand all opens nested folders');
  check(await view('.archive-table a, .archive-table [download]').count() === 0, 'no per-entry download');
  await page.locator('.viewer-tools:not([hidden]) [data-role="collapse"]').click();
  check(await row('README.md').count() === 0, 'Collapse all folds every folder');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  await page.screenshot({ path: `${SHOTS}/archive-expanded-dark.png` });

  await open('sample.tar.xz');
  await waitRows();
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  check(/README\.md/.test(await row('link-to-readme').textContent()), 'tar symlink shows its target');

  // Unreadable archives: the standard notice with a download button.
  for (const file of ['broken.zip', 'broken.tar.gz']) {
    await open(file);
    await view('.preview-notice').waitFor();
    check(/Cannot list/.test(await view('.preview-notice').textContent()) && await view('.preview-notice .preview-download-link').isVisible(), `${file}: notice with download`);
  }

  // Entry cap: ZIP knows the total, tar does not.
  await setting('archive_view_max_entries', '50');
  await page.reload();
  await open('many.zip');
  await waitRows();
  check(/first 50 of 301 entries/.test(await view('[data-role="notice"]').textContent()), 'ZIP entry cap notice with the total');
  check(/301 entries/.test(await stats()), 'ZIP entry cap keeps the real count');
  await setting('archive_view_max_entries', '5');
  await page.reload();
  await open('sample.tar.gz');
  await waitRows();
  check(/first 5 entries/.test(await view('[data-role="notice"]').textContent()), 'tar entry cap notice');
  await setting('archive_view_max_entries');

  // Byte cap: the modal's notice, nothing fetched.
  await setting('archive_view_max_bytes', '100');
  await page.reload();
  await open('sample.zip');
  check(/above the 100 B viewer limit/.test(await view('.preview-notice').textContent()), 'byte cap notice');
  await setting('archive_view_max_bytes');

  for (const [q, name] of [['mode=light', 'light'], ['skin=bootstrap&mode=light', 'bootstrap-light'], ['skin=bootstrap&mode=dark', 'bootstrap-dark']]) {
    await page.goto(`${share.url}?${q}`);
    await open('sample.zip');
    await waitRows();
    await page.screenshot({ path: `${SHOTS}/archive-zip-${name}.png` });
  }
  await page.keyboard.press('Escape');

  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(`${link.url}?mode=dark`);
  await open('sample.7z');
  await waitRows();
  check(/13 entries/.test(await stats()), '/x link: 7z listing');

  const detail = await api('GET', `/api/shares/${share.id}`);
  check(!detail.downloads.some((d) => /sample\./.test(d.name)), 'listing an archive is not a download');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
