// G-code viewer. Three tabs: Toolpath (three.js lines; the file is parsed in
// a Web Worker, extrusions coloured by feature or layer, travel moves on a
// toggle, a From/To layer range whose top layer stands out), Info (the
// slicer's header, read by the server: ?data=gcode&part=info) and Source
// (the first part of the text: &part=source). A .gcode.3mf is unzipped in
// the worker; a bundle with several plates gets a plate picker. Nothing
// loads before its tab is shown; the toolpath fetch is the one download.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Same three.js release as the import map in views/preview_modal.erb (workers have no import map).
const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/fflate.module.js';
const COLOUR_KEY = 'cloche.gcode-colour';
const DIM_OPACITY = 0.22; // layers below the highlighted top layer

// Feature names (Bambu/Orca "; FEATURE:", Prusa/Cura ";TYPE:") → palette hues; the first match wins.
const FEATURE_HUES = [
  [/outer|external|wall-outer/i, 'orange'], [/overhang/i, 'magenta', 'pink'], [/inner|perimeter|wall/i, 'yellow'],
  [/bridge/i, 'blue', 'cyan'], [/top/i, 'pink'], [/bottom/i, 'teal', 'cyan'], [/solid|skin/i, 'purple'],
  [/gap/i, 'teal', 'green'], [/support|interface/i, 'green'], [/skirt|brim/i, 'cyan'],
  [/infill|fill/i, 'red'], [/tower|wipe|purge|prime|custom|unlabelled/i, null]
];
const CYCLE = ['cyan', 'green', 'purple', 'pink', 'orange', 'yellow', 'red'];

const tokenValue = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const cssColor = (name, fallback = '--t-text') => new THREE.Color(tokenValue(name) || tokenValue(fallback) || '#888888');
const hueToken = (hues) => hues.map((h) => `--t-hue-${h}`).find((t) => tokenValue(t)) || '--t-disabled';
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One token per feature: known names get their hue, the others the hues still free, in turn.
function featureTokens(names) {
  const tokens = names.map((name) => {
    const rule = FEATURE_HUES.find(([re]) => re.test(name));
    if (!rule) return null;
    return rule[1] ? hueToken(rule.slice(1)) : '--t-disabled';
  });
  const free = CYCLE.map((h) => hueToken([h])).filter((t) => !tokens.includes(t));
  let next = 0;
  return tokens.map((t) => t || (free.length ? free[next++ % free.length] : hueToken([CYCLE[next++ % CYCLE.length]])));
}

// Cura writes WALL-OUTER, the others "Outer wall": one readable form for the legend.
const featureLabel = (name) => (/^[A-Z0-9_-]+$/.test(name)
  ? (name.charAt(0) + name.slice(1).toLowerCase()).replace(/[-_]/g, ' ')
  : name);

// G-code source with light highlighting: commands, parameters, comments.
function sourceHtml(text) {
  return text.split('\n').map((line) => {
    const cut = line.indexOf(';');
    const code = cut < 0 ? line : line.slice(0, cut);
    const comment = cut < 0 ? '' : `<span class="c1">${escapeHtml(line.slice(cut))}</span>`;
    const html = escapeHtml(code).replace(/^(\s*)([GMT]\d+(?:\.\d+)?)/i, '$1<span class="k">$2</span>')
      .replace(/(\s)([A-Z])(-?[\d.]+)/gi, '$1<span class="nv">$2</span><span class="m">$3</span>');
    return `<span class="line">${html}${comment}</span>`;
  }).join('');
}

// ─── The worker: runs from a Blob URL, so it can reference nothing outside this function. ───
function worker() {
  const ARC_MM = 1;      // arc segment length (G2/G3)
  const ARC_MAX = 64;    // segments per arc at most
  let pos = 0;           // read position of num()

  self.onmessage = async (msg) => {
    try {
      let bytes = new Uint8Array(msg.data.buffer);
      if (msg.data.entry) {
        const fflate = await import(msg.data.fflate);
        const files = fflate.unzipSync(bytes, { filter: (f) => f.name === msg.data.entry });
        bytes = files[msg.data.entry];
        if (!bytes) throw new Error(`${msg.data.entry} is not in the archive`);
      }
      const r = parse(bytes, msg.data.maxMoves);
      self.postMessage({ result: r }, [r.ext.buffer, r.feat.buffer, r.travel.buffer, r.starts.buffer, r.tstarts.buffer, r.zs.buffer]);
    } catch (e) {
      self.postMessage({ error: String((e && e.message) || e) });
    }
  };

  function parse(buf, maxMoves) {
    const n = buf.length;
    let ext = new Float32Array(6 * 4096), feat = new Uint8Array(4096), travel = new Float32Array(6 * 4096);
    let segN = 0, trvN = 0, truncated = false;
    const starts = [0], tstarts = [0], zs = [];
    const features = [], featureIndex = new Map();
    let cur = -1;
    let x = 0, y = 0, z = 0, e = 0, absXYZ = true, absE = true;
    let markers = false, pending = false, pendingT = 0, layerHas = false, layerZ = 0;
    let filament = 0, lines = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let nextProgress = n / 20;

    const grow = (a, need) => { if (need <= a.length) return a; const b = new a.constructor(Math.max(need, a.length * 2)); b.set(a); return b; };
    const full = () => { if (segN + trvN >= maxMoves) { truncated = true; return true; } return false; };
    const featureOf = (name) => {
      if (!featureIndex.has(name)) {
        if (features.length >= 255) return features.length - 1;
        featureIndex.set(name, features.length);
        features.push(name);
      }
      return featureIndex.get(name);
    };
    const pushExt = (x0, y0, z0, x1, y1, z1) => {
      if (full()) return;
      ext = grow(ext, segN * 6 + 6);
      feat = grow(feat, segN + 1);
      const o = segN * 6;
      ext[o] = x0; ext[o + 1] = y0; ext[o + 2] = z0; ext[o + 3] = x1; ext[o + 4] = y1; ext[o + 5] = z1;
      if (cur < 0) cur = featureOf('Unlabelled');
      feat[segN++] = cur;
      for (const [px, py, pz] of [[x0, y0, z0], [x1, y1, z1]]) {
        if (px < min[0]) min[0] = px; if (px > max[0]) max[0] = px;
        if (py < min[1]) min[1] = py; if (py > max[1]) max[1] = py;
        if (pz < min[2]) min[2] = pz; if (pz > max[2]) max[2] = pz;
      }
    };
    const pushTravel = (x0, y0, z0, x1, y1, z1) => {
      if (full()) return;
      travel = grow(travel, trvN * 6 + 6);
      const o = trvN * 6;
      travel[o] = x0; travel[o + 1] = y0; travel[o + 2] = z0; travel[o + 3] = x1; travel[o + 4] = y1; travel[o + 5] = z1;
      trvN++;
    };
    const beginExtrusion = (zv) => {
      if (layerHas && (markers ? pending : Math.abs(zv - layerZ) > 1e-4)) {
        starts.push(segN);
        tstarts.push(markers ? pendingT : trvN);
        layerHas = false;
      }
      pending = false;
      if (!layerHas) { layerHas = true; layerZ = zv; zs.push(zv); }
    };

    const num = (k, stop) => {
      let sign = 1, v = 0, any = false;
      if (buf[k] === 45) { sign = -1; k++; } else if (buf[k] === 43) k++;
      while (k < stop) { const d = buf[k] - 48; if (d < 0 || d > 9) break; v = v * 10 + d; k++; any = true; }
      if (buf[k] === 46) {
        k++;
        let f = 0.1;
        while (k < stop) { const d = buf[k] - 48; if (d < 0 || d > 9) break; v += d * f; f *= 0.1; k++; any = true; }
      }
      pos = k;
      return any ? sign * v : NaN;
    };

    const comment = (p, end) => {
      while (p < end && (buf[p] === 32 || buf[p] === 9 || buf[p] === 59)) p++;
      const c = buf[p] | 32;
      if (c !== 108 && c !== 99 && c !== 102 && c !== 116) return; // l, c, f, t
      const text = String.fromCharCode.apply(null, buf.subarray(p, Math.min(end, p + 120))).trim();
      if (/^(LAYER_CHANGE|CHANGE_LAYER)$/i.test(text) || /^LAYER:\s*-?\d+$/.test(text)) {
        markers = true;
        if (!pending) pendingT = trvN;
        pending = true;
        return;
      }
      const m = /^(?:FEATURE|TYPE)\s*:\s*(.+)$/i.exec(text);
      if (m) cur = featureOf(m[1].trim());
    };

    const arc = (cw, x1, y1, z1, i, j, extruding) => {
      const cx = x + i, cy = y + j, r = Math.hypot(i, j);
      const a0 = Math.atan2(y - cy, x - cx);
      let sweep = Math.atan2(y1 - cy, x1 - cx) - a0;
      if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; } else if (sweep <= 1e-9) sweep += 2 * Math.PI;
      const steps = Math.max(1, Math.min(ARC_MAX, Math.ceil((Math.abs(sweep) * r) / ARC_MM)));
      let px = x, py = y, pz = z;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, a = a0 + sweep * t;
        const qx = s === steps ? x1 : cx + r * Math.cos(a), qy = s === steps ? y1 : cy + r * Math.sin(a), qz = z + (z1 - z) * t;
        (extruding ? pushExt : pushTravel)(px, py, pz, qx, qy, qz);
        px = qx; py = qy; pz = qz;
      }
    };

    const line = (p, end) => {
      while (p < end && (buf[p] === 32 || buf[p] === 9)) p++;
      if (p >= end) return;
      if (buf[p] === 59) { comment(p + 1, end); return; }
      let stop = end;
      for (let k = p; k < end; k++) if (buf[k] === 59 || buf[k] === 40) { stop = k; break; }
      if ((buf[p] | 32) === 110) { num(p + 1, stop); p = pos; while (p < stop && buf[p] === 32) p++; } // N123 line numbers
      const letter = buf[p] | 32;
      if (letter !== 103 && letter !== 109) return; // g, m
      const code = num(p + 1, stop);
      if (Number.isNaN(code)) return;
      lines++;
      if (letter === 109) {
        if (code === 82) absE = true; else if (code === 83) absE = false;
        return;
      }
      let X = NaN, Y = NaN, Z = NaN, E = NaN, I = 0, J = 0;
      let has = 0;
      for (let k = pos; k < stop;) {
        const c = buf[k] | 32;
        if (c < 97 || c > 122) { k++; continue; }
        const v = num(k + 1, stop);
        k = pos > k + 1 ? pos : k + 1;
        if (Number.isNaN(v)) continue;
        if (c === 120) { X = v; has |= 1; } else if (c === 121) { Y = v; has |= 2; } else if (c === 122) { Z = v; has |= 4; }
        else if (c === 101) { E = v; has |= 8; } else if (c === 105) I = v; else if (c === 106) J = v;
      }
      if (code === 90) { absXYZ = true; return; }
      if (code === 91) { absXYZ = false; return; }
      if (code === 92) { if (has & 1) x = X; if (has & 2) y = Y; if (has & 4) z = Z; if (has & 8) e = E; return; }
      if (code === 28) { if (!(has & 7) || has & 1) x = 0; if (!(has & 7) || has & 2) y = 0; if (!(has & 7) || has & 4) z = 0; return; }
      if (code > 3) return;
      const nx = has & 1 ? (absXYZ ? X : x + X) : x;
      const ny = has & 2 ? (absXYZ ? Y : y + Y) : y;
      const nz = has & 4 ? (absXYZ ? Z : z + Z) : z;
      let de = 0;
      if (has & 8) { de = absE ? E - e : E; e = absE ? E : e + E; }
      const moved = nx !== x || ny !== y;
      const isArc = code >= 2 && (I !== 0 || J !== 0);
      if (de > 1e-9 && moved || de > 1e-9 && isArc) {
        beginExtrusion(nz);
        filament += de;
        if (isArc) arc(code === 2, nx, ny, nz, I, J, true); else pushExt(x, y, z, nx, ny, nz);
      } else if (moved || nz !== z) {
        if (isArc) arc(code === 2, nx, ny, nz, I, J, false); else pushTravel(x, y, z, nx, ny, nz);
      }
      x = nx; y = ny; z = nz;
    };

    let start = 0;
    for (let i = 0; i <= n && !truncated; i++) {
      if (i < n && buf[i] !== 10) continue;
      line(start, i);
      start = i + 1;
      if (i > nextProgress) { self.postMessage({ progress: i / n }); nextProgress += n / 20; }
    }
    starts.push(segN);
    tstarts.push(trvN);
    return {
      ext: ext.slice(0, segN * 6), feat: feat.slice(0, segN), travel: travel.slice(0, trvN * 6),
      starts: Uint32Array.from(starts), tstarts: Uint32Array.from(tstarts), zs: Float32Array.from(zs),
      features, segments: segN, travels: trvN, truncated, filament, lines,
      bbox: segN ? { min, max } : null
    };
  }
}

// ─── The viewer ───
export function mount(ctx) {
  const pick = (role) => ctx.$(`[data-role="${role}"]`);
  const pane = (id) => ctx.root.querySelector(`[data-pane="${id}"]`);
  const els = {
    notice: pick('notice'), stage: pick('stage'), loading: pick('loading'), loadingText: pick('loading-text'),
    error: pick('error'), errorText: pick('error-text'), legend: pick('legend'), layers: pick('layers'),
    from: pick('from'), to: pick('to'), layerLabel: pick('layer-label'), tools: pick('toolpath-tools'),
    plate: pick('plate'), fit: pick('fit'), travel: pick('travel'), grid: pick('grid'),
    infoLoading: pick('info-loading'), infoRows: pick('info-rows'), thumb: pick('thumb'),
    sourceLoading: pick('source-loading'), source: pick('source')
  };
  const { signal } = ctx;
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal });
  const bundle = /\.gcode\.3mf$/i.test(ctx.item.name);
  ctx.setBadge(bundle ? 'G-code 3MF' : 'G-code');

  let plate = null;
  let info = null;        // promise of the info JSON for the current plate
  let infoTable = null;   // info-table.js
  let source = null;      // promise, once per plate
  let tp = null;          // the toolpath scene, once built
  let zipBuffer = null;   // a bundle with several plates keeps its bytes for switching
  let view = null;

  const setNotice = (text) => { els.notice.hidden = !text; els.notice.querySelector('span').textContent = text || ''; };
  const withPlate = (url) => (plate ? `${url}&plate=${plate}` : url);
  const fetchJson = async (part) => {
    const r = await fetch(withPlate(`${ctx.src}&part=${part}`), { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const loadInfo = () => { info = fetchJson('info').catch((e) => ({ ok: false, message: `The header could not be read: ${e.message}` })); return info; };

  // ── Info ──
  const showInfo = async () => {
    const data = await info;
    infoTable = infoTable || await ctx.load('info-table');
    if (signal.aborted || view !== 'info') return;
    els.infoLoading.hidden = true;
    if (!data.ok) { setNotice(data.message); infoTable.fill(els.infoRows, []); return; }
    const rows = [...data.fields];
    if (data.entry) rows.unshift({ label: 'Plate', value: `${data.plate} of ${data.plates.length} (${data.entry})` });
    if (tp?.result) rows.push({ label: 'Toolpath', value: tpSummary(tp.result) });
    if (!data.fields.length) rows.push({ label: 'Header', value: 'No slicer comments found in this file.' });
    infoTable.fill(els.infoRows, rows);
    els.thumb.hidden = !data.thumbnail;
    if (data.thumbnail) els.thumb.src = data.thumbnail;
    if (data.too_large) setNotice(`This file is ${ctx.humanSize(data.size)}, above the ${data.max_label} toolpath limit: Info and Source only.`);
  };

  // ── Source ──
  const showSource = async () => {
    source = source || fetchJson('source').catch((e) => ({ ok: false, message: `The source could not be read: ${e.message}` }));
    const data = await source;
    if (signal.aborted || view !== 'source') return;
    els.sourceLoading.hidden = true;
    if (!data.ok) { setNotice(data.message); return; }
    if (!els.source.childElementCount) els.source.innerHTML = sourceHtml(data.text);
    setNotice(data.truncated ? `Showing the first ${data.shown_label} of ${data.total_label}; download the file for the rest.` : '');
  };

  // ── Toolpath ──
  const tpSummary = (r) => `${plural(r.starts.length - 1, 'layer')}, ${plural(r.segments, 'extrusion')}, ${plural(r.travels, 'travel move')}` +
    `, ${(r.filament / 1000).toFixed(2)} m of filament${r.truncated ? ' (cut at the move limit)' : ''}`;

  const failToolpath = (message) => {
    els.loading.hidden = true;
    els.error.hidden = false;
    els.errorText.textContent = message;
  };

  const parseInWorker = (buffer, entry, maxMoves) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([`(${worker.toString()})();`], { type: 'text/javascript' }));
    const w = new Worker(url, { type: 'module' });
    URL.revokeObjectURL(url);
    const stop = () => w.terminate();
    signal.addEventListener('abort', stop);
    w.onmessage = ({ data }) => {
      if (data.progress !== undefined) { els.loadingText.textContent = `Parsing… ${Math.round(data.progress * 100)} %`; return; }
      stop();
      signal.removeEventListener('abort', stop);
      if (data.error) reject(new Error(data.error)); else resolve(data.result);
    };
    w.onerror = (e) => { stop(); e.preventDefault(); reject(new Error(e.message || 'the parser stopped')); };
    w.postMessage({ buffer, entry, maxMoves, fflate: FFLATE_URL }, [buffer]);
  });

  const buildToolpath = async () => {
    const data = await info;
    if (signal.aborted) return;
    if (!data.ok) { failToolpath(data.message); return; }
    if (data.too_large) { failToolpath(`This file is ${ctx.humanSize(data.size)}, above the ${data.max_label} toolpath limit.`); return; }
    let buffer;
    if (zipBuffer) buffer = zipBuffer.slice(0);
    else {
      els.loadingText.textContent = 'Loading…';
      const r = await fetch(ctx.src, { signal });
      if (!r.ok) throw new Error(`the file could not be fetched (HTTP ${r.status})`);
      if ((r.headers.get('content-type') || '').startsWith('application/json')) throw new Error((await r.json()).message);
      buffer = await r.arrayBuffer();
      if (bundle && data.plates.length > 1) zipBuffer = buffer.slice(0);
    }
    if (signal.aborted) return;
    els.loadingText.textContent = 'Parsing…';
    let result;
    try {
      result = await parseInWorker(buffer, bundle ? data.entry : null, data.max_moves);
    } catch (e) {
      if (signal.aborted) return;
      failToolpath(bundle ? `This 3MF cannot be read: ${e.message}` : `This G-code cannot be read: ${e.message}`);
      return;
    }
    if (signal.aborted) return;
    if (!result.segments) { failToolpath('No extrusion moves found in this file.'); return; }
    tp = scene(result, data);
    if (result.truncated) setNotice(`Showing the first ${result.segments.toLocaleString()} extrusions: the file has more moves than the ${data.max_moves.toLocaleString()} move limit.`);
    if (view === 'info') showInfo();
  };

  // The three.js part: built once per plate, torn down by dispose or a plate switch.
  function scene(result, data) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    els.stage.prepend(renderer.domElement);
    const three = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.zoomToCursor = true;
    const world = new THREE.Group(); // G-code is Z up
    world.rotation.x = -Math.PI / 2;
    three.add(world);

    const layers = result.starts.length - 1;
    const position = new THREE.BufferAttribute(result.ext, 3);
    const colour = new THREE.BufferAttribute(new Uint8Array(result.segments * 6), 3, true);
    const geometry = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', position); g.setAttribute('color', colour); return g; };
    const below = new THREE.LineSegments(geometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
    const top = new THREE.LineSegments(geometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    const travelGeo = new THREE.BufferGeometry();
    travelGeo.setAttribute('position', new THREE.BufferAttribute(result.travel, 3));
    const travel = new THREE.LineSegments(travelGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }));
    travel.visible = els.travel.getAttribute('aria-pressed') === 'true';
    [below, top, travel].forEach((o) => { o.frustumCulled = false; world.add(o); });

    const { min, max } = result.bbox;
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
    // The bed outline from the slicer's printable area, else a grid around the print.
    const bedPoints = data.bed || [[min[0] - 10, min[1] - 10], [max[0] + 10, min[1] - 10], [max[0] + 10, max[1] + 10], [min[0] - 10, max[1] + 10]];
    const bx = bedPoints.map((p) => p[0]), by = bedPoints.map((p) => p[1]);
    const bedBox = { x0: Math.min(...bx), x1: Math.max(...bx), y0: Math.min(...by), y1: Math.max(...by) };
    const span = Math.max(bedBox.x1 - bedBox.x0, bedBox.y1 - bedBox.y0);
    const step = span > 400 ? 50 : 10;
    const gridSize = Math.ceil(span / step) * step;
    const grid = new THREE.GridHelper(gridSize, gridSize / step, 0xffffff, 0xffffff);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(bedBox.x0 + gridSize / 2, bedBox.y0 + gridSize / 2, -0.01);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(bedPoints.map(([px, py]) => new THREE.Vector3(px, py, 0))),
      new THREE.LineBasicMaterial());
    const bed = new THREE.Group();
    bed.add(grid, outline);
    bed.visible = els.grid.getAttribute('aria-pressed') === 'true';
    world.add(bed);

    let mode = (() => { try { return localStorage.getItem(COLOUR_KEY) || 'feature'; } catch (e) { return 'feature'; } })();
    let lo = 0, hi = layers - 1;

    const paint = () => {
      three.background = cssColor('--t-canvas');
      travel.material.color.copy(cssColor('--t-disabled'));
      grid.material.color.copy(cssColor('--t-disabled'));
      outline.material.color.copy(cssColor('--t-muted'));
      const arr = colour.array;
      const fill = (from, to, c) => {
        const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
        for (let s = from * 6, end = to * 6; s < end; s += 3) { arr[s] = r; arr[s + 1] = g; arr[s + 2] = b; }
      };
      if (mode === 'layer') {
        const stops = ['cyan', 'purple', 'orange'].map((h) => cssColor(hueToken([h])));
        for (let l = 0; l < layers; l++) {
          const t = layers > 1 ? l / (layers - 1) : 0;
          const c = t < 0.5 ? stops[0].clone().lerp(stops[1], t * 2) : stops[1].clone().lerp(stops[2], (t - 0.5) * 2);
          fill(result.starts[l], result.starts[l + 1], c);
        }
      } else {
        const colours = featureTokens(result.features).map((t) => cssColor(t));
        for (let s = 0; s < result.segments; s++) {
          const c = colours[result.feat[s]];
          const o = s * 6;
          arr[o] = arr[o + 3] = Math.round(c.r * 255);
          arr[o + 1] = arr[o + 4] = Math.round(c.g * 255);
          arr[o + 2] = arr[o + 5] = Math.round(c.b * 255);
        }
      }
      colour.needsUpdate = true;
      legend();
      requestRender();
    };

    const legend = () => {
      const items = mode === 'layer'
        ? [['--t-hue-cyan', `Layer 1 · Z ${result.zs[0].toFixed(2)} mm`], ['--t-hue-purple', `Layer ${Math.ceil(layers / 2)}`],
          ['--t-hue-orange', `Layer ${layers} · Z ${result.zs[layers - 1].toFixed(2)} mm`]]
        : (() => { const t = featureTokens(result.features); return result.features.map((f, i) => [t[i], featureLabel(f)]); })();
      els.legend.replaceChildren(...items.map(([token, label]) => {
        const li = document.createElement('li');
        const sw = document.createElement('span');
        sw.className = 'gcode-swatch';
        sw.style.setProperty('--swatch', `var(${token})`);
        li.append(sw, document.createTextNode(label));
        return li;
      }));
      els.legend.hidden = false;
    };

    const range = () => {
      const last = layers - 1;
      const highlight = hi < last || lo > 0 ? hi : -1;
      const vStart = result.starts[lo] * 2;
      const vEnd = (highlight >= 0 ? result.starts[hi] : result.starts[hi + 1]) * 2;
      below.geometry.setDrawRange(vStart, Math.max(0, vEnd - vStart));
      below.material.opacity = highlight >= 0 ? DIM_OPACITY : 1;
      below.material.depthWrite = highlight < 0;
      top.visible = highlight >= 0;
      top.geometry.setDrawRange(result.starts[hi] * 2, (result.starts[hi + 1] - result.starts[hi]) * 2);
      travel.geometry.setDrawRange(result.tstarts[lo] * 2, (result.tstarts[hi + 1] - result.tstarts[lo]) * 2);
      els.from.value = String(lo);
      els.to.value = String(hi);
      const z = result.zs[hi];
      els.layerLabel.textContent = (lo > 0 ? `Layers ${lo + 1}–${hi + 1}` : `Layer ${hi + 1}`) + ` of ${layers} · Z ${z.toFixed(2)} mm`;
      requestRender();
    };

    const frame = () => {
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
      const target = new THREE.Vector3(center.x, center.z, -center.y);
      const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05;
      camera.near = Math.max(distance / 1000, 0.01);
      camera.far = distance * 50;
      camera.position.copy(target).add(new THREE.Vector3(0.6, 0.9, 1).normalize().multiplyScalar(distance));
      camera.updateProjectionMatrix();
      controls.target.copy(target);
      controls.maxDistance = distance * 8;
      controls.update();
      requestRender();
    };

    let raf = 0;
    const render = () => { raf = 0; const moving = controls.update(); renderer.render(three, camera); if (moving) requestRender(); };
    function requestRender() { if (!raf) raf = requestAnimationFrame(render); }
    const resize = () => {
      const w = els.stage.clientWidth, h = els.stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      requestRender();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(els.stage);
    const mo = new MutationObserver(paint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-palette', 'data-mode'] });
    controls.addEventListener('change', requestRender);

    const radios = [...ctx.tools.querySelectorAll('input[name="gcode-colour"]')];
    radios.forEach((r) => { r.checked = r.value === mode; });
    const ac = new AbortController();
    const local = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });
    radios.forEach((r) => local(r, 'change', () => {
      if (!r.checked) return;
      mode = r.value;
      try { localStorage.setItem(COLOUR_KEY, mode); } catch (e) { /* private mode */ }
      paint();
    }));
    els.from.max = els.to.max = String(layers - 1);
    local(els.from, 'input', () => { lo = Math.min(Number(els.from.value), hi); range(); });
    local(els.to, 'input', () => { hi = Math.max(Number(els.to.value), lo); range(); });
    [els.fit, els.travel, els.grid].forEach((b) => { b.disabled = false; });

    resize();
    paint();
    range();
    frame();
    els.loading.hidden = true;
    els.layers.hidden = false;
    ctx.setStats(` · ${plural(layers, 'layer')} · ${result.segments.toLocaleString()} moves`);

    return {
      result,
      fit: frame,
      setTravel: (v) => { travel.visible = v; requestRender(); },
      setGrid: (v) => { bed.visible = v; requestRender(); },
      step: (delta) => { hi = Math.max(lo, Math.min(layers - 1, hi + delta)); range(); },
      dispose() {
        ac.abort();
        cancelAnimationFrame(raf);
        ro.disconnect();
        mo.disconnect();
        controls.dispose();
        [below, top].forEach((o) => { o.geometry.dispose(); o.material.dispose(); });
        [travel, grid, outline].forEach((o) => { o.geometry.dispose(); o.material.dispose(); });
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
    };
  }

  const startToolpath = () => {
    if (tp !== null) return;
    tp = false;
    els.loading.hidden = false;
    els.error.hidden = true;
    buildToolpath().catch((e) => {
      if (signal.aborted) return;
      console.warn('G-code toolpath:', e);
      failToolpath(`The toolpath could not be loaded: ${e.message}`);
    });
  };

  const toggle = (b) => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); return v; };
  on(els.fit, 'click', () => tp?.fit?.());
  on(els.travel, 'click', () => { const v = toggle(els.travel); tp?.setTravel?.(v); });
  on(els.grid, 'click', () => { const v = toggle(els.grid); tp?.setGrid?.(v); });

  // A bundle with several plates: one picker, every tab follows it.
  const plates = async () => {
    const data = await info;
    if (signal.aborted || !data.ok || !data.plates || data.plates.length < 2) return;
    plate = data.plate;
    els.plate.replaceChildren(...data.plates.map((n) => new Option(`Plate ${n}`, String(n), n === plate, n === plate)));
    els.plate.hidden = false;
    window.Tailor?.selects?.(ctx.tools);
    on(els.plate, 'change', () => {
      plate = Number(els.plate.value);
      if (tp) tp.dispose?.();
      tp = null;
      source = null;
      els.source.replaceChildren();
      setNotice('');
      loadInfo();
      els.infoLoading.hidden = false;
      els.sourceLoading.hidden = false;
      ctx.setStats('');
      show(view);
    });
  };

  function show(next) {
    view = next;
    ['toolpath', 'info', 'source'].forEach((id) => { pane(id).hidden = id !== next; });
    els.tools.hidden = next !== 'toolpath';
    setNotice('');
    if (next === 'toolpath') {
      startToolpath();
      if (tp?.result?.truncated) setNotice(`Showing the first ${tp.result.segments.toLocaleString()} extrusions: the file has more moves than the move limit.`);
    } else if (next === 'info') showInfo();
    else if (next === 'source') showSource();
  }

  loadInfo();
  plates();

  return {
    show,
    key(e) {
      if (view !== 'toolpath' || !tp?.step) return false;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { tp.step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)); return true; }
      if (e.key === 'f' || e.key === 'F') { tp.fit(); return true; }
      if (e.key === 't' || e.key === 'T') { els.travel.click(); return true; }
      return false;
    },
    dispose() { if (tp) tp.dispose?.(); tp = null; }
  };
}
