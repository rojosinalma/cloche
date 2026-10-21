// Browser check of the web viewers (html, pdf, notebook, diagram): tabs,
// sandboxing, assets, caps, malformed files, /x links, both modes, two skins.
// Run with: bin/test-instance browser <name> web.js
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
  const shares = {};
  for (const dir of ['html', 'pdf', 'notebook', 'diagram']) {
    shares[dir] = await api('POST', '/api/shares', { paths: [`${FIXTURES}/${dir}`], title: `viewers ${dir}`, idle_timeout: 0 });
  }
  // The full Chromium build (new headless mode) ships the built-in PDF viewer; the headless shell does not.
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const framed = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url || '';
    // Messages from the shared page's own frame (a 404 asset in broken.html) are the file's, not the modal's.
    if (/[?&]data=html|about:srcdoc/.test(where)) framed.push(m.text()); else errors.push(`console: ${m.text()} @ ${where}`);
  });

  const open = async (name) => {
    if (await page.locator('#preview').isVisible()) await page.keyboard.press('Escape');
    await page.locator(`.file-name[data-name="${name}"]`).first().click();
    await page.locator('#preview').waitFor({ state: 'visible' });
  };
  const tabs = () => page.locator('#preview-tabs:not([hidden]) [data-tab]').allTextContents();
  const pressed = () => page.locator('#preview-tabs [aria-pressed="true"]').textContent().catch(() => null);
  const view = (sel) => page.locator(`.preview-view:not([hidden]) ${sel}`).first();
  const all = (sel) => page.locator(`.preview-view:not([hidden]) ${sel}`);
  const visible = (sel) => view(sel).isVisible();
  const tab = (key) => page.locator(`#preview-tabs [data-tab="${key}"]`).click();
  const frameOf = async (re) => {
    for (let i = 0; i < 50; i++) {
      const f = page.frames().find((fr) => re.test(fr.url()));
      if (f) return f;
      await page.waitForTimeout(100);
    }
    return null;
  };
  const noticeText = () => view('.preview-notice').textContent().catch(() => '');

  // ─── html ───
  const hs = shares.html;
  await page.goto(`${hs.url}?mode=dark`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await open('page.html');
  check(JSON.stringify(await tabs()) === '["Rendered","Source"]', 'html tabs are Rendered, Source');
  check(await pressed() === 'Rendered', 'html opens on Rendered');
  check(await view('iframe.html-frame').getAttribute('sandbox') === 'allow-scripts', 'html frame sandbox is allow-scripts only');
  let hf = await frameOf(/page\.html\?data=html$/);
  check(!!hf, 'html frame loads ?data=html');
  if (hf) {
    await hf.waitForFunction(() => document.getElementById('module')?.textContent === 'module ran', null, { timeout: 5000 }).catch(() => {});
    check(await hf.locator('#status').textContent() === 'script ran', 'html: classic script from js/ runs');
    check(await hf.locator('#module').textContent() === 'module ran', 'html: module script from js/ runs (CORS)');
    check(await hf.locator('#isolation').textContent() === 'no cookie, no storage, no parent', 'html: no cookie, no storage, no parent access');
    check(await hf.evaluate(() => origin) === 'null', 'html: frame origin is opaque');
    check(await hf.evaluate(() => getComputedStyle(document.querySelector('h1')).color) === 'rgb(200, 30, 30)', 'html: css/style.css applies');
    check(await hf.evaluate(() => document.getElementById('logo').naturalWidth) > 0, 'html: img/logo.svg loads');
    check(await hf.evaluate(() => getComputedStyle(document.body).backgroundImage.includes('part=img%2Fbg.svg')), 'html: url() in the stylesheet is rewritten');
    await page.screenshot({ path: `${SHOTS}/html-rendered-dark.png` });
    await hf.locator('#other').click();
    const other = await frameOf(/part=other\.html/);
    check(!!other && await other.locator('#top').textContent().catch(() => '') === 'Other page', 'html: a relative link opens inside the frame');
  }
  const hdr = await fetch(`${BASE_URL}${new URL(hs.url).pathname}p/0/page.html?data=html`);
  check(hdr.headers.get('content-security-policy') === 'sandbox allow-scripts', 'html: response CSP is sandbox allow-scripts');
  const esc = await fetch(`${BASE_URL}${new URL(hs.url).pathname}p/0/page.html?data=html&part=..%2F..%2Fcore%2Fnotes.txt`);
  check(esc.status === 404, 'html: a part outside the share entry is 404');
  await tab('text:source');
  await view('.code-lines').waitFor();
  check(await visible('.code-lines'), 'html Source shows the source');
  await tab('html:rendered');
  await open('broken.html');
  check(!!(await frameOf(/broken\.html\?data=html$/)), 'malformed html still renders in the frame');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/html-unstyled-dark.png` });
  await tab('text:source');
  await view('.text-card').waitFor();
  check(/Invalid UTF-8/.test(await view('.text-card').textContent()), 'malformed html Source shows the UTF-8 notice');
  await tab('html:rendered');
  await setting('html_view_max_bytes', '100');
  await page.reload();
  await open('page.html');
  check(/above the 100 B viewer limit/.test(await noticeText()), 'html cap: notice instead of the page');
  await tab('text:source');
  await view('.code-lines').waitFor();
  check(await visible('.code-lines'), 'html cap: Source still works');
  await setting('html_view_max_bytes');
  await page.goto(`${hs.url}?mode=light&skin=bootstrap&palette=gruvbox`);
  await open('page.html');
  await tab('html:rendered');
  await frameOf(/page\.html\?data=html$/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/html-rendered-light-bootstrap.png` });

  // ─── pdf ───
  const ps = shares.pdf;
  await page.goto(`${ps.url}?mode=dark`);
  await open('report.pdf');
  check(JSON.stringify(await tabs()) === '["Document","Info"]', 'pdf tabs are Document, Info');
  const pf = await frameOf(/report\.pdf\?data=pdf$/);
  check(!!pf, 'pdf: document frame loads ?data=pdf');
  check(await view('iframe.pdf-frame').getAttribute('sandbox') === null, 'pdf: frame has no sandbox attribute (the built-in viewer needs that)');
  await page.waitForFunction(() => /3 pages/.test(document.getElementById('preview-stats').textContent), null, { timeout: 5000 }).catch(() => {});
  check(/3 pages/.test(await page.locator('#preview-stats').textContent()), 'pdf: 3 pages in the stats');
  check(await page.locator('#preview-badge').textContent() === 'PDF 1.4', 'pdf badge shows the version');
  await page.waitForTimeout(2500);
  const embed = pf ? await pf.evaluate(() => document.querySelector('embed')?.type || document.contentType).catch((e) => `error ${e.message}`) : null;
  check(embed === 'application/pdf', `pdf: built-in viewer active (${embed})`);
  await page.screenshot({ path: `${SHOTS}/pdf-document-dark.png` });
  const pdfHead = await fetch(`${BASE_URL}${new URL(ps.url).pathname}p/0/report.pdf?data=pdf`, { method: 'HEAD' });
  check(pdfHead.headers.get('content-security-policy') === 'sandbox' && pdfHead.headers.get('content-type') === 'application/pdf', 'pdf: response is application/pdf with CSP sandbox');
  await tab('pdf:info');
  await view('.pdf-info-table tr').waitFor();
  const info = await view('.pdf-info-table').textContent();
  check(/TitleCloche test document/.test(info) && /Pages3/.test(info) && /AuthorTest Author/.test(info) && /Producerhand-written fixture/.test(info), 'pdf Info: title, pages, author, producer');
  await page.screenshot({ path: `${SHOTS}/pdf-info-dark.png` });
  await open('modern.pdf');
  await view('.pdf-info-table tr').waitFor();
  const modern = await view('.pdf-info-table').textContent();
  check(await pressed() === 'Info' && /TitleModern PDF/.test(modern) && /AuthorJosé \(tester\)/.test(modern) && /Pages1/.test(modern), 'pdf Info from object streams (remembered Info tab)');
  await open('notpdf.pdf');
  await view('[data-role="info-notice"]:not([hidden])').waitFor();
  check(/not a PDF file/.test(await view('[data-role="info-notice"]').textContent()), 'pdf: a non-PDF shows a notice in Info');
  await tab('pdf:document');
  await view('[data-role="doc-notice"]:not([hidden])').waitFor();
  check(/not a PDF file/.test(await view('[data-role="doc-notice"]').textContent()), 'pdf: a non-PDF shows a notice in Document');
  await open('broken.pdf');
  await tab('pdf:info');
  await view('[data-role="info-notice"]:not([hidden])').waitFor();
  check(/damaged/.test(await view('[data-role="info-notice"]').textContent()), 'pdf: a damaged PDF shows a notice in Info');
  await tab('pdf:document');
  await setting('pdf_view_max_bytes', '100');
  await page.reload();
  await open('report.pdf');
  await view('[data-role="doc-notice"]:not([hidden])').waitFor();
  check(/above the 100 B viewer limit/.test(await view('[data-role="doc-notice"]').textContent()), 'pdf cap: Document shows the notice');
  check(!(await frameOf(/report\.pdf\?data=pdf$/).then((f) => f && !/about:blank/.test(f.url()))), 'pdf cap: the document is not fetched');
  await tab('pdf:info');
  await view('.pdf-info-table tr').waitFor();
  check(/Cloche test document/.test(await view('.pdf-info-table').textContent()), 'pdf cap: Info still works');
  await tab('pdf:document');
  await setting('pdf_view_max_bytes');
  await page.goto(`${ps.url}?mode=light&skin=bootstrap&palette=gruvbox`);
  await open('report.pdf');
  await tab('pdf:info');
  await view('.pdf-info-table tr').waitFor();
  await page.screenshot({ path: `${SHOTS}/pdf-info-light-bootstrap.png` });
  await tab('pdf:document');

  // ─── notebook ───
  const ns = shares.notebook;
  await page.goto(`${ns.url}?mode=dark`);
  await open('analysis.ipynb');
  check(JSON.stringify(await tabs()) === '["Notebook","Source"]', 'notebook tabs are Notebook, Source');
  await view('.nb-notebook').waitFor();
  check(await page.locator('#preview-badge').textContent() === 'Jupyter · Python', 'notebook badge');
  check(/7 cells/.test(await page.locator('#preview-stats').textContent()), 'notebook: 7 cells in the stats');
  check(await view('.nb-markdown h1').textContent() === 'Sample notebook', 'notebook: Markdown cell rendered');
  check(await all('.nb-source .kn').count() > 0, 'notebook: code highlighted');
  check(await all('.nb-stderr').count() === 1, 'notebook: stderr stream shown');
  await page.waitForFunction(() => [...document.querySelectorAll('.preview-view:not([hidden]) .nb-image')].every((i) => i.complete && i.naturalWidth > 0));
  check(await all('.nb-image').count() === 2, 'notebook: PNG and SVG outputs as images');
  const trace = await view('.nb-error').textContent();
  check(/ZeroDivisionError: division by zero/.test(trace) && !trace.includes('\u001b'), 'notebook: traceback without ANSI codes');
  await view('.md-diagram-svg svg').waitFor({ timeout: 20000 }).catch(() => {});
  check(await all('.md-diagram-svg svg').count() === 1, 'notebook: Mermaid block in Markdown drawn');
  await view('iframe.nb-html').scrollIntoViewIfNeeded();
  const out = await view('iframe.nb-html').elementHandle().then((el) => el.contentFrame());
  check(!!out, 'notebook: HTML output in a srcdoc frame');
  if (out) {
    await out.waitForSelector('#df');
    await page.waitForTimeout(500);
    check(await out.evaluate(() => document.body.dataset.ran === undefined), 'notebook: scripts in HTML output do not run');
    check(await out.evaluate(() => origin) === 'null', 'notebook: HTML output frame origin is opaque');
    check(await out.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === 'dark', 'notebook: HTML output follows dark mode');
    const h = await view('iframe.nb-html').evaluate((f) => f.getBoundingClientRect().height);
    check(h > 40 && h < 200, `notebook: HTML output frame sized to its content (${h}px)`);
  }
  await page.screenshot({ path: `${SHOTS}/notebook-dark.png` });
  await open('broken.ipynb');
  await view('.preview-notice').waitFor();
  check(/not valid JSON/.test(await noticeText()), 'malformed notebook: notice');
  await tab('text:source');
  await view('.code-lines').waitFor();
  check(await visible('.code-lines'), 'malformed notebook: Source works');
  await tab('notebook:notebook');
  await setting('notebook_view_max_bytes', '100');
  await page.reload();
  await open('analysis.ipynb');
  check(/above the 100 B viewer limit/.test(await noticeText()), 'notebook cap: notice');
  await setting('notebook_view_max_bytes');
  await page.goto(`${ns.url}?mode=light&skin=bootstrap&palette=gruvbox`);
  await open('analysis.ipynb');
  await view('.nb-notebook').waitFor();
  await view('.md-diagram-svg svg').waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/notebook-light-bootstrap.png` });

  // ─── diagram ───
  const ds = shares.diagram;
  await page.goto(`${ds.url}?mode=dark`);
  await open('flow.mmd');
  check(JSON.stringify(await tabs()) === '["Diagram","Source"]', 'diagram tabs are Diagram, Source');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  check(/Preview modal/.test(await view('.diagram-stage svg').textContent()), 'mermaid file drawn');
  check(await page.locator('#preview-badge').textContent() === 'Mermaid', 'mermaid badge');
  await page.screenshot({ path: `${SHOTS}/diagram-mermaid-dark.png` });
  const before = await view('.diagram-stage svg').innerHTML();
  await page.evaluate(() => window.Tailor.theme.set({ mode: 'light' }, { persist: false }));
  await page.waitForFunction((b) => document.querySelector('.preview-view:not([hidden]) .diagram-stage svg')?.innerHTML !== b, before, { timeout: 10000 }).catch(() => {});
  check(await view('.diagram-stage svg').innerHTML() !== before, 'mermaid redraws on a mode switch');
  await page.screenshot({ path: `${SHOTS}/diagram-mermaid-light.png` });
  await page.evaluate(() => window.Tailor.theme.set({ mode: 'dark' }, { persist: false }));
  await open('sequence.mermaid');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  check(/create_share/.test(await view('.diagram-stage svg').textContent()), 'mermaid sequence diagram drawn');
  await open('graph.dot');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  check(await page.locator('#preview-badge').textContent() === 'Graphviz', 'graphviz badge');
  check(/data route/.test(await view('.diagram-stage svg').textContent()), 'graphviz file drawn');
  check(await view('.diagram-stage svg').evaluate((s) => [...s.querySelectorAll('a')].every((a) => !/javascript:/i.test(a.getAttribute('xlink:href') || a.getAttribute('href') || ''))), 'graphviz: javascript: links removed');
  check(await view('.diagram-stage svg').evaluate((s) => [...s.querySelectorAll('a')].some((a) => (a.getAttribute('xlink:href') || a.getAttribute('href')) === 'https://example.com/' && a.getAttribute('target') === '_blank')), 'graphviz: https link kept, opens a new tab');
  await page.screenshot({ path: `${SHOTS}/diagram-dot-dark.png` });
  await open('colours.gv');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  check(/filled/.test(await view('.diagram-stage svg').textContent()), 'graphviz .gv drawn');
  await open('broken.mmd');
  await view('.preview-notice').waitFor({ timeout: 20000 });
  check(/could not be drawn/.test(await noticeText()), 'malformed mermaid: notice');
  await tab('text:source');
  await view('.code-lines').waitFor();
  check(await visible('.code-lines'), 'malformed mermaid: Source works');
  await tab('diagram:diagram');
  await open('broken.dot');
  await view('.preview-notice').waitFor({ timeout: 20000 });
  check(/could not be drawn/.test(await noticeText()), 'malformed dot: notice');
  check(await page.evaluate(() => document.querySelectorAll('body > [id^="dcloche-diagram"], body > svg[id^="cloche-diagram"]').length) === 0, 'mermaid leaves no error element in the page');
  await open('notes.md');
  await view('.md-body').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.preview-view:not([hidden]) .md-diagram-svg svg').length === 2 &&
    document.querySelector('.preview-view:not([hidden]) .md-diagram-error'), null, { timeout: 20000 }).catch(() => {});
  check(await all('.md-diagram-svg svg').count() === 2, 'markdown: mermaid and dot blocks drawn');
  check(await page.locator('.preview-view:not([hidden]) .md-diagram-error').count() === 1, 'markdown: broken block shows a notice');
  check(await page.locator('.preview-view:not([hidden]) .md-diagram pre:not([hidden])').count() === 1, 'markdown: broken block keeps its code');
  check(await page.locator('.preview-view:not([hidden]) .md-body > pre.md-code').count() === 1, 'markdown: other code blocks unchanged');
  await page.screenshot({ path: `${SHOTS}/diagram-markdown-dark.png` });
  await setting('diagram_view_max_bytes', '10');
  await page.reload();
  await open('flow.mmd');
  check(/above the 10 B viewer limit/.test(await noticeText()), 'diagram cap: notice');
  await setting('diagram_view_max_bytes');
  await page.goto(`${ds.url}?mode=light&skin=bootstrap&palette=gruvbox`);
  await open('graph.dot');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/diagram-dot-light-bootstrap.png` });
  await open('flow.mmd');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/diagram-mermaid-light-bootstrap.png` });
  await page.keyboard.press('Escape');

  // ─── /x links ───
  const link = async (s) => (await api('POST', `/api/shares/${s.id}/links`, { ttl: 3600 })).url;
  await page.goto(`${await link(hs)}?mode=dark`);
  await open('page.html');
  hf = await frameOf(/\/x\/.*page\.html\?data=html$/);
  if (hf) await hf.waitForFunction(() => document.getElementById('module')?.textContent === 'module ran', null, { timeout: 5000 }).catch(() => {});
  check(!!hf && await hf.locator('#status').textContent() === 'script ran' && await hf.locator('#module').textContent() === 'module ran', '/x link: html page with assets');
  await page.goto(`${await link(ps)}?mode=dark`);
  await open('report.pdf');
  check(!!(await frameOf(/\/x\/.*report\.pdf\?data=pdf$/)), '/x link: pdf document');
  await tab('pdf:info');
  await view('.pdf-info-table tr').waitFor();
  check(/Cloche test document/.test(await view('.pdf-info-table').textContent()), '/x link: pdf info');
  await page.goto(`${await link(ns)}?mode=dark`);
  await open('analysis.ipynb');
  await view('.nb-notebook').waitFor();
  check(await all('.nb-cell').count() === 7, '/x link: notebook');
  await page.goto(`${await link(ds)}?mode=dark`);
  await open('flow.mmd');
  await view('.diagram-stage svg').waitFor({ timeout: 20000 });
  check(true, '/x link: mermaid diagram');
  await page.screenshot({ path: `${SHOTS}/x-link-diagram.png` });

  // Downloads: each viewer's main fetch counts, assets and parts do not.
  const names = async (s) => (await api('GET', `/api/shares/${s.id}`)).downloads.map((d) => d.name);
  const htmlDl = await names(hs);
  console.log('html downloads', JSON.stringify(htmlDl));
  check(!htmlDl.some((n) => /\.(css|js|mjs|svg)$/.test(n)), 'html: assets are not counted');
  const pdfDl = await names(ps);
  console.log('pdf downloads', JSON.stringify(pdfDl));

  if (framed.length) console.log('messages from shared pages (ignored):', JSON.stringify(framed));
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(JSON.stringify({ ok: failures.length === 0, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
