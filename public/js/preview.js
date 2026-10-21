// Preview modal shell. A file opens over the gallery, never on a page of its
// own, with the viewers the server listed for it (data-viewers on the
// trigger: id, data URL, views). Every view is a tab; a viewer module
// (public/js/viewers/<id>.js) loads on first use and mounts once per opened
// file, so switching tabs never fetches the file twice. Esc / the close button
// / a click on the backdrop close the modal; ←/→ step through the page's
// previewable files; 1–9 pick a tab. Contract: docs/viewers.md.
(function preview() {
  const $ = (id) => document.getElementById(id);
  const box = $('preview');
  if (!box) return;
  const triggers = [...document.querySelectorAll('[data-preview]')];
  if (!triggers.length) return;

  const config = JSON.parse(box.dataset.config || '{}');
  const viewerConf = config.viewers || {};
  const modules = config.modules || {};
  const TAB_KEY = 'cloche.preview-tab.';

  const parseViewers = (raw) => { try { return JSON.parse(raw || '[]'); } catch (e) { return []; } };
  const items = [];
  const indexOf = new Map();
  triggers.forEach((t) => {
    const key = t.dataset.href;
    if (!indexOf.has(key)) {
      indexOf.set(key, items.length);
      items.push({ kind: t.dataset.kind, icon: t.dataset.icon, name: t.dataset.name, download: t.dataset.download,
                   href: key, format: t.dataset.format, size: Number(t.dataset.size || 0),
                   viewers: parseViewers(t.dataset.viewers) });
    }
    t.addEventListener('click', (e) => { e.preventDefault(); show(indexOf.get(key)); });
  });

  // Icons come from the tailor sprite: build one, or swap the symbol an existing <svg class="t-icon"> uses.
  const icon = (name, css = '') => `<svg class="t-icon${css ? ' ' + css : ''}" aria-hidden="true"><use href="/tailor/icons.svg#bi-${name}"/></svg>`;
  const setIcon = (svg, name) => svg.querySelector('use').setAttribute('href', `/tailor/icons.svg#bi-${name}`);
  const humanSize = (b) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return i ? `${b.toFixed(1)} ${units[i]}` : `${b} B`;
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };

  const stage = $('preview-stage'), iconEl = $('preview-icon'), nameEl = $('preview-name'), badge = $('preview-badge'),
        sizeEl = $('preview-size'), statsEl = $('preview-stats'), count = $('preview-count'), dl = $('preview-download'),
        tabBar = $('preview-tabs'), toolBox = $('preview-viewer-tools');

  // Viewer modules by name (public/js/viewers/<name>.js), versioned URLs from the server; one import each.
  const loaded = new Map();
  const load = (name) => {
    if (!modules[name]) return Promise.reject(new Error(`no module viewers/${name}.js`));
    if (!loaded.has(name)) loaded.set(name, import(modules[name]).catch((e) => { loaded.delete(name); throw e; }));
    return loaded.get(name);
  };

  let index = 0;
  let session = null; // the open file: { item, tabs, mounts: Map(viewerId → mount), active }

  // Replaces a viewer root's content with the shared notice panel (too large, failed to load).
  const notice = (root, message, iconName = 'file-earmark-x', download = '#') => {
    const frag = $('preview-tpl-notice').content.cloneNode(true);
    frag.querySelector('[data-role="message"]').textContent = message;
    if (iconName !== 'file-earmark-x') setIcon(frag.querySelector('.t-empty-icon'), iconName);
    frag.querySelectorAll('.preview-download-link').forEach((a) => { a.href = download; });
    root.replaceChildren(frag);
  };

  // Elements marked data-enhance="<module>" inside rendered content are handed
  // to that module's enhance(nodes, ctx), loaded on demand (e.g. diagrams in Markdown).
  const enhance = (el, ctx) => {
    const groups = new Map();
    el.querySelectorAll('[data-enhance]').forEach((n) => {
      if (!groups.has(n.dataset.enhance)) groups.set(n.dataset.enhance, []);
      groups.get(n.dataset.enhance).push(n);
    });
    groups.forEach((nodes, name) => load(name)
      .then((mod) => { if (!ctx.signal.aborted && mod.enhance) mod.enhance(nodes, ctx); })
      .catch((e) => console.error(`enhance ${name}:`, e)));
  };

  const isActive = (s, viewerId) => session === s && s.active && s.active.viewer.id === viewerId && !box.hidden;

  const paintMeta = (mount) => {
    badge.hidden = !mount?.badge;
    badge.textContent = mount?.badge || '';
    statsEl.textContent = mount?.stats || '';
  };

  const createMount = (s, viewer) => {
    const item = s.item;
    const root = document.createElement('div');
    root.className = 'preview-view';
    root.dataset.viewer = viewer.id;
    const tools = document.createElement('div');
    tools.className = 't-cluster viewer-tools';
    tools.dataset.viewer = viewer.id;
    stage.append(root);
    toolBox.append(tools);
    const ac = new AbortController();
    const mount = { viewer, root, tools, ac, handle: null, badge: '', stats: '', view: null };
    const conf = viewerConf[viewer.id] || {};

    if (conf.max && item.size > conf.max) {
      notice(root, `This file is ${humanSize(item.size)}, above the ${conf.max_label} viewer limit.`, 'file-earmark-x', item.download);
      mount.ready = Promise.resolve(null);
      return mount;
    }

    const tpl = $(`preview-tpl-${viewer.id}`);
    if (tpl) {
      const frag = tpl.content.cloneNode(true);
      const toolSlot = frag.querySelector('[data-slot="tools"]');
      const bodySlot = frag.querySelector('[data-slot="body"]');
      if (toolSlot) tools.append(...toolSlot.childNodes);
      if (bodySlot) root.append(...bodySlot.childNodes);
    }
    [root, tools].forEach((el) => el.querySelectorAll('.preview-download-link').forEach((a) => { a.href = item.download; }));

    const ctx = {
      item: { name: item.name, href: item.href, download: item.download, size: item.size, format: item.format, kind: item.kind },
      viewer: { id: viewer.id, views: viewer.views, ...conf },
      src: viewer.src,
      get view() { return mount.view; },
      root, tools, box, stage,
      signal: ac.signal,
      $: (sel) => root.querySelector(sel) || tools.querySelector(sel),
      isActive: () => isActive(s, viewer.id),
      setBadge: (text) => { mount.badge = text || ''; if (isActive(s, viewer.id)) paintMeta(mount); },
      setStats: (text) => { mount.stats = text || ''; if (isActive(s, viewer.id)) paintMeta(mount); },
      hideView: (viewId) => hideTab(s, `${viewer.id}:${viewId}`),
      notice: (message, iconName) => notice(root, message, iconName, item.download),
      enhance: (el) => enhance(el, ctx),
      load,
      icon, humanSize,
      toast: (tone, message) => toast(tone, message)
    };

    mount.ready = load(viewer.id)
      .then(async (mod) => {
        if (ac.signal.aborted) return null;
        const handle = (await mod.mount(ctx)) || null;
        if (ac.signal.aborted) { handle?.dispose?.(); return null; }
        mount.handle = handle;
        return handle;
      })
      .catch((e) => {
        if (ac.signal.aborted) return null;
        console.error(e);
        notice(root, `The ${conf.label || viewer.id} viewer could not be loaded: ${e.message}`, 'exclamation-triangle', item.download);
        return null;
      });
    return mount;
  };

  const activate = (s, key, remember = false) => {
    const tab = s.tabs.find((t) => t.key === key);
    if (!tab) return;
    const prev = s.active;
    s.active = tab;
    s.tabs.forEach((t) => t.btn.setAttribute('aria-pressed', String(t === tab)));
    if (remember) store.set(TAB_KEY + s.primary, key);
    if (prev && prev.viewer.id !== tab.viewer.id) {
      const old = s.mounts.get(prev.viewer.id);
      if (old) { old.root.hidden = true; old.tools.hidden = true; old.handle?.hide?.(); }
    }
    let mount = s.mounts.get(tab.viewer.id);
    if (!mount) { mount = createMount(s, tab.viewer); s.mounts.set(tab.viewer.id, mount); }
    mount.root.hidden = false;
    mount.tools.hidden = false;
    mount.view = tab.view.id;
    box.dataset.viewer = tab.viewer.id;
    box.dataset.view = tab.view.id;
    paintMeta(mount);
    mount.ready.then((h) => { if (s.active === tab && session === s) h?.show?.(tab.view.id); });
  };

  // A viewer drops a tab it cannot offer for this file (e.g. Pretty for JSON that does not parse).
  const hideTab = (s, key) => {
    const i = s.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const [tab] = s.tabs.splice(i, 1);
    tab.btn.remove();
    tabBar.hidden = s.tabs.length < 2;
    if (s.active === tab && s.tabs.length) {
      activate(s, (s.tabs.find((t) => t.viewer.id === tab.viewer.id) || s.tabs[0]).key);
    }
  };

  const buildTabs = (s) => {
    tabBar.replaceChildren();
    s.tabs = s.item.viewers.flatMap((viewer) => (viewer.views || []).map((view) => ({ key: `${viewer.id}:${view.id}`, viewer, view })));
    s.tabs.forEach((tab, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 't-btn';
      b.dataset.size = 'sm';
      b.dataset.tab = tab.key;
      b.setAttribute('aria-pressed', 'false');
      b.textContent = tab.view.label;
      b.dataset.tip = `${tab.view.tip || tab.view.label}${i < 9 ? ` (${i + 1})` : ''}`;
      tabBar.append(b);
      tab.btn = b;
    });
    tabBar.hidden = s.tabs.length < 2;
  };

  const dispose = (s) => {
    if (!s) return;
    s.mounts.forEach((m) => {
      try { m.handle?.dispose?.(); } catch (e) { console.error(e); }
      m.ac.abort();
      m.root.remove();
      m.tools.remove();
    });
    s.mounts.clear();
  };

  const show = (i) => {
    dispose(session);
    index = (i + items.length) % items.length;
    const item = items[index];
    const s = { item, tabs: [], mounts: new Map(), active: null, primary: item.viewers[0]?.id || item.kind };
    session = s;
    setIcon(iconEl, item.icon || 'file-earmark');
    nameEl.textContent = item.name;
    sizeEl.textContent = item.size ? humanSize(item.size) : '';
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    dl.href = item.download;
    box.dataset.kind = item.kind;
    paintMeta(null);
    buildTabs(s);
    if (box.hidden) { box.hidden = false; document.body.classList.add('preview-open'); }
    if (!s.tabs.length) {
      const root = document.createElement('div');
      root.className = 'preview-view';
      stage.append(root);
      s.mounts.set('', { root, tools: document.createElement('div'), ac: new AbortController() });
      notice(root, 'No viewer can show this file.', 'file-earmark-x', item.download);
    } else {
      const remembered = store.get(TAB_KEY + s.primary);
      activate(s, (s.tabs.find((t) => t.key === remembered) || s.tabs[0]).key);
    }
    history.replaceState(null, '', `#v=${item.href}`);
  };

  const close = () => {
    if (box.hidden) return;
    dispose(session);
    session = null;
    box.hidden = true;
    document.body.classList.remove('preview-open');
    if (location.hash.startsWith('#v=')) history.replaceState(null, '', location.pathname + location.search);
  };

  const stepTab = (delta) => {
    const s = session;
    if (!s || s.tabs.length < 2) return;
    const i = s.tabs.indexOf(s.active);
    const next = s.tabs[(i + delta + s.tabs.length) % s.tabs.length];
    activate(s, next.key, true);
    next.btn.focus();
  };

  tabBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b && session) activate(session, b.dataset.tab, true);
  });
  $('preview-close').addEventListener('click', close);
  $('preview-prev').addEventListener('click', () => show(index - 1));
  $('preview-next').addEventListener('click', () => show(index + 1));
  stage.addEventListener('click', (e) => { if (e.target === stage || e.target.classList.contains('preview-view')) close(); });
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const typing = /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(e.target.tagName) || e.target.isContentEditable;
    const handle = session?.active && session.mounts.get(session.active.viewer.id)?.handle;
    if (e.key === 'Escape') { close(); return; }
    const pressing = (e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a, [role="button"]');
    if (!typing && !pressing && handle?.key?.(e)) { e.preventDefault(); return; }
    if (tabBar.contains(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      stepTab(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'ArrowLeft' && !typing) show(index - 1);
    else if (e.key === 'ArrowRight' && !typing) show(index + 1);
    else if (!typing && !tabBar.hidden && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tab = session?.tabs[Number(e.key) - 1];
      if (tab) activate(session, tab.key, true);
    }
  });

  const fromHash = () => {
    if (!location.hash.startsWith('#v=')) return;
    const raw = location.hash.slice(3);
    const i = indexOf.get(raw) ?? indexOf.get(decodeURIComponent(raw));
    if (i !== undefined) show(i);
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);
})();
