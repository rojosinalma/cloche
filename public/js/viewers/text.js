// Text viewer: fetches the rendered card (?data=text, the one download) and
// switches between its Pretty and Source panes. Copy takes the Source pane's text.
export function mount(ctx) {
  const content = ctx.$('[data-role="content"]');
  const loading = ctx.$('[data-role="loading"]');
  const copy = ctx.$('[data-role="copy"]');
  let card = null;

  const apply = (view) => {
    if (!card) return;
    card.querySelectorAll('.view-pane').forEach((p) => { p.hidden = p.dataset.pane !== view; });
  };

  copy.addEventListener('click', async () => {
    const pane = content.querySelector('.view-pane[data-pane="source"]');
    if (!pane) return;
    try {
      await navigator.clipboard.writeText(pane.textContent.replace(/\n$/, ''));
      ctx.toast('success', 'Copied to clipboard');
    } catch (e) {
      ctx.toast('error', `Could not copy: ${e.message}`);
    }
  }, { signal: ctx.signal });

  (async () => {
    try {
      const r = await fetch(ctx.src, { signal: ctx.signal, headers: { Accept: 'text/html' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      content.innerHTML = await r.text();
      card = content.querySelector('.text-card');
      ctx.setBadge(card?.dataset.label || '');
      const lines = Number(card?.dataset.lines || 0);
      ctx.setStats(lines ? ` · ${lines.toLocaleString()} line${lines === 1 ? '' : 's'}` : '');
      copy.hidden = card?.dataset.copy !== '1';
      if (card?.dataset.pretty !== '1') ctx.hideView('pretty');
      apply(ctx.view);
      ctx.enhance(content);
    } catch (e) {
      if (e.name === 'AbortError') return;
      ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
    } finally {
      if (loading) loading.hidden = true;
    }
  })();

  return { show: apply };
}
