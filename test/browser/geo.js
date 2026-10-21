// Browser check of the geo viewer (GeoJSON, sniffed .json, GPX, KML): Map tab
// first with Raw beside it, shapes drawn with palette colours, popups escaped,
// tiles and their dark-mode filter, caps, malformed files, an empty tile URL,
// /x links, both modes in two skins. Run with: bin/test-instance browser <name> geo.js
// Env (set by bin/test-instance): BASE_URL, TOKEN, FIXTURES, SHOTS.
const { chromium } = require('playwright');

const { BASE_URL, TOKEN, FIXTURES, SHOTS = '/tmp' } = process.env;
const TILE_HOST = 'tile.openstreetmap.org';
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
  const share = await api('POST', '/api/shares', { paths: [`${FIXTURES}/geo`], title: 'viewers geo', idle_timeout: 0 });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('request', (r) => requests.push(r.url()));

  const open = async (name) => {
    if (await page.locator('#preview').isVisible()) await page.keyboard.press('Escape');
    await page.locator(`.file-name[data-name="${name}"]`).first().click();
    await page.locator('#preview').waitFor({ state: 'visible' });
  };
  const tabs = () => page.locator('#preview-tabs:not([hidden]) [data-tab]').allTextContents();
  const pressed = () => page.locator('#preview-tabs [aria-pressed="true"]').textContent().catch(() => null);
  const view = '.preview-view[data-viewer="geo"]:not([hidden])';
  const shapes = (kind) => page.locator(`${view} path.geo-${kind}`).count();
  const drawn = () => page.locator(`${view} path.geo-shape`).first().waitFor({ timeout: 20000 });
  const notice = async () => {
    await page.locator(`${view} .preview-notice`).waitFor({ timeout: 20000 });
    return page.locator(`${view} .preview-notice`).textContent();
  };
  const tilesLoaded = () => page.waitForFunction(() => document.querySelectorAll('.preview-view:not([hidden]) .leaflet-tile-loaded').length > 0, null, { timeout: 20000 })
    .then(() => true, () => false);
  // A token resolved the way the browser paints it, to compare with a shape's computed colour.
  const tokenColour = (name) => page.evaluate((n) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
  const strokeOf = (kind) => page.locator(`${view} path.geo-${kind}`).first().evaluate((p) => getComputedStyle(p).stroke);
  const paneFilter = () => page.locator(`${view} .leaflet-tile-pane`).evaluate((p) => getComputedStyle(p).filter);

  await page.goto(`${share.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // GeoJSON: Map first, Raw beside it; shapes by geometry type.
  check(await page.locator('.file-name[data-name="route.geojson"]').first().getAttribute('data-kind').catch(() => null) !== 'file', 'route.geojson is previewable');
  await open('route.geojson');
  await drawn();
  const routeTabs = await tabs();
  check(routeTabs[0] === 'Map' && routeTabs.includes('Raw'), `geojson tabs start with Map and include Raw (${routeTabs})`);
  check(await pressed() === 'Map', 'geojson opens on Map');
  check(await page.locator('#preview-badge').textContent() === 'GeoJSON', 'GeoJSON badge');
  check(/5 features · 13 points/.test(await page.locator('#preview-stats').textContent()), 'stats: 5 features, 13 points (collection split, null geometry skipped)');
  check(await shapes('line') === 2 && await shapes('area') === 1 && await shapes('point') === 2, 'two lines, one area, two points');
  check(await strokeOf('line') === await tokenColour('--t-accent'), 'track colour is --t-accent');
  check(await strokeOf('area') === await tokenColour('--t-hue-cyan'), 'area colour is --t-hue-cyan');
  check(await tilesLoaded(), 'OSM tiles load');
  check(requests.some((u) => u.includes(TILE_HOST)), 'tiles come from tile.openstreetmap.org');
  check(/OpenStreetMap/.test(await page.locator(`${view} .leaflet-control-attribution`).textContent()), 'OSM attribution shown');
  check(await page.locator(`${view} .leaflet-control-attribution a[href="https://www.openstreetmap.org/copyright"]`).count() === 1, 'attribution links to the OSM copyright page');
  check(await page.locator(`${view} [title]`).count() === 0, 'no native title tooltips on the map controls');
  check(/invert/.test(await paneFilter()), 'dark mode inverts the tiles');
  check(await page.locator('.viewer-tools:not([hidden]) [data-role="fit"]').isEnabled(), 'fit button enabled');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/geo-route-dark.png` });

  // Popup: properties as text, never markup.
  await page.locator(`${view} path.geo-point`).first().click({ force: true });
  await page.locator(`${view} .geo-popup`).waitFor({ timeout: 5000 });
  const pop = await page.locator(`${view} .geo-popup`).textContent();
  check(/Plaza de Armas/.test(pop) && pop.includes('<img src=x onerror=alert(1)>'), 'popup shows the properties as text');
  check(await page.locator(`${view} .geo-popup img, ${view} .geo-popup b`).count() === 0, 'popup renders no markup from the file');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/geo-popup-dark.png` });
  await page.keyboard.press('ArrowRight');
  check(await page.locator('#preview-name').textContent() === 'route.geojson', 'arrow keys pan a focused map instead of changing the file');
  await page.locator('.viewer-tools:not([hidden]) [data-role="fit"]').click();

  // Tabs: Raw shows the source, back to Map redraws at full size.
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view[data-viewer="text"]:not([hidden]) .code-lines').waitFor();
  check(!(await page.locator('.preview-view[data-viewer="geo"]').isVisible()), 'Raw hides the map');
  await page.locator('#preview-tabs [data-tab="geo:map"]').click();
  check(await page.locator(`${view} .geo-map`).evaluate((m) => m.clientWidth > 300 && m.clientHeight > 300), 'back on Map, the map fills the panel');
  check(await shapes('line') === 2, 'shapes still drawn after switching tabs');

  // A .json whose top-level type is GeoJSON is a map; another .json is not.
  await open('places.json');
  await drawn();
  const placeTabs = await tabs();
  check(placeTabs[0] === 'Map' && placeTabs.includes('Raw'), `sniffed .json gets Map first (${placeTabs})`);
  check(await shapes('point') === 2, 'places.json: two points');
  await open('plain.json');
  await page.locator('.text-card').waitFor();
  check(!(await tabs()).includes('Map'), 'plain .json with a nested Feature gets no Map tab');

  // GPX: track as a line, waypoints as markers.
  await open('walk.gpx');
  await drawn();
  check(await page.locator('#preview-badge').textContent() === 'GPX', 'GPX badge');
  check(await shapes('line') === 1 && await shapes('point') === 2, 'GPX: one track line, two waypoints');
  await page.locator(`${view} path.geo-point`).first().click({ force: true });
  await page.locator(`${view} .geo-popup`).waitFor({ timeout: 5000 });
  check(/Café & bakery/.test(await page.locator(`${view} .geo-popup`).textContent()), 'GPX waypoint popup');
  await page.screenshot({ path: `${SHOTS}/geo-gpx-dark.png` });

  // KML, with markup in a description.
  await open('pins.kml');
  await drawn();
  check(await page.locator('#preview-badge').textContent() === 'KML', 'KML badge');
  check(await shapes('line') === 1 && await shapes('point') === 1, 'KML: one line, one point');
  await page.locator(`${view} path.geo-point`).first().click({ force: true });
  await page.locator(`${view} .geo-popup`).waitFor({ timeout: 5000 });
  check((await page.locator(`${view} .geo-popup`).textContent()).includes('<script>'), 'KML description shown as text');

  // A DTD is dropped before parsing: the external entity is never loaded, the file is refused.
  check(/not well-formed XML/.test(await (open('entity.kml').then(notice))), 'KML with an external entity: notice');
  check(!requests.some((u) => u.startsWith('file:')), 'external entity not fetched');

  // Malformed input: a notice with a download, Raw still there.
  check(/not valid JSON/.test(await (open('broken.geojson').then(notice))), 'broken GeoJSON: notice');
  check(await page.locator(`${view} .preview-download-link`).isVisible(), 'broken GeoJSON: download offered');
  await page.locator('#preview-tabs [data-tab="text:source"]').click();
  await page.locator('.preview-view[data-viewer="text"]:not([hidden]) .code-lines').waitFor();
  check(true, 'broken GeoJSON: Raw shows the source');
  await page.locator('#preview-tabs [data-tab="geo:map"]').click();
  check(/not GeoJSON/.test(await (open('other.geojson').then(notice))), 'non-GeoJSON .geojson: notice');
  check(/not well-formed XML/.test(await (open('broken.gpx').then(notice))), 'broken GPX: notice');
  await page.keyboard.press('Escape');

  // Caps: size, features and points; Raw stays.
  await setting('geo_view_max_bytes', '100');
  await page.reload();
  check(/above the 100 B viewer limit/.test(await (open('route.geojson').then(notice))), 'size cap notice');
  check((await tabs()).includes('Raw'), 'size cap keeps Raw');
  await setting('geo_view_max_bytes');
  await setting('geo_view_max_features', '2');
  await page.reload();
  check(/above the 2 feature limit/.test(await (open('route.geojson').then(notice))), 'feature cap notice');
  await setting('geo_view_max_features');
  await setting('geo_view_max_points', '5');
  await page.reload();
  check(/above the 5 point limit/.test(await (open('route.geojson').then(notice))), 'point cap notice');
  await setting('geo_view_max_points');

  // Empty tile URL: shapes on the plain background, no request to the tile server.
  await setting('geo_view_tile_url', '');
  await page.reload();
  requests.length = 0;
  await open('route.geojson');
  await drawn();
  await page.waitForTimeout(1000);
  check(await page.locator(`${view} .leaflet-tile`).count() === 0 && !requests.some((u) => u.includes(TILE_HOST)), 'no tiles and no tile request without a tile URL');
  await page.screenshot({ path: `${SHOTS}/geo-plain-dark.png` });
  await setting('geo_view_tile_url');

  // Light mode, and the bootstrap skin in both modes.
  for (const [skin, mode] of [['luz', 'light'], ['bootstrap', 'dark'], ['bootstrap', 'light']]) {
    await page.goto(`${share.url}?skin=${skin}&mode=${mode}`);
    await open('route.geojson');
    await drawn();
    await tilesLoaded();
    if (mode === 'light') check(!/invert/.test(await paneFilter()), `${skin} light: tiles not inverted`);
    check(await strokeOf('line') === await tokenColour('--t-accent'), `${skin} ${mode}: track colour follows the palette`);
    await page.locator(`${view} path.geo-point`).first().click({ force: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/geo-route-${skin}-${mode}.png` });
  }
  await page.keyboard.press('Escape');

  // External link: the same viewer under /x/<token>/, tiles from OSM in this browser.
  const link = await api('POST', `/api/shares/${share.id}/links`, { ttl: 3600 });
  await page.goto(`${link.url}?mode=dark`);
  await open('walk.gpx');
  await drawn();
  check(await shapes('line') === 1, '/x link: GPX drawn');
  check(await tilesLoaded(), '/x link: tiles load');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/geo-x-link.png` });

  const detail = await api('GET', `/api/shares/${share.id}`);
  const counted = detail.downloads.map((d) => d.name);
  console.log('downloads', JSON.stringify(counted.sort()));
  check(counted.includes('route.geojson'), 'the map fetch counts as a download');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  await api('DELETE', `/api/shares/${share.id}`).catch(() => {});
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
