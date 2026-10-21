// Tree viewer: JSON, JSONC, JSON5, YAML, TOML and JSON Lines as a collapsible
// tree. The server parses and caps the file (?data=tree, the one download) and
// sends compact nodes; this module renders them lazily (a folded branch has no
// DOM), filters keys and values, and copies a node's path (.a.b[3]) on click.
// A file that does not parse drops the Tree tab and says why in a toast.
const IDENT = /^[A-Za-z_$][\w$]*$/;
const SEARCH_DELAY_MS = 120;

// Payload node → model node: { t, key, parent, depth, kids | text }.
function build(raw, key, parent, depth, all) {
  const [t, v] = raw;
  const node = { t, key, parent, depth, open: false, kids: null, text: '' };
  all.push(node);
  if (t === 'o') node.kids = v.map((e) => (e.length === 1 ? build(e, null, node, depth + 1, all) : build(e[1], e[0], node, depth + 1, all)));
  else if (t === 'a') node.kids = v.map((c, i) => build(c, i, node, depth + 1, all));
  else if (t === 's') node.text = v;
  else if (t === 'z') node.text = 'null';
  else if (t !== 'more') node.text = String(v);
  return node;
}

const isBranch = (n) => n.kids !== null;
const segment = (n) => (typeof n.key === 'number' ? `[${n.key}]` : IDENT.test(n.key) ? `.${n.key}` : `[${JSON.stringify(n.key)}]`);

function pathOf(node) {
  const parts = [];
  for (let n = node; n && n.parent; n = n.parent) parts.unshift(segment(n));
  return parts.join('') || '.';
}

// Text with every case-insensitive occurrence of q wrapped in <mark>; text nodes only.
function marked(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(text); return frag; }
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    frag.append(text.slice(at, i));
    const m = document.createElement('mark');
    m.className = 'tree-mark';
    m.textContent = text.slice(i, i + q.length);
    frag.append(m);
    at = i + q.length;
  }
  frag.append(text.slice(at));
  return frag;
}

export async function mount(ctx) {
  const pick = (role) => ctx.$(`[data-role="${role}"]`);
  const view = pick('tree'), loading = pick('loading'), notice = pick('notice'), hint = pick('hint');
  const search = pick('search'), expandBtn = pick('expand'), collapseBtn = pick('collapse');
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ctx.signal });
  const all = [];
  const items = new WeakMap(); // DOM item → model node
  let roots = [];
  let filter = null; // { q, hits: Set, keep: Set, open: Map }
  let baseStats = '';

  const isOpen = (n) => (filter ? (filter.open.has(n) ? filter.open.get(n) : filter.keep.has(n)) : n.open);
  const visible = (list) => (filter ? list.filter((k) => filter.keep.has(k) || filter.hits.has(k)) : list);
  const kidsOf = (n) => (filter && filter.keep.has(n) ? visible(n.kids) : n.kids);

  const line = (node) => {
    const row = document.createElement('div');
    row.className = 'tree-line';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    if (isBranch(node)) {
      toggle.innerHTML = ctx.icon('chevron-right');
      toggle.setAttribute('aria-label', 'Expand or collapse');
    } else {
      toggle.disabled = true;
      toggle.setAttribute('aria-hidden', 'true');
    }
    row.append(toggle);
    if (node.t === 'more') {
      const more = document.createElement('span');
      more.className = 'tree-more';
      more.textContent = '… more not shown (tree node limit)';
      row.append(more);
      return row;
    }
    if (node.key !== null) {
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'tree-key';
      if (typeof node.key === 'number') key.dataset.index = '';
      key.append(marked(String(node.key), filter && typeof node.key === 'string' ? filter.q : ''));
      row.append(key);
    }
    const val = document.createElement('span');
    val.className = 'tree-val';
    val.dataset.type = node.t;
    if (isBranch(node)) {
      const n = node.kids.filter((k) => k.t !== 'more').length;
      val.className = 'tree-sum';
      val.textContent = node.t === 'o' ? `{${n}} ${n === 1 ? 'key' : 'keys'}` : `[${n}] ${n === 1 ? 'item' : 'items'}`;
    } else {
      val.append(marked(node.t === 's' ? `"${node.text}"` : node.text, filter ? filter.q : ''));
    }
    row.append(val);
    return row;
  };

  const item = (node) => {
    const el = document.createElement('div');
    el.className = 'tree-item';
    el.setAttribute('role', 'treeitem');
    items.set(el, node);
    el.append(line(node));
    if (isBranch(node)) {
      const kids = document.createElement('div');
      kids.className = 'tree-kids';
      kids.setAttribute('role', 'group');
      el.append(kids);
      paint(el, node);
    }
    return el;
  };

  // A branch's children exist in the DOM only while it is open.
  function paint(el, node) {
    const open = isOpen(node);
    el.setAttribute('aria-expanded', String(open));
    const kids = el.lastElementChild;
    kids.hidden = !open;
    kids.replaceChildren(...(open ? kidsOf(node).map(item) : []));
  }

  const render = () => {
    const single = roots.length === 1 && isBranch(roots[0]) && roots[0].key === null;
    const top = visible(single ? roots[0].kids : roots);
    view.replaceChildren(...top.map(item));
    if (filter && !top.length) {
      const none = document.createElement('div');
      none.className = 'tree-none';
      none.textContent = 'Nothing matches the filter.';
      view.append(none);
    }
  };

  const copyPath = async (node) => {
    const path = pathOf(node);
    try {
      await navigator.clipboard.writeText(path);
      ctx.toast('success', `Copied ${path}`);
    } catch (e) {
      ctx.toast('error', `Could not copy ${path}: ${e.message}`);
    }
  };

  on(view, 'click', (e) => {
    const el = e.target.closest('.tree-item');
    const node = el && items.get(el);
    if (!node || !e.target.closest('.tree-line') || node.t === 'more') return;
    if (isBranch(node) && (e.target.closest('.tree-toggle') || e.target.closest('.tree-sum'))) {
      if (filter) filter.open.set(node, !isOpen(node)); else node.open = !node.open;
      paint(el, node);
      return;
    }
    copyPath(node);
  });

  const setAll = (open) => {
    all.forEach((n) => {
      if (!isBranch(n)) return;
      const value = open || n.parent === null;
      if (filter) filter.open.set(n, value); else n.open = value;
    });
    render();
  };
  on(expandBtn, 'click', () => setAll(true));
  on(collapseBtn, 'click', () => setAll(false));

  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) {
      filter = null;
      ctx.setStats(baseStats);
    } else {
      const hits = new Set(all.filter((n) => n.t !== 'more' && ((n.parent && typeof n.key === 'string' && n.key.toLowerCase().includes(q)) ||
        (!isBranch(n) && n.text.toLowerCase().includes(q)))));
      const keep = new Set();
      hits.forEach((n) => { for (let p = n.parent; p && !keep.has(p); p = p.parent) keep.add(p); });
      filter = { q, hits, keep, open: new Map() };
      ctx.setStats(`${baseStats} · ${hits.size.toLocaleString()} ${hits.size === 1 ? 'match' : 'matches'}`);
    }
    render();
  };
  let timer = 0;
  on(search, 'input', () => { clearTimeout(timer); timer = setTimeout(applyFilter, SEARCH_DELAY_MS); });
  on(search, 'keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); applyFilter(); } });

  try {
    const r = await fetch(ctx.src, { signal: ctx.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) {
      ctx.toast('warning', `No tree for ${ctx.item.name}: ${data.message}`);
      ctx.hideView('tree');
      return { dispose() { clearTimeout(timer); } };
    }
    roots = data.docs.map(([label, raw]) => build(raw, label, null, 0, all));
    all.forEach((n) => { n.open = isBranch(n) && n.depth < Math.max(1, data.expand_depth); });
    ctx.setBadge(data.format);
    baseStats = ` · ${data.nodes.toLocaleString()} ${data.nodes === 1 ? 'node' : 'nodes'}`;
    ctx.setStats(baseStats);
    if (data.truncated) {
      notice.hidden = false;
      pick('notice-text').textContent = `Showing the first ${data.max_nodes.toLocaleString()} nodes: the file is above the tree node limit.`;
    }
    [search, expandBtn, collapseBtn, hint].forEach((el) => { el.hidden = false; });
    render();
  } catch (e) {
    if (e.name === 'AbortError') return null;
    ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
  } finally {
    loading.hidden = true;
  }

  return {
    key(e) {
      if (e.key !== '/' || search.hidden) return false;
      search.focus();
      search.select();
      return true;
    },
    dispose() { clearTimeout(timer); }
  };
}
