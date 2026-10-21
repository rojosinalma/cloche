// Browser check of the diff viewer (git diff, format-patch, diff -u): Unified
// and Side by side tabs next to Raw, per-file folding, caps, files that are no
// diff, /x links, both modes and two skins.
// Run with: bin/test-instance browser <name> diff.js
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
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/diff`], title: 'diff viewer', idle_timeout: 0 });
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
  const tabs = () => page.locator('#preview-tabs:not([hidden]) [data-tab]').allTextContents();
  const pressed = () => page.locator('#preview-tabs [aria-pressed="true"]').textContent().catch(() => null);
  const pane = (view, sel = '') => page.locator(`.preview-view:not([hidden]) .diff-pane[data-pane="${view}"]:not([hidden]) ${sel}`.trim());
  const lastToast = async () => (await page.locator('.t-toast').last().textContent().catch(() => '')) || '';

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await open('change.diff');
  await pane('unified').waitFor();
  check(JSON.stringify(await tabs()) === '["Unified","Side by side","Raw"]', 'diff tabs are Unified, Side by side, Raw');
  check(await pressed() === 'Unified', 'diff opens on Unified');
  check(await page.locator('#preview-badge').textContent() === 'Diff', 'Diff badge');
  check(/5 files · \+6 −5/.test(await page.locator('#preview-stats').textContent()), `file and line counts (${await page.locator('#preview-stats').textContent()})`);
  check(await pane('unified', '.diff-file').count() === 5, 'one card per file');
  check(await pane('unified', '.diff-hunk').count() === 4, 'hunk headers');
  check(await pane('unified', '.diff-line.diff-add').count() === 6 && await pane('unified', '.diff-line.diff-del').count() === 5, '+/- lines marked');
  const badges = await pane('unified', '.diff-file-head .t-badge').allTextContents();
  check(JSON.stringify(badges) === '["added","deleted","renamed"]', `file status badges (${badges})`);
  check(/a\.txt → b\.txt/.test(await pane('unified').textContent()), 'rename shows both names');
  check(await pane('unified', '.diff-meta:text-is("binary")').count() === 1, 'binary file marked');
  check(await pane('unified', '.diff-code:text-is("  def <script>alert(1)</script>")').count() === 1 && await page.locator('.diff-pane script').count() === 0, 'HTML in a diff is text');
  check(await pane('unified', '.diff-note').count() === 1, 'no-newline marker shown');
  await page.screenshot({ path: `${SHOTS}/diff-unified-dark.png` });

  // Fold one file; the fold holds on Side by side.
  await pane('unified', '.diff-file-head').first().click();
  check(await pane('unified', '.diff-file-body').first().isHidden(), 'click on a file head folds it');
  await page.locator('#preview-tabs [data-tab="diff:split"]').click();
  await pane('split').waitFor();
  check(await pane('split', '.diff-file-body').first().isHidden(), 'fold holds on Side by side');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  check(await pane('split', '.diff-file-body').first().isVisible(), 'Unfold every file');
  check(await pane('split', '.diff-empty').count() >= 2, 'Side by side leaves the unmatched side empty');
  const row = pane('split', '.diff-line:has(.diff-del):has(.diff-add)').first();
  check(/initialize\(name\)/.test(await row.locator('.diff-del.diff-half').textContent()) && /punctuation/.test(await row.locator('.diff-add.diff-half').textContent()), 'Side by side pairs old and new');
  await page.screenshot({ path: `${SHOTS}/diff-split-dark.png` });
  await page.locator('.viewer-tools:not([hidden]) [data-role="collapse"]').click();
  check(await pane('split', '.diff-file-body:not([hidden])').count() === 0, 'Fold every file');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .view-pane[data-pane="source"]').waitFor();
  check(await pressed() === 'Raw', 'Raw tab from the text viewer');
  await page.keyboard.press('1');
  check(await pressed() === 'Unified' && await pane('unified').isVisible(), 'key 1 back to Unified');

  await open('0001-Add-a-punctuation-option.patch');
  await pane('unified').waitFor();
  check(await page.locator('#preview-badge').textContent() === 'Patch', 'format-patch badge');
  check(/Subject: \[PATCH\] Add a punctuation option/.test(await pane('unified', '.diff-text').first().textContent()), 'patch message shown above the diff');
  check(await pane('unified', '.diff-file').count() === 1, 'format-patch: one file');

  await open('plain.patch');
  await pane('unified').waitFor();
  check((await pane('unified', '.diff-path').textContent()) === 'notes.txt', 'diff -u: path without timestamps');

  // Not a diff: both tabs dropped, toast, Raw shown.
  await open('notes.patch');
  await page.locator('.preview-view:not([hidden]) .text-card').waitFor();
  check((await tabs()).length === 0 && await pressed() === 'Raw', 'no diff: only Raw left');
  check(/No diff in notes\.patch/.test(await lastToast()), 'no diff: toast says why');

  await setting('diff_view_max_bytes', '100');
  await page.reload();
  await open('change.diff');
  check(/above the 100 B viewer limit/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'byte cap notice');
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .view-pane[data-pane="source"]').waitFor();
  check(true, 'byte cap: Raw still works');
  await setting('diff_view_max_bytes');

  for (const [q, name] of [['mode=light', 'light'], ['skin=bootstrap&mode=light', 'bootstrap-light'], ['skin=bootstrap&mode=dark', 'bootstrap-dark']]) {
    await page.goto(`${share.url}?${q}`);
    await page.evaluate(() => localStorage.removeItem('cloche.preview-tab.diff'));
    await open('change.diff');
    await pane('unified').waitFor();
    await page.screenshot({ path: `${SHOTS}/diff-unified-${name}.png` });
    if (name === 'light') {
      await page.locator('#preview-tabs [data-tab="diff:split"]').click();
      await pane('split').waitFor();
      await page.screenshot({ path: `${SHOTS}/diff-split-light.png` });
      await page.keyboard.press('1');
    }
  }
  await page.keyboard.press('Escape');

  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(`${link.url}?mode=dark`);
  await open('change.diff');
  await pane('unified').waitFor();
  check(await pane('unified', '.diff-file').count() === 5, '/x link: diff');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
