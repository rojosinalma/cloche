// ANSI viewer: terminal output with SGR colours and styles from ?data=ansi
// (the one download). The 16 basic colours map to palette tokens; 256-colour
// and truecolour values map to the nearest palette hue (or grey), so every
// palette and both modes stay readable. Other escapes (cursor moves, titles,
// links) are dropped; a lone CR starts the line again, as a terminal would.
// Text only ever goes in as text nodes.
const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'grey', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'bright'];
const HUES = [['red', 0], ['orange', 30], ['yellow', 58], ['green', 120], ['cyan', 180], ['blue', 225], ['purple', 270], ['magenta', 300], ['pink', 335], ['red', 360]];
const CUBE = [0, 95, 135, 175, 215, 255];
// CSI (SGR when it ends in m), OSC (to BEL or ST), DCS/SOS/PM/APC (to ST), a two-byte escape, or a lone ESC.
const ESCAPE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])?/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

// RGB → palette name: low saturation is a grey step, the rest the nearest hue.
export function nearest(r, g, b) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.25 || d < 0.15) return l < 0.25 ? 'black' : l < 0.55 ? 'grey' : l < 0.85 ? 'white' : 'bright';
  const [R, G, B] = [r / 255, g / 255, b / 255];
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return HUES.reduce((best, [name, at]) => (Math.abs(h - at) < best[1] ? [name, Math.abs(h - at)] : best), ['red', 999])[0];
}

export function colour256(n) {
  if (!(n >= 0 && n <= 255)) return null;
  if (n < 16) return BASIC[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return nearest(v, v, v); }
  const i = n - 16;
  return nearest(CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]);
}

const fresh = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, hidden: false, strike: false });

// Applies one SGR parameter list ("1;31", "38;5;208", "38:2::255:0:0") to state.
export function sgr(state, params) {
  const ps = params === '' ? ['0'] : params.split(';');
  const extended = (code, rest) => {
    const mode = Number(rest[0]);
    let name = null;
    if (mode === 5) name = colour256(Number(rest[1]));
    else if (mode === 2) {
      const [r, g, b] = rest.length >= 5 ? rest.slice(-3) : rest.slice(1, 4);
      if ([r, g, b].every((v) => Number(v) >= 0 && Number(v) <= 255 && v !== '')) name = nearest(Number(r), Number(g), Number(b));
    }
    if (name) state[code === 38 ? 'fg' : 'bg'] = name;
    return mode === 5 ? 2 : mode === 2 ? 4 : 1;
  };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.includes(':')) {
      const sub = p.split(':');
      const code = Number(sub[0]);
      if (code === 38 || code === 48) extended(code, sub.slice(1));
      else if (code === 4) state.underline = sub[1] !== '0';
      continue;
    }
    const n = p === '' ? 0 : Number(p);
    if (n === 38 || n === 48) { i += extended(n, ps.slice(i + 1, i + 5)); continue; }
    if (n === 0) Object.assign(state, fresh());
    else if (n === 1) state.bold = true;
    else if (n === 2) state.dim = true;
    else if (n === 3) state.italic = true;
    else if (n === 4 || n === 21) state.underline = true;
    else if (n === 7) state.inverse = true;
    else if (n === 8) state.hidden = true;
    else if (n === 9) state.strike = true;
    else if (n === 22) { state.bold = false; state.dim = false; } else if (n === 23) state.italic = false;
    else if (n === 24) state.underline = false;
    else if (n === 27) state.inverse = false;
    else if (n === 28) state.hidden = false;
    else if (n === 29) state.strike = false;
    else if (n >= 30 && n <= 37) state.fg = BASIC[n - 30];
    else if (n === 39) state.fg = null;
    else if (n >= 40 && n <= 47) state.bg = BASIC[n - 40];
    else if (n === 49) state.bg = null;
    else if (n >= 90 && n <= 97) state.fg = BASIC[n - 90 + 8];
    else if (n >= 100 && n <= 107) state.bg = BASIC[n - 100 + 8];
  }
}

export function classes(s) {
  const out = [];
  if (s.inverse) {
    out.push(`ansi-i-${s.fg || 'default'}`, 'ansi-f-canvas');
  } else {
    if (s.fg) out.push(`ansi-f-${s.fg}`);
    if (s.bg) out.push(`ansi-b-${s.bg}`);
  }
  if (s.bold) out.push('ansi-bold');
  if (s.dim) out.push('ansi-dim');
  if (s.italic) out.push('ansi-italic');
  if (s.underline) out.push('ansi-u');
  if (s.strike) out.push('ansi-s');
  if (s.hidden) out.push('ansi-hidden');
  return out.join(' ');
}

// Text → lines of [text, className] segments.
export function parse(text) {
  const lines = [];
  let line = [];
  const state = fresh();
  let cls = '';
  let found = 0;
  const put = (chunk) => {
    const parts = chunk.split(/(\r\n|\n|\r)/);
    parts.forEach((part, k) => {
      if (k % 2 === 1) {
        if (part === '\r') line = []; else { lines.push(line); line = []; }
        return;
      }
      const clean = part.replace(CONTROL, '');
      if (clean) line.push([clean, cls]);
    });
  };
  let at = 0;
  ESCAPE.lastIndex = 0;
  for (let m = ESCAPE.exec(text); m; m = ESCAPE.exec(text)) {
    if (m.index > at) put(text.slice(at, m.index));
    at = ESCAPE.lastIndex;
    if (m[2] === 'm') { sgr(state, m[1]); cls = classes(state); found++; }
  }
  if (at < text.length) put(text.slice(at));
  if (line.length) lines.push(line);
  return { lines, found };
}

export function mount(ctx) {
  const box = ctx.$('[data-role="lines"]');
  const loading = ctx.$('[data-role="loading"]');
  (async () => {
    try {
      const r = await fetch(ctx.src, { signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { lines } = parse(new TextDecoder().decode(await r.arrayBuffer()));
      const frag = document.createDocumentFragment();
      lines.forEach((segments) => {
        const div = document.createElement('div');
        div.className = 'line';
        segments.forEach(([text, cls]) => {
          if (!cls) { div.append(text); return; }
          const span = document.createElement('span');
          span.className = cls;
          span.textContent = text;
          div.append(span);
        });
        frag.append(div);
      });
      box.replaceChildren(frag);
      ctx.setBadge('ANSI');
      ctx.setStats(` · ${lines.length.toLocaleString()} ${lines.length === 1 ? 'line' : 'lines'}`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      ctx.notice(`Could not load ${ctx.item.name}: ${e.message}`, 'exclamation-triangle');
    } finally {
      if (loading) loading.hidden = true;
    }
  })();
  return null;
}
