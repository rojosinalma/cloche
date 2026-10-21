// Browser check of the tree viewer (JSON, JSONC, JSON5, YAML, TOML, JSON
// Lines): tabs, expansion, filter, path copy, caps, malformed files, /x links,
// both modes and two skins. Run with: bin/test-instance browser <name> tree.js
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
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/tree`], title: 'tree viewer', idle_timeout: 0 });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
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
  const tree = (sel = '') => page.locator(`.preview-view:not([hidden]) .tree-view ${sel}`.trim());
  const waitTree = () => tree('.tree-item').first().waitFor();
  const keyLine = (key) => tree(`.tree-line:has(> .tree-key:text-is("${key}"))`).first();
  const lastToast = async () => (await page.locator('.t-toast').last().textContent().catch(() => '')) || '';
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // JSON: Tree first, then text's Pretty and Raw.
  await open('config.json');
  await waitTree();
  check(JSON.stringify(await tabs()) === '["Tree","Pretty","Raw"]', 'JSON tabs are Tree, Pretty, Raw');
  check(await pressed() === 'Tree', 'JSON opens on Tree');
  check(await page.locator('#preview-badge').textContent() === 'JSON', 'JSON badge');
  check(/36 nodes/.test(await page.locator('#preview-stats').textContent()), 'node count in the stats');
  const keys = await tree('> .tree-item > .tree-line > .tree-key').allTextContents();
  check(keys.indexOf('2') < keys.indexOf('1') && keys[0] === 'name', `keys keep the file order (${keys.slice(0, 7).join(',')})`);
  check(await keyLine('nested').isVisible(), 'two levels open by default');
  check(await tree('.tree-key:text-is("deeper")').count() === 0, 'deeper levels stay folded (no DOM)');
  check(await tree('.tree-val[data-type="s"]:text-is("\\"<script>alert(\'not run\')</script>\\"")').count() === 1, 'HTML in a string is text');
  check(await tree('.tree-val[data-type="n"]:text-is("123456789012345678901234567890")').count() === 1, 'big integer keeps every digit');
  await page.screenshot({ path: `${SHOTS}/tree-json-dark.png` });

  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  check(await tree('.tree-val:text-is("\\"hidden by default\\"")').isVisible(), 'Expand all opens every branch');
  await page.locator('.viewer-tools:not([hidden]) [data-role="collapse"]').click();
  check(await tree('.tree-key:text-is("host")').count() === 0 && await keyLine('servers').isVisible(), 'Collapse all folds to the top keys');
  await keyLine('servers').locator('.tree-toggle').click();
  check(await tree('.tree-key[data-index]').count() === 2, 'toggle opens one branch');

  // Click copies the path, with a toast.
  await keyLine('key with space').click();
  check(await clipboard() === '["key with space"]', 'path of a key with a space');
  check(/Copied \["key with space"\]/.test(await lastToast()), 'copy toast');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  await tree('.tree-val:text-is("\\"beta\\"")').click();
  check(await clipboard() === '.servers[1].host', `path of a nested value (${await clipboard()})`);

  // Filter: keys and values, matches marked, other branches hidden.
  await page.keyboard.press('/');
  check(await page.evaluate(() => document.activeElement?.dataset.role === 'search'), '/ focuses the filter');
  await page.keyboard.type('alpha');
  await page.waitForTimeout(400);
  check(/2 matches/.test(await page.locator('#preview-stats').textContent()), 'filter counts the matches');
  check(await tree('.tree-mark').count() >= 1 && await tree('.tree-key:text-is("limits")').count() === 0, 'filter marks the match and hides the rest');
  await page.screenshot({ path: `${SHOTS}/tree-filter-dark.png` });
  await page.fill('.viewer-tools:not([hidden]) [data-role="search"]', 'zzz-none');
  await page.waitForTimeout(400);
  check(await tree('.tree-none').isVisible(), 'filter without matches says so');
  await page.fill('.viewer-tools:not([hidden]) [data-role="search"]', '');
  await page.waitForTimeout(400);
  check(await keyLine('limits').isVisible(), 'empty filter shows the whole tree again');

  // Tab switching: Raw and back, the tree stays mounted.
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .view-pane[data-pane="source"]').waitFor();
  check(await pressed() === 'Raw' && !(await tree().isVisible()), 'Raw tab hides the tree');
  await page.keyboard.press('1');
  check(await pressed() === 'Tree' && await tree().isVisible(), 'key 1 back to Tree');

  // Other formats.
  await open('compose.yaml');
  await waitTree();
  check(await page.locator('#preview-badge').textContent() === 'YAML', 'YAML badge');
  check(JSON.stringify(await tree('> .tree-item > .tree-line > .tree-key').allTextContents()) === '["Document 1","Document 2"]', 'one tree per YAML document');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  check(await tree('.tree-val[data-type="d"]').count() >= 1, 'YAML date typed as a date');
  await page.screenshot({ path: `${SHOTS}/tree-yaml-dark.png` });
  await open('pyproject.toml');
  await waitTree();
  check(await page.locator('#preview-badge').textContent() === 'TOML' && await keyLine('project').isVisible(), 'TOML tree');
  await open('renovate.json5');
  await waitTree();
  check(await page.locator('#preview-badge').textContent() === 'JSON5' && await tree('.tree-val:text-is("10")').count() === 1, 'JSON5 tree (hex read)');
  await open('settings.jsonc');
  await waitTree();
  check(await page.locator('#preview-badge').textContent() === 'JSONC', 'JSONC tree (comments, trailing commas)');
  await open('events.jsonl');
  await waitTree();
  check(await tree('.tree-val[data-type="x"]').count() === 1, 'JSON Lines: a bad line is an error node');
  check(await tree('> .tree-item').count() === 4, 'JSON Lines: one tree per line');

  // Malformed: Tree tab dropped, toast, Raw shown.
  await open('broken.yaml');
  await page.locator('.preview-view:not([hidden]) .text-card').waitFor();
  check((await tabs()).length === 0 && await pressed() === 'Raw', 'broken YAML: Tree tab dropped, Raw shown');
  check(/No tree for broken\.yaml/.test(await lastToast()), 'broken YAML: toast says why');
  await open('broken.json');
  await page.locator('.preview-view:not([hidden]) .text-card').waitFor();
  check((await tabs()).length === 0, 'broken JSON: only Raw left');
  await open('anchors.yaml');
  await page.locator('.preview-view:not([hidden]) .text-card').waitFor();
  check(/aliases/.test(await lastToast()), 'YAML aliases off by default');
  await setting('tree_view_yaml_aliases', 'true');
  await page.reload();
  await open('anchors.yaml');
  await waitTree();
  check(await tree('.tree-key:text-is("<<")').count() + await tree('.tree-key:text-is("image")').count() >= 2, 'YAML aliases on: merged keys show');
  await setting('tree_view_yaml_aliases');

  // Caps: node limit (notice), byte limit (Tree tab shows the standard notice, Raw still works).
  await setting('tree_view_max_nodes', '100');
  await page.reload();
  await open('many.json');
  await waitTree();
  check(/first 100 nodes/.test(await page.locator('.preview-view:not([hidden]) [data-role="notice"]').textContent()), 'node cap notice');
  await page.locator('.viewer-tools:not([hidden]) [data-role="expand"]').click();
  check(await tree('.tree-more').count() >= 1, 'node cap marks where the tree is cut');
  await setting('tree_view_max_nodes');
  await setting('tree_view_max_bytes', '100');
  await page.reload();
  await open('config.json');
  check(/above the 100 B viewer limit/.test(await page.locator('.preview-view:not([hidden]) .preview-notice').textContent()), 'byte cap notice on the Tree tab');
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view:not([hidden]) .view-pane[data-pane="source"]').waitFor();
  check(true, 'byte cap: Raw still works');
  await setting('tree_view_max_bytes');
  await page.keyboard.press('Escape');

  // Light mode, bootstrap skin.
  for (const [q, name] of [['mode=light', 'light'], ['skin=bootstrap&mode=light', 'bootstrap-light'], ['skin=bootstrap&mode=dark', 'bootstrap-dark']]) {
    await page.goto(`${share.url}?${q}`);
    await page.evaluate(() => localStorage.removeItem('cloche.preview-tab.tree'));
    await open('config.json');
    await waitTree();
    await page.screenshot({ path: `${SHOTS}/tree-json-${name}.png` });
  }
  await page.keyboard.press('Escape');

  // External link.
  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(`${link.url}?mode=dark`);
  await open('compose.yaml');
  await waitTree();
  check(await keyLine('Document 1').isVisible(), '/x link: YAML tree');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await api('DELETE', `/api/shares/${share.id}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
