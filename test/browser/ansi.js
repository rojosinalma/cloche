// Browser check of the ANSI viewer: Coloured tab next to Source for files with
// escapes, colours from palette tokens, escaped text, stripped controls, caps,
// sniffing, /x links, both modes and two skins.
// Run with: bin/test-instance browser <name> ansi.js
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
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/ansi`], title: 'ansi viewer', idle_timeout: 0 });
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
  const lines = (sel = '') => page.locator(`.preview-view:not([hidden]) .ansi-lines ${sel}`.trim());
  const waitLines = () => lines('.line').first().waitFor();

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await open('build.log');
  await waitLines();
  check(JSON.stringify(await tabs()) === '["Coloured","Source"]', 'log with escapes: Coloured, Source');
  check(await pressed() === 'Coloured', 'opens on Coloured');
  check(await page.locator('#preview-badge').textContent() === 'ANSI', 'ANSI badge');
  check(/13 lines/.test(await page.locator('#preview-stats').textContent()), 'line count');
  const text = await lines().textContent();
  check(!/\x1b/.test(text), 'no escape byte left in the text');
  check(text.includes("<script>alert('x')</script>") && await page.locator('.ansi-lines script').count() === 0, 'HTML in the log is text');
  check(await lines('.line:has-text("progress")').textContent() === 'progress 100%', 'carriage return redraws the line');
  check(/OSC link example kept as text/.test(text) && /cursor moves stripped/.test(text), 'other escapes stripped, text kept');
  const tone = await page.evaluate(() => {
    const span = document.querySelector('.preview-view:not([hidden]) .ansi-f-red');
    const probe = document.createElement('span');
    probe.style.color = 'var(--t-hue-red)';
    document.body.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return { got: getComputedStyle(span).color, want };
  });
  check(tone.got === tone.want, `red comes from --t-hue-red (${tone.got})`);
  check(await lines('.ansi-bold').count() >= 3 && await lines('.ansi-u').count() >= 1 && await lines('.ansi-italic').count() === 1 && await lines('.ansi-s').count() === 1, 'bold, underline, italic, strike');
  check(await lines('.ansi-i-default.ansi-f-canvas').count() === 1, 'inverse');
  check(await lines('.line:has-text("256:") .ansi-f-orange').count() >= 1 && await lines('.line:has-text("true:") .ansi-f-blue').count() >= 1, '256 and truecolour map to palette hues');
  check(await lines('.line:has-text("colon form") .ansi-f-red').count() === 1, 'colon-separated colours');
  await page.screenshot({ path: `${SHOTS}/ansi-dark.png` });

  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .view-pane[data-pane="source"]').waitFor();
  check(await pressed() === 'Source' && await lines().isHidden(), 'Source tab');
  await page.keyboard.press('1');
  check(await pressed() === 'Coloured' && await lines().isVisible(), 'key 1 back to Coloured');

  await open('plain.log');
  await page.locator('.preview-view:not([hidden]) .text-card').waitFor();
  check((await tabs()).length === 0 && await pressed() === 'Source', 'log without escapes: Source only');
  for (const file of ['job.out', 'art.ansi', 'notes.txt']) {
    await open(file);
    await waitLines();
    check(await pressed() === 'Coloured', `${file}: Coloured`);
  }

  // Sniff window: an escape past it is not seen.
  await setting('ansi_view_sniff_bytes', '10');
  await page.reload();
  await open('notes.txt');
  await page.locator('.preview-view:not([hidden]) .text-card').waitFor();
  check((await tabs()).length === 0, 'escape past the sniff window: Source only');
  await setting('ansi_view_sniff_bytes');

  await setting('ansi_view_max_bytes', '100');
  await page.reload();
  await open('build.log');
  check(/above the 100 B viewer limit/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'byte cap notice');
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .view-pane[data-pane="source"]').waitFor();
  check(true, 'byte cap: Source still works');
  await setting('ansi_view_max_bytes');

  for (const [q, name] of [['mode=light', 'light'], ['skin=bootstrap&mode=light', 'bootstrap-light'], ['skin=bootstrap&mode=dark', 'bootstrap-dark'], ['palette=gruvbox&mode=dark', 'gruvbox-dark']]) {
    await page.goto(`${share.url}?${q}`);
    await page.evaluate(() => localStorage.removeItem('cloche.preview-tab.ansi'));
    await open('build.log');
    await waitLines();
    await page.screenshot({ path: `${SHOTS}/ansi-${name}.png` });
  }
  await page.keyboard.press('Escape');

  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(`${link.url}?mode=dark`);
  await open('build.log');
  await waitLines();
  check(await lines('.ansi-f-red').count() >= 1, '/x link: coloured log');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
