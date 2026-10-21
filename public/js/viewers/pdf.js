// PDF viewer. Document: the browser's built-in PDF viewer in a plain
// <iframe> (a sandbox attribute would block it); the response itself carries
// "Content-Security-Policy: sandbox" and application/pdf with nosniff. Info:
// the details the server reads from the file (?data=pdf&part=info, not
// counted), also for files above the viewer limit, whose Document tab shows
// the notice instead of loading.
const ROWS = [
  ['pages', 'Pages'], ['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords'],
  ['creator', 'Created with'], ['producer', 'Producer'], ['created', 'Created'], ['modified', 'Modified'],
  ['version', 'PDF version'], ['encrypted', 'Encrypted'], ['size_label', 'Size']
];

export function mount(ctx) {
  const panes = [...ctx.root.querySelectorAll('.pdf-pane')];
  const frame = ctx.$('[data-role="frame"]');
  const loading = ctx.$('[data-role="loading"]');
  const docNotice = ctx.$('[data-role="doc-notice"]');
  const rows = ctx.$('[data-role="info-rows"]');
  const infoNotice = ctx.$('[data-role="info-notice"]');
  const infoLoading = ctx.$('[data-role="info-loading"]');
  let blocked = null; // why the document does not load, once the info says so
  let started = false;

  const info = fetch(`${ctx.src}&part=info`, { signal: ctx.signal })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

  const showDocNotice = (message) => {
    loading.hidden = true;
    frame.hidden = true;
    docNotice.querySelector('[data-role="doc-message"]').textContent = message;
    docNotice.hidden = false;
  };

  const startDocument = () => {
    if (started) return;
    started = true;
    info.catch(() => ({})).then((d) => {
      if (ctx.signal.aborted) return;
      if (d.too_large) blocked = `This file is ${d.size_label}, above the ${d.max_label} viewer limit.`;
      else if (d.notice && !d.version) blocked = d.notice;
      if (blocked) { showDocNotice(blocked); return; }
      frame.addEventListener('load', () => { loading.hidden = true; }, { signal: ctx.signal });
      frame.src = ctx.src;
    });
  };

  info.then((d) => {
    if (ctx.signal.aborted) return;
    if (d.version) ctx.setBadge(`PDF ${d.version}`);
    if (d.pages) ctx.setStats(` · ${d.pages.toLocaleString()} page${d.pages === 1 ? '' : 's'}`);
    const shown = ROWS.filter(([key]) => d[key] !== undefined && d[key] !== null && d[key] !== '');
    rows.replaceChildren(...shown.map(([key, label]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      const td = document.createElement('td');
      th.scope = 'row';
      th.textContent = label;
      td.textContent = key === 'encrypted' ? (d[key] ? 'Yes' : 'No') : String(d[key]);
      tr.append(th, td);
      return tr;
    }));
    if (d.notice) {
      infoNotice.querySelector('span').textContent = d.notice;
      infoNotice.hidden = false;
    }
  }).catch((e) => {
    if (e.name === 'AbortError') return;
    infoNotice.querySelector('span').textContent = `Could not read the document details: ${e.message}`;
    infoNotice.hidden = false;
  }).finally(() => { infoLoading.hidden = true; });

  return {
    show(view) {
      panes.forEach((p) => { p.hidden = p.dataset.pane !== view; });
      if (view === 'document') startDocument();
    },
    dispose() { frame.removeAttribute('src'); }
  };
}
