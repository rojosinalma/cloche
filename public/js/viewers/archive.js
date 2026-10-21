// Archive viewer: the listing from ?data=archive (names, sizes, dates; read on
// the server, nothing extracted) as a folder tree in a table. Folders fold;
// files are rows only, there is no per-entry download.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Entries [path, size, mtime, type, note] → nested folders; folders a path only implies are added.
function build(entries) {
  const root = { name: '', type: 'd', kids: new Map(), depth: -1, size: 0, files: 0, open: true };
  const dir = (parent, name) => {
    if (!parent.kids.has(name)) parent.kids.set(name, { name, type: 'd', kids: new Map(), depth: parent.depth + 1, size: 0, files: 0, open: false, mtime: null });
    const d = parent.kids.get(name);
    if (d.type !== 'd') { d.type = 'd'; d.kids = new Map(); d.size = 0; d.files = 0; d.open = false; }
    return d;
  };
  entries.forEach(([path, size, mtime, type, note]) => {
    const parts = String(path).split('/').filter((p) => p && p !== '.');
    if (!parts.length) return;
    let parent = root;
    parts.slice(0, -1).forEach((p) => { parent = dir(parent, p); });
    const name = parts[parts.length - 1];
    if (type === 'd') { const d = dir(parent, name); d.mtime = mtime; return; }
    if (parent.kids.get(name)?.type === 'd') return;
    parent.kids.set(name, { name, type, size: size || 0, mtime, note, depth: parent.depth + 1 });
  });
  const total = (d) => {
    d.list = [...d.kids.values()].sort((a, b) => (a.type === 'd') !== (b.type === 'd') ? (a.type === 'd' ? -1 : 1) : collator.compare(a.name, b.name));
    d.list.forEach((k) => {
      if (k.type === 'd') { total(k); d.size += k.size; d.files += k.files; } else { d.size += k.size; d.files += 1; }
    });
  };
  total(root);
  return root;
}

export async function mount(ctx) {
  const pick = (role) => ctx.$(`[data-role="${role}"]`);
  const table = pick('table'), rows = pick('rows'), loading = pick('loading'), body = pick('body');
  const expandBtn = pick('expand'), collapseBtn = pick('collapse');
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ctx.signal });
  const byRow = new WeakMap();
  let root = null;

  const row = (node) => {
    const tr = document.createElement('tr');
    byRow.set(tr, node);
    tr.dataset.type = node.type;
    const name = document.createElement('td');
    name.className = 'archive-name';
    name.style.setProperty('--depth', node.depth);
    const toggle = document.createElement('span');
    toggle.className = 'archive-toggle';
    if (node.type === 'd') {
      toggle.innerHTML = ctx.icon('chevron-right');
      tr.setAttribute('aria-expanded', String(node.open));
      tr.tabIndex = 0;
    }
    name.append(toggle);
    name.insertAdjacentHTML('beforeend', ctx.icon(node.type === 'd' ? (node.open ? 'folder2-open' : 'folder-fill') : 'file-earmark', 'archive-icon'));
    const label = document.createElement('span');
    label.className = 'archive-label';
    label.textContent = node.name;
    name.append(label);
    if (node.note || node.type === 'd') {
      const note = document.createElement('span');
      note.className = 'archive-note';
      note.textContent = node.type === 'd' ? `${node.files.toLocaleString()} ${node.files === 1 ? 'file' : 'files'}` : node.note;
      name.append(note);
    }
    const size = document.createElement('td');
    size.className = 't-col-num';
    size.textContent = node.type === 'l' && !node.size ? '' : ctx.humanSize(node.size);
    const date = document.createElement('td');
    date.className = 'archive-date';
    date.textContent = node.mtime ? node.mtime.slice(0, 16) : '';
    tr.append(name, size, date);
    return tr;
  };

  const render = () => {
    const out = [];
    const walk = (d) => d.list.forEach((k) => { out.push(row(k)); if (k.type === 'd' && k.open) walk(k); });
    walk(root);
    rows.replaceChildren(...out);
  };

  const toggle = (tr) => {
    const node = byRow.get(tr);
    if (!node || node.type !== 'd') return;
    node.open = !node.open;
    render();
    rows.querySelector(`tr:nth-child(${[...rows.children].findIndex((r) => byRow.get(r) === node) + 1})`)?.focus();
  };
  on(rows, 'click', (e) => { const tr = e.target.closest('tr'); if (tr) toggle(tr); });
  on(rows, 'keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-type="d"]')) { e.preventDefault(); e.stopPropagation(); toggle(e.target); }
  });
  const setAll = (open) => {
    const walk = (d) => d.list.forEach((k) => { if (k.type === 'd') { k.open = open; walk(k); } });
    walk(root);
    render();
  };
  on(expandBtn, 'click', () => setAll(true));
  on(collapseBtn, 'click', () => setAll(false));

  const say = (text) => {
    const notice = pick('notice');
    notice.hidden = false;
    pick('notice-text').textContent = text;
  };

  try {
    const r = await fetch(ctx.src, { signal: ctx.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) {
      ctx.notice(`Cannot list ${ctx.item.name}: ${data.message}`, 'exclamation-triangle');
      return null;
    }
    ctx.setBadge(data.format);
    root = build(data.entries);
    if (root.list.length === 1 && root.list[0].type === 'd') root.list[0].open = true;
    const listed = data.entries.length;
    const count = data.total ?? listed;
    ctx.setStats(` · ${count.toLocaleString()}${data.total == null ? '+' : ''} ${count === 1 ? 'entry' : 'entries'} · ${ctx.humanSize(root.size)} uncompressed${data.truncated || data.timed_out ? ' (listed part)' : ''}`);
    if (data.timed_out) say(`Listing stopped after ${listed.toLocaleString()} entries: reading the archive took longer than the archive viewer time limit.`);
    else if (data.truncated) say(`Showing the first ${listed.toLocaleString()}${data.total ? ` of ${data.total.toLocaleString()}` : ''} entries: the archive is above the archive viewer entry limit.`);
    else if (data.warning) say(data.warning);
    if (!root.list.length) {
      body.innerHTML = '<div class="t-empty"><span>The archive is empty.</span></div>';
    } else {
      table.hidden = false;
      expandBtn.hidden = collapseBtn.hidden = false;
      render();
    }
  } catch (e) {
    if (e.name === 'AbortError') return null;
    ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
  } finally {
    loading.hidden = true;
  }
  return null;
}
