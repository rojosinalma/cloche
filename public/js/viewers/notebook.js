// Notebook viewer: the server renders the cells and saved outputs
// (?data=notebook, the one download); nothing in the notebook runs. HTML
// outputs sit in sandboxed srcdoc frames whose only script reports the
// height; Markdown diagrams are handed to the diagram module.
export function mount(ctx) {
  const content = ctx.$('[data-role="content"]');
  const loading = ctx.$('[data-role="loading"]');

  // Height reports from this notebook's own output frames only.
  window.addEventListener('message', (e) => {
    const h = e.data && e.data.clocheNotebookHeight;
    if (typeof h !== 'number' || !Number.isFinite(h)) return;
    const frame = [...content.querySelectorAll('iframe.nb-html')].find((f) => f.contentWindow === e.source);
    if (frame) frame.style.height = `${Math.max(24, Math.ceil(h))}px`;
  }, { signal: ctx.signal });

  // HTML outputs follow the page's mode: the frame document gets the same
  // color-scheme as the frame element, so it stays transparent and readable.
  const SCHEME = ':root{color-scheme:light dark}';
  const paint = () => {
    const mode = document.documentElement.dataset.mode === 'light' ? 'light' : 'dark';
    content.querySelectorAll('iframe.nb-html[data-srcdoc]').forEach((f) => {
      const doc = f.dataset.srcdoc.replace(SCHEME, `:root{color-scheme:${mode}}`);
      if (f.srcdoc !== doc) f.srcdoc = doc;
    });
  };
  document.documentElement.addEventListener('t:theme', paint, { signal: ctx.signal });

  (async () => {
    try {
      const r = await fetch(ctx.src, { signal: ctx.signal, headers: { Accept: 'text/html' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      content.innerHTML = await r.text();
      const nb = content.querySelector('.nb-notebook');
      if (!nb || nb.dataset.error) {
        ctx.notice(nb?.dataset.error || 'The notebook could not be rendered.', 'exclamation-triangle');
        return;
      }
      const cells = Number(nb.dataset.cells || 0);
      ctx.setBadge(['Jupyter', nb.dataset.language].filter(Boolean).join(' · '));
      ctx.setStats(` · ${cells.toLocaleString()} cell${cells === 1 ? '' : 's'}`);
      paint();
      ctx.enhance(content);
    } catch (e) {
      if (e.name === 'AbortError') return;
      ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
    } finally {
      if (loading) loading.hidden = true;
    }
  })();
}
