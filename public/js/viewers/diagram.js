// Diagram viewer: Mermaid and Graphviz sources drawn in the browser, for
// .mmd/.mermaid/.dot/.gv files (mount) and for ```mermaid / ```dot blocks in
// rendered Markdown (enhance). Mermaid runs with securityLevel "strict" and
// the palette's colours, and redraws when the theme changes; Graphviz output
// is stripped of scripts, event handlers and non-http(s) links, and takes its
// colours from CSS.
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs';
const VIZ = 'https://cdn.jsdelivr.net/npm/@viz-js/viz@3.31.0/dist/viz.js';

const KINDS = { mmd: 'mermaid', mermaid: 'mermaid', dot: 'dot', gv: 'dot' };
let mermaidLib = null;
let vizLib = null;
let seq = 0;

const once = (get, set, url, init) => get() || set(import(url).then(init).catch((e) => { set(null); throw e; }));
const loadMermaid = () => once(() => mermaidLib, (p) => (mermaidLib = p), MERMAID, (m) => m.default);
const loadViz = () => once(() => vizLib, (p) => (vizLib = p), VIZ, (m) => m.instance());

// A --t-* token resolved to #rrggbb through a canvas pixel: Mermaid's colour
// maths needs plain hex, tokens may be color-mix() or oklch().
const probe = (() => {
  let el = null;
  let g = null;
  return (token) => {
    if (!el) {
      el = document.createElement('span');
      el.hidden = true;
      document.body.append(el);
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      g = c.getContext('2d', { willReadFrequently: true });
    }
    el.style.color = `var(${token})`;
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = getComputedStyle(el).color;
    g.fillRect(0, 0, 1, 1);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    return `#${[r, gr, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };
})();

const mermaidConfig = () => {
  const c = probe;
  const text = c('--t-text'), canvas = c('--t-canvas'), inset = c('--t-inset'), overlay = c('--t-overlay-bg');
  const accent = c('--t-accent'), border = c('--t-border'), muted = c('--t-muted');
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: {
      darkMode: document.documentElement.dataset.mode === 'dark',
      background: canvas, textColor: text, titleColor: text, lineColor: muted,
      primaryColor: inset, primaryTextColor: text, primaryBorderColor: accent,
      secondaryColor: overlay, secondaryTextColor: text, secondaryBorderColor: border,
      tertiaryColor: canvas, tertiaryTextColor: text, tertiaryBorderColor: border,
      mainBkg: inset, nodeBorder: accent, clusterBkg: overlay, clusterBorder: border, edgeLabelBackground: canvas,
      noteBkgColor: overlay, noteTextColor: text, noteBorderColor: border,
      actorBkg: inset, actorBorder: accent, actorTextColor: text, actorLineColor: muted,
      signalColor: text, signalTextColor: text, labelBoxBkgColor: inset, labelBoxBorderColor: border, labelTextColor: text,
      fontFamily: getComputedStyle(document.body).fontFamily
    }
  };
};

// Graphviz output: no scripts, no foreign content, no event handlers, links
// only to http(s) and in a new tab.
const sanitize = (svg) => {
  svg.querySelectorAll('script, foreignObject, iframe, image, use').forEach((n) => n.remove());
  svg.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(a.name);
      else if ((name === 'href' || name === 'xlink:href') && !/^https?:\/\//i.test(a.value.trim())) el.removeAttribute(a.name);
    });
    if (el.localName === 'a' && (el.getAttribute('href') || el.getAttribute('xlink:href'))) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return svg;
};

// Draws one source into host; resolves to nothing, rejects with a short reason.
const draw = async (kind, code, host) => {
  if (kind === 'mermaid') {
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfig());
    const { svg } = await mermaid.render(`cloche-diagram-${++seq}`, code);
    host.innerHTML = svg;
  } else {
    const viz = await loadViz();
    host.replaceChildren(sanitize(viz.renderSVGElement(code)));
  }
  host.dataset.diagram = kind;
};

const reason = (e) => String(e?.message || e || 'unknown error').split('\n').filter((l) => l.trim()).slice(0, 3).join(' ').slice(0, 300);

// Redraws Mermaid diagrams when tailor switches mode, palette or skin: at
// once (a mode switch applies at once) and when a new palette or skin
// stylesheet has loaded.
const onTheme = (signal, redraw) => document.documentElement.addEventListener('t:theme', () => {
  redraw();
  ['t-skin', 't-palette'].map((id) => document.getElementById(id)).filter(Boolean)
    .forEach((link) => link.addEventListener('load', redraw, { once: true, signal }));
}, { signal });

export function mount(ctx) {
  const stage = ctx.$('[data-role="stage"]');
  const loading = ctx.$('[data-role="loading"]');
  const kind = KINDS[ctx.item.format] || 'mermaid';
  let code = null;

  const render = async () => {
    try {
      await draw(kind, code, stage);
      if (ctx.signal.aborted) return;
    } catch (e) {
      if (ctx.signal.aborted) return;
      ctx.notice(`This diagram could not be drawn: ${reason(e)}`, 'exclamation-triangle');
    } finally {
      if (loading) loading.hidden = true;
    }
  };

  (async () => {
    try {
      const r = await fetch(ctx.src, { signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      code = await r.text();
      ctx.setBadge(kind === 'mermaid' ? 'Mermaid' : 'Graphviz');
      if (!code.trim()) { ctx.notice('This diagram file is empty.', 'file-earmark'); return; }
      await render();
      if (kind === 'mermaid') onTheme(ctx.signal, () => { if (stage.isConnected) render(); });
    } catch (e) {
      if (e.name === 'AbortError') return;
      ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
      if (loading) loading.hidden = true;
    }
  })();
}

// ```mermaid / ```dot blocks in rendered Markdown: the code block stays as
// the fallback with a notice when the diagram does not draw.
export function enhance(nodes, ctx) {
  const blocks = nodes.map((node) => {
    const pre = node.querySelector('pre');
    const host = document.createElement('div');
    host.className = 'md-diagram-svg';
    node.append(host);
    return { node, pre, host, kind: node.dataset.diagram === 'dot' ? 'dot' : 'mermaid', code: pre?.textContent || '' };
  });

  const render = (b) => draw(b.kind, b.code, b.host)
    .then(() => { if (b.pre) b.pre.hidden = true; b.node.querySelector('.md-diagram-error')?.remove(); })
    .catch((e) => {
      if (ctx.signal.aborted || b.node.querySelector('.md-diagram-error')) return;
      const note = document.createElement('div');
      note.className = 'file-view-notice md-diagram-error';
      note.innerHTML = ctx.icon('exclamation-triangle');
      note.append(`This diagram could not be drawn: ${reason(e)}`);
      b.node.prepend(note);
    });

  blocks.reduce((p, b) => p.then(() => (ctx.signal.aborted ? null : render(b))), Promise.resolve());
  if (blocks.some((b) => b.kind === 'mermaid')) {
    onTheme(ctx.signal, () => blocks.filter((b) => b.kind === 'mermaid' && b.node.isConnected && b.pre?.hidden).forEach(render));
  }
}
