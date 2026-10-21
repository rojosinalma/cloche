// Diff viewer: unified diffs and patches (git diff, git format-patch, diff -u)
// from ?data=diff, the one download. Unified and Side by side render from one
// parse; each file folds on its own (the fold holds across both tabs). A file
// with no recognisable diff drops both tabs and says why in a toast.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// Path from a ---/+++ line or a diff --git half: no a/ b/ prefix, no timestamp.
const cleanPath = (p) => {
  const path = p.split('\t')[0].trim().replace(/^"(.*)"$/, '$1');
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
};

export function parse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const blocks = []; // { kind: 'text', lines } | { kind: 'file', ... }
  let file = null;
  let note = null;
  const textLine = (l) => {
    if (!note) { note = { kind: 'text', lines: [] }; blocks.push(note); }
    note.lines.push(l);
  };
  const newFile = (header) => {
    file = { kind: 'file', header: [header], old: null, new: null, status: 'modified', binary: false, hunks: [], add: 0, del: 0 };
    blocks.push(file);
    note = null;
    return file;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const f = newFile(l);
      const m = l.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      if (m) { f.old = m[1]; f.new = m[2]; }
      continue;
    }
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && lines[i + 2]?.match(HUNK)) {
      if (!file || file.hunks.length || note) newFile(l); else file.header.push(l);
      file.header.push(lines[i + 1]);
      const oldPath = cleanPath(l.slice(4)), newPath = cleanPath(lines[i + 1].slice(4));
      file.old = oldPath; file.new = newPath;
      if (!oldPath) file.status = 'added';
      if (!newPath) file.status = 'deleted';
      i += 1;
      continue;
    }
    const h = file && !note ? l.match(HUNK) : null;
    if (h) {
      const hunk = { oldStart: +h[1], oldCount: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newCount: h[4] === undefined ? 1 : +h[4], section: h[5], lines: [] };
      let o = hunk.oldCount, n = hunk.newCount;
      while (i + 1 < lines.length && (o > 0 || n > 0 || lines[i + 1].startsWith('\\'))) {
        const d = lines[i + 1];
        const c = d[0];
        if (c === '\\') { hunk.lines.push({ t: 'meta', s: d }); i++; continue; }
        if (c === '+') { n--; file.add++; hunk.lines.push({ t: 'add', s: d.slice(1) }); } else if (c === '-') { o--; file.del++; hunk.lines.push({ t: 'del', s: d.slice(1) }); } else if (c === ' ' || d === '') { o--; n--; hunk.lines.push({ t: 'ctx', s: d.slice(1) }); } else break;
        i++;
      }
      file.hunks.push(hunk);
      continue;
    }
    if (file && !file.hunks.length && !note) {
      file.header.push(l);
      if (l.startsWith('new file mode')) file.status = 'added';
      else if (l.startsWith('deleted file mode')) file.status = 'deleted';
      else if (l.startsWith('rename from ')) { file.status = 'renamed'; file.old = l.slice(12); } else if (l.startsWith('rename to ')) file.new = l.slice(10);
      else if (l.startsWith('copy from ')) { file.status = 'copied'; file.old = l.slice(10); } else if (l.startsWith('copy to ')) file.new = l.slice(8);
      else if (/^Binary files .* differ$/.test(l) || l === 'GIT binary patch') file.binary = true;
      continue;
    }
    textLine(l);
  }
  return blocks;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// Old and new rows of one hunk side by side: a run of deletions pairs with the additions after it.
function pairs(hunk) {
  const rows = [];
  let o = hunk.oldStart, n = hunk.newStart;
  let dels = [], adds = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
    dels = []; adds = [];
  };
  hunk.lines.forEach((l) => {
    if (l.t === 'del') dels.push({ no: o++, s: l.s, t: 'del' });
    else if (l.t === 'add') adds.push({ no: n++, s: l.s, t: 'add' });
    else if (l.t === 'meta') { flush(); rows.push({ meta: l.s }); } else { flush(); rows.push({ left: { no: o++, s: l.s, t: 'ctx' }, right: { no: n++, s: l.s, t: 'ctx' } }); }
  });
  flush();
  return rows;
}

export function mount(ctx) {
  const content = ctx.$('[data-role="content"]');
  const loading = ctx.$('[data-role="loading"]');
  const expandBtn = ctx.$('[data-role="expand"]'), collapseBtn = ctx.$('[data-role="collapse"]');
  const on = (e, ev, fn) => e.addEventListener(ev, fn, { signal: ctx.signal });
  let blocks = null;
  const folded = new Set();
  const panes = {};

  const fileHead = (f, index) => {
    const head = el('div', 'diff-file-head');
    const btn = el('button', 'diff-fold');
    btn.type = 'button';
    btn.dataset.file = index;
    btn.setAttribute('aria-expanded', String(!folded.has(index)));
    btn.innerHTML = ctx.icon('chevron-right');
    btn.setAttribute('aria-label', 'Fold this file');
    const name = f.status === 'renamed' || f.status === 'copied' ? `${f.old} → ${f.new}` : (f.new || f.old || '(unnamed)');
    head.append(btn, el('span', 'diff-path', name));
    if (f.status !== 'modified') {
      const tone = { added: 'success', deleted: 'danger', renamed: 'info', copied: 'info' }[f.status];
      const badge = el('span', 't-badge', f.status);
      badge.dataset.tone = tone;
      badge.dataset.variant = 'outline';
      head.append(badge);
    }
    if (f.binary) head.append(el('span', 'diff-meta', 'binary'));
    if (f.hunks.length) {
      const counts = el('span', 'diff-counts');
      counts.append(el('span', 'diff-add-count', `+${f.add}`), el('span', 'diff-del-count', `−${f.del}`));
      head.append(counts);
    }
    return head;
  };

  const unifiedHunk = (h, tbody) => {
    const hr = el('tr', 'diff-hunk');
    const hc = el('td', null, `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.section ? ` ${h.section}` : ''}`);
    hc.colSpan = 4;
    hr.append(hc);
    tbody.append(hr);
    let o = h.oldStart, n = h.newStart;
    h.lines.forEach((l) => {
      const tr = el('tr', `diff-line diff-${l.t}`);
      if (l.t === 'meta') {
        const td = el('td', 'diff-code diff-note', l.s);
        td.colSpan = 4;
        tr.append(td);
      } else {
        const oldNo = l.t === 'add' ? '' : o++;
        const newNo = l.t === 'del' ? '' : n++;
        tr.append(el('td', 'diff-no', String(oldNo)), el('td', 'diff-no', String(newNo)),
          el('td', 'diff-sign', l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '), el('td', 'diff-code', l.s));
      }
      tbody.append(tr);
    });
  };

  const splitHunk = (h, tbody) => {
    const hr = el('tr', 'diff-hunk');
    const hc = el('td', null, `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.section ? ` ${h.section}` : ''}`);
    hc.colSpan = 4;
    hr.append(hc);
    tbody.append(hr);
    pairs(h).forEach((r) => {
      const tr = el('tr', 'diff-line');
      if (r.meta) {
        const td = el('td', 'diff-code diff-note', r.meta);
        td.colSpan = 4;
        tr.append(td);
      } else {
        [r.left, r.right].forEach((side) => {
          const no = el('td', `diff-no${side ? ` diff-${side.t}` : ' diff-empty'}`, side ? String(side.no) : '');
          const code = el('td', `diff-code diff-half${side ? ` diff-${side.t}` : ' diff-empty'}`, side ? side.s : '');
          tr.append(no, code);
        });
      }
      tbody.append(tr);
    });
  };

  const build = (view) => {
    const pane = el('div', 'diff-pane');
    pane.dataset.pane = view;
    blocks.forEach((b, index) => {
      if (b.kind === 'text') {
        if (b.lines.every((l) => !l.trim())) return;
        pane.append(el('pre', 'diff-text', b.lines.join('\n')));
        return;
      }
      const card = el('section', 'diff-file');
      card.dataset.file = index;
      card.append(fileHead(b, index));
      const bodyEl = el('div', 'diff-file-body');
      bodyEl.hidden = folded.has(index);
      if (b.hunks.length) {
        const table = el('table', `diff-table diff-${view}`);
        const tbody = el('tbody');
        b.hunks.forEach((h) => (view === 'split' ? splitHunk : unifiedHunk)(h, tbody));
        table.append(tbody);
        bodyEl.append(table);
      } else {
        bodyEl.append(el('div', 'diff-empty-file', b.binary ? 'Binary file, no text changes shown.' : b.header.slice(1).join('\n') || 'No content changes.'));
      }
      card.append(bodyEl);
      pane.append(card);
    });
    content.append(pane);
    panes[view] = pane;
    return pane;
  };

  const show = (view) => {
    if (!blocks) return;
    if (!panes[view]) build(view);
    Object.entries(panes).forEach(([v, p]) => { p.hidden = v !== view; });
  };

  const setFold = (index, fold) => {
    if (fold) folded.add(index); else folded.delete(index);
    Object.values(panes).forEach((p) => {
      const card = p.querySelector(`.diff-file[data-file="${index}"]`);
      if (!card) return;
      card.querySelector('.diff-file-body').hidden = fold;
      card.querySelector('.diff-fold').setAttribute('aria-expanded', String(!fold));
    });
  };
  on(content, 'click', (e) => {
    const head = e.target.closest('.diff-file-head');
    if (!head) return;
    const index = Number(head.parentElement.dataset.file);
    setFold(index, !folded.has(index));
  });
  const files = () => blocks.map((b, i) => (b.kind === 'file' ? i : -1)).filter((i) => i >= 0);
  on(expandBtn, 'click', () => files().forEach((i) => setFold(i, false)));
  on(collapseBtn, 'click', () => files().forEach((i) => setFold(i, true)));

  (async () => {
    try {
      const r = await fetch(ctx.src, { signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = parse(new TextDecoder().decode(await r.arrayBuffer()));
      const fileBlocks = parsed.filter((b) => b.kind === 'file');
      if (!fileBlocks.length) {
        ctx.toast('warning', `No diff in ${ctx.item.name}: it has no file headers or hunks.`);
        ctx.hideView('unified');
        ctx.hideView('split');
        return;
      }
      blocks = parsed;
      const add = fileBlocks.reduce((s, f) => s + f.add, 0), del = fileBlocks.reduce((s, f) => s + f.del, 0);
      ctx.setBadge(parsed.some((b) => b.kind === 'text' && b.lines.some((l) => /^Subject: /.test(l))) ? 'Patch' : 'Diff');
      ctx.setStats(` · ${fileBlocks.length} ${fileBlocks.length === 1 ? 'file' : 'files'} · +${add} −${del}`);
      expandBtn.hidden = collapseBtn.hidden = false;
      show(ctx.view);
    } catch (e) {
      if (e.name === 'AbortError') return;
      ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
    } finally {
      if (loading) loading.hidden = true;
    }
  })();

  return { show };
}
