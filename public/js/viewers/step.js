// STEP viewer: 3D (the file converted to STL by cad-render on the server,
// then shown by model.js) and Info (header and conversion, from the server).
// The conversion starts when the 3D tab is first shown: &part=convert waits
// for it (or finds it cached) and answers JSON with cad-render's reason on a
// failure; the STL fetch after it is the one download.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

export function mount(ctx) {
  const pick = (role) => ctx.$(`[data-role="${role}"]`);
  const els = {
    modelPane: pick('model-pane'), modelTools: pick('model-tools'), converting: pick('converting'),
    convertLoading: pick('convert-loading'), convertError: pick('convert-error'), convertErrorText: pick('convert-error-text'),
    infoPane: pick('info-pane'), notice: pick('notice'), infoLoading: pick('info-loading'), infoRows: pick('info-rows'),
    download: pick('download'), template: pick('model-tpl')
  };
  const { signal } = ctx;
  ctx.setBadge('STEP');
  let view = null;
  let info = null;
  let model = null; // null: not started, false: running or failed, else the model.js handle

  const loadInfo = () => {
    info = fetch(`${ctx.src}&part=info`, { signal })
      .then((r) => (r.ok ? r.json() : { ok: false, message: `The header could not be read (HTTP ${r.status})` }))
      .catch((e) => ({ ok: false, message: `The header could not be read: ${e.message}` }));
    return info;
  };

  const showInfo = async () => {
    const data = await info;
    const table = await ctx.load('info-table');
    if (signal.aborted || view !== 'info') return;
    els.infoLoading.hidden = true;
    table.fill(els.infoRows, data.ok ? data.fields : []);
    const message = data.ok ? data.notice : data.message;
    els.notice.hidden = !message;
    els.notice.querySelector('span').textContent = message || '';
    els.download.hidden = !message;
  };

  const fail = (message) => {
    els.convertLoading.hidden = true;
    els.convertError.hidden = false;
    els.convertErrorText.textContent = message;
  };

  // Converts, fetches the STL and mounts model.js on a clone of its markup.
  const startModel = async () => {
    model = false;
    const converted = await fetch(`${ctx.src}&part=convert`, { signal }).then((r) => r.json());
    if (signal.aborted) return;
    if (!converted.ok) { fail(converted.message); loadInfo(); return; }
    const response = await fetch(ctx.src, { signal });
    if (!response.ok) throw new Error(`the converted model could not be fetched (HTTP ${response.status})`);
    if ((response.headers.get('content-type') || '').startsWith('application/json')) { fail((await response.json()).message); return; }
    const buffer = await response.arrayBuffer();
    if (signal.aborted) return;
    let mesh;
    try {
      mesh = new THREE.Mesh(new STLLoader().parse(buffer));
    } catch (e) {
      fail(`The converted model cannot be read: ${e.message}`);
      return;
    }
    const lib = await ctx.load('model');
    if (signal.aborted) { mesh.geometry.dispose(); return; }
    const frag = els.template.content.cloneNode(true);
    frag.querySelectorAll('.preview-download-link').forEach((a) => { a.href = ctx.item.download; });
    els.modelTools.append(...frag.querySelector('[data-slot="tools"]').childNodes);
    els.converting.remove();
    els.modelPane.append(...frag.querySelector('[data-slot="body"]').childNodes);
    const pane = els.modelPane, tools = els.modelTools;
    model = await lib.mount({
      ...ctx,
      item: { ...ctx.item, format: 'stl' },
      root: pane,
      tools,
      $: (sel) => pane.querySelector(sel) || tools.querySelector(sel),
      setBadge: () => ctx.setBadge('STEP')
    }, { object: mesh });
    loadInfo();
    if (view === 'info') showInfo();
  };

  function show(next) {
    view = next;
    els.modelPane.hidden = next !== 'model';
    els.modelTools.hidden = next !== 'model';
    els.infoPane.hidden = next !== 'info';
    if (next === 'info') showInfo();
    if (next === 'model' && model === null) {
      startModel().catch((e) => {
        if (signal.aborted) return;
        console.warn('STEP 3D view:', e);
        fail(`The 3D view could not be loaded: ${e.message}`);
      });
    }
  }

  loadInfo();
  return {
    show,
    key: (e) => model?.key?.(e) || false,
    dispose() { model?.dispose?.(); }
  };
}
