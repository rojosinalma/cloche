// Share link dialog on /s/<id>/: create, copy and revoke external links (/x/<token>/).
(function shareLinks() {
  const dlg = document.getElementById('link-modal');
  if (!dlg) return;
  const url = dlg.dataset.linksUrl;
  const rows = document.getElementById('link-rows');
  const table = document.getElementById('link-table');
  const empty = document.getElementById('link-empty');
  const template = document.getElementById('link-row-template');
  const createBtn = document.getElementById('link-create');
  const created = document.getElementById('link-created');
  const createdUrl = document.getElementById('link-url');
  const createLabel = createBtn.innerHTML;

  const request = async (method, path = '', body) => {
    const res = await fetch(url + path, {
      method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let r;
    try { r = await res.json(); } catch (e) { throw new Error(`HTTP ${res.status}`); }
    if (!r.ok) throw new Error(r.message || `HTTP ${res.status}`);
    return r;
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const tmp = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
      tmp.className = 't-visually-hidden';
      dlg.append(tmp);
      tmp.select();
      const done = document.execCommand('copy');
      tmp.remove();
      if (!done) return toast('error', 'Could not copy the link: select it and copy it by hand');
    }
    toast('success', 'Link copied');
  };

  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const meta = (l) => {
    const parts = [l.expires_at ? `expires ${when(l.expires_at)}` : 'until revoked'];
    if (l.downloads) parts.push(`${l.downloads} download${l.downloads === 1 ? '' : 's'}`);
    return parts.join(' · ');
  };

  const syncEmpty = () => {
    const none = rows.children.length === 0;
    table.hidden = none;
    empty.hidden = !none;
  };

  const row = (l) => {
    const tr = template.content.firstElementChild.cloneNode(true);
    tr.dataset.id = l.id;
    const u = tr.querySelector('[data-role=url]');
    u.textContent = l.url;
    u.dataset.tip = l.url;
    tr.querySelector('[data-role=meta]').textContent = meta(l);
    tr.querySelector('[data-role=copy]').addEventListener('click', () => copy(l.url));
    tr.querySelector('[data-role=revoke]').addEventListener('click', () => revoke(tr, l));
    return tr;
  };

  const render = (links) => {
    rows.replaceChildren(...links.map(row));
    syncEmpty();
  };

  // Optimistic: the row goes at once; a failure puts it back where it was.
  const revoke = async (tr, l) => {
    const next = tr.nextSibling;
    tr.remove();
    syncEmpty();
    if (createdUrl.value === l.url) created.hidden = true;
    try {
      const r = await request('DELETE', `/${l.id}`);
      toast('success', r.message);
    } catch (e) {
      rows.insertBefore(tr, next && next.parentNode === rows ? next : null);
      syncEmpty();
      toast('error', `Could not revoke: ${e.message}`);
    }
  };

  const load = async () => {
    try {
      render((await request('GET')).links);
    } catch (e) {
      toast('error', `Could not load links: ${e.message}`);
    }
  };

  createBtn.addEventListener('click', async () => {
    const ttl = dlg.querySelector('input[name=link-ttl]:checked');
    createBtn.disabled = true;
    createBtn.setAttribute('aria-busy', 'true');
    createBtn.innerHTML = '<span class="t-spinner" data-size="sm" role="status"></span>';
    try {
      const r = await request('POST', '', { ttl: ttl ? Number(ttl.value) : undefined });
      createdUrl.value = r.url;
      created.hidden = false;
      rows.append(row(r));
      syncEmpty();
      toast('success', r.message);
    } catch (e) {
      toast('error', `Could not create the link: ${e.message}`);
    } finally {
      createBtn.disabled = false;
      createBtn.removeAttribute('aria-busy');
      createBtn.innerHTML = createLabel;
    }
  });

  document.getElementById('link-copy').addEventListener('click', () => copy(createdUrl.value));
  document.querySelectorAll('[data-dialog-open="link-modal"]').forEach((b) => b.addEventListener('click', () => {
    created.hidden = true;
    load();
  }));
  syncEmpty();
})();
