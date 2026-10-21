// HTML viewer: the page from ?data=html in an <iframe sandbox="allow-scripts">.
// The response carries "Content-Security-Policy: sandbox allow-scripts" too,
// so the page runs in an opaque origin whether it is framed here or opened on
// its own. The server rewrites relative assets to part URLs of the same route.
export function mount(ctx) {
  const frame = ctx.$('[data-role="frame"]');
  const loading = ctx.$('[data-role="loading"]');
  frame.addEventListener('load', () => { loading.hidden = true; }, { signal: ctx.signal });
  frame.src = ctx.src;
  return {
    dispose() { frame.removeAttribute('src'); }
  };
}
