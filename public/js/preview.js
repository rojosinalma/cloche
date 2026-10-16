// Preview modal: text, images, video, audio and 3D models open over the
// gallery, never on a page of their own. Esc / the close button / a click on the
// backdrop close it; ←/→ step through the page's previewable files.
(function preview() {
  const box = document.getElementById('preview');
  if (!box) return;
  const triggers = [...document.querySelectorAll('[data-preview]')];
  if (!triggers.length) return;

  const items = [];
  const indexOf = new Map();
  triggers.forEach((t) => {
    const key = t.dataset.href;
    if (!indexOf.has(key)) {
      indexOf.set(key, items.length);
      items.push({ kind: t.dataset.kind, src: t.dataset.src, name: t.dataset.name, download: t.dataset.download,
                   href: key, format: t.dataset.format, size: Number(t.dataset.size || 0) });
    }
    t.addEventListener('click', (e) => { e.preventDefault(); show(indexOf.get(key)); });
  });

  const $ = (id) => document.getElementById(id);
  const stage = $('preview-stage'), img = $('preview-img'), video = $('preview-video'), audioBox = $('preview-audio'),
        audio = $('preview-audio-el'), modelBox = $('preview-model'), icon = $('preview-icon'), name = $('preview-name'),
        badge = $('preview-badge'), sizeEl = $('preview-size'), modelStats = $('preview-model-stats'), count = $('preview-count'),
        dl = $('preview-download'), zoomBtn = $('preview-zoom'), textBox = $('preview-text'), textContent = $('preview-text-content'),
        textLoading = $('text-loading'), textPanes = $('text-panes'), textCopy = $('text-copy');
  const tools = [...box.querySelectorAll('.preview-tool')];
  const panes = { text: textBox, image: img, video, audio: audioBox, model: modelBox };
  const icons = { text: 'bi-file-earmark-text', image: 'bi-file-earmark-image', video: 'bi-file-earmark-play', audio: 'bi-file-earmark-music', model: 'bi-box' };
  const modelMax = Number(box.dataset.modelMax || 0);
  let index = 0, model = null, modelModule = null, textAbort = null;

  const humanSize = (b) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return i ? `${b.toFixed(1)} ${units[i]}` : `${b} B`;
  };

  const modelEls = () => ({
    stage: $('model-stage'), loading: $('model-loading'), errorBox: $('model-error'), errorText: $('model-error-text'),
    fallback: $('model-fallback'), fallbackImg: $('model-fallback-img'), notice: $('model-notice'), stats: modelStats,
    buttons: { reset: $('model-reset'), grid: $('model-grid'), wire: $('model-wire') },
    swatches: [...box.querySelectorAll('.model-swatch')], fileSwatch: box.querySelector('.model-swatch-file')
  });

  const clear = () => {
    if (model) { model.dispose(); model = null; }
    if (textAbort) { textAbort.abort(); textAbort = null; }
    textContent.innerHTML = ''; textPanes.hidden = true; textCopy.hidden = true;
    img.src = ''; video.pause(); video.removeAttribute('src'); video.load(); audio.pause(); audio.removeAttribute('src');
    modelStats.textContent = '';
    box.classList.remove('zoomed');
    zoomBtn.querySelector('i').className = 't-icon bi bi-zoom-in';
    Object.values(panes).forEach((p) => { p.hidden = true; });
  };

  const tooLarge = (item) => {
    const els = modelEls();
    els.loading.hidden = true;
    els.errorBox.hidden = false;
    els.errorText.textContent = `This file is ${humanSize(item.size)}, above the ${box.dataset.modelMaxLabel} viewer limit.`;
  };

  const openModel = async (item) => {
    if (modelMax && item.size > modelMax) return tooLarge(item);
    try {
      modelModule = modelModule || await import(box.dataset.modelModule);
    } catch (e) {
      const els = modelEls();
      els.loading.hidden = true; els.errorBox.hidden = false;
      els.errorText.textContent = `The 3D viewer could not be loaded: ${e.message}`;
      return;
    }
    if (box.hidden || items[index] !== item) return;
    model = modelModule.mount(modelEls(), { src: item.src, format: item.format, name: item.name });
  };

  const showPane = (pane) => {
    textContent.querySelectorAll('.view-pane').forEach((p) => { p.hidden = p.dataset.pane !== pane; });
    textPanes.querySelectorAll('.pane-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === pane)));
  };

  const textError = (message) => {
    textContent.innerHTML = '<div class="t-empty"><i class="t-icon t-empty-icon bi bi-exclamation-triangle"></i><span></span></div>';
    textContent.querySelector('span').textContent = message;
  };

  const openText = async (item) => {
    textAbort = new AbortController();
    textLoading.hidden = false;
    try {
      const r = await fetch(item.src, { signal: textAbort.signal, headers: { Accept: 'text/html' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (items[index] !== item || box.hidden) return;
      textContent.innerHTML = html;
      const card = textContent.querySelector('.text-card');
      badge.hidden = !card?.dataset.label;
      badge.textContent = card?.dataset.label || '';
      const lines = Number(card?.dataset.lines || 0);
      modelStats.textContent = lines ? ` · ${lines.toLocaleString()} line${lines === 1 ? '' : 's'}` : '';
      textPanes.hidden = card?.dataset.pretty !== '1';
      textCopy.hidden = card?.dataset.copy !== '1';
      if (!textPanes.hidden) showPane('pretty');
    } catch (e) {
      if (e.name === 'AbortError') return;
      textError(`Could not load ${item.name}: ${e.message}`);
    } finally {
      textLoading.hidden = true;
    }
  };

  const copyText = async () => {
    const pane = textContent.querySelector('.view-pane[data-pane="source"]');
    if (!pane) return;
    try {
      await navigator.clipboard.writeText(pane.textContent.replace(/\n$/, ''));
      toast('success', 'Copied to clipboard');
    } catch (e) {
      toast('error', `Could not copy: ${e.message}`);
    }
  };

  const show = (i) => {
    clear();
    index = (i + items.length) % items.length;
    const item = items[index];
    icon.className = `bi preview-icon ${icons[item.kind] || 'bi-file-earmark'}`;
    name.textContent = item.name;
    badge.hidden = item.kind !== 'model';
    badge.textContent = (item.format || '').toUpperCase();
    sizeEl.textContent = item.size ? humanSize(item.size) : '';
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    dl.href = item.download;
    box.querySelectorAll('.preview-download-link').forEach((a) => { a.href = item.download; });
    tools.forEach((t) => { t.hidden = t.dataset.for !== item.kind || t.dataset.for === 'text'; });
    box.dataset.kind = item.kind;
    panes[item.kind].hidden = false;
    if (item.kind === 'text') openText(item);
    else if (item.kind === 'image') { img.src = item.src; img.alt = item.name; }
    else if (item.kind === 'video') { video.src = item.src; video.play().catch(() => {}); }
    else if (item.kind === 'audio') { audio.src = item.src; audio.play().catch(() => {}); }
    else if (item.kind === 'model') openModel(item);
    if (box.hidden) { box.hidden = false; document.body.classList.add('preview-open'); }
    history.replaceState(null, '', `#v=${item.href}`);
  };

  const close = () => {
    if (box.hidden) return;
    clear();
    box.hidden = true;
    document.body.classList.remove('preview-open');
    if (location.hash.startsWith('#v=')) history.replaceState(null, '', location.pathname + location.search);
  };

  const toggleZoom = () => {
    if (box.dataset.kind !== 'image') return;
    const zoomed = box.classList.toggle('zoomed');
    zoomBtn.querySelector('i').className = zoomed ? 't-icon bi bi-zoom-out' : 't-icon bi bi-zoom-in';
    if (zoomed) { stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2; stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2; }
  };

  img.addEventListener('click', toggleZoom);
  textPanes.addEventListener('click', (e) => { const b = e.target.closest('.pane-btn'); if (b) showPane(b.dataset.pane); });
  textCopy.addEventListener('click', copyText);
  zoomBtn.addEventListener('click', toggleZoom);
  $('preview-close').addEventListener('click', close);
  $('preview-prev').addEventListener('click', () => show(index - 1));
  $('preview-next').addEventListener('click', () => show(index + 1));
  stage.addEventListener('click', (e) => { if (e.target === stage || e.target === textBox) close(); });
  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const typing = /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(e.target.tagName);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && !typing) show(index - 1);
    else if (e.key === 'ArrowRight' && !typing) show(index + 1);
    else if ((e.key === ' ' || e.key === 'z') && box.dataset.kind === 'image') { e.preventDefault(); toggleZoom(); }
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
