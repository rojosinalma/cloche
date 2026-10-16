// 3D model preview inside the preview modal. mount() builds a renderer on the
// given stage, loads the file and returns a handle whose dispose() tears
// everything down (WebGL context, listeners, observers) when the modal moves
// on or closes.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import * as fflate from 'three/addons/libs/fflate.module.js';

const STORAGE_KEY = 'cloche.model-colors';
const defaults = { mesh: 'purple', bg: 'bg' };

// Swatch names → tailor palette tokens (the theme colours come from --t-*; cssColor reads them live).
const TOKENS = { fg: '--t-text', comment: '--t-disabled', bg: '--t-canvas', 'bg-dark': '--t-inset', 'bg-darker': '--t-overlay-bg', selection: '--t-selection' };
const token = (name) => TOKENS[name] || `--t-hue-${name}`;
const cssColor = (name) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000');
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });

function standardMaterial(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide });
}

function parse(format, buffer) {
  if (format === 'stl') return new THREE.Mesh(new STLLoader().parse(buffer));
  if (format === 'obj') return new OBJLoader().parse(new TextDecoder().decode(buffer));
  if (format === '3mf') return new ThreeMFLoader().parse(buffer);
  throw new Error(`Unsupported format "${format}"`);
}

function plateThumbnail(buffer) {
  try {
    const zip = fflate.unzipSync(new Uint8Array(buffer), { filter: (f) => /^Metadata\/plate_\d+\.png$/.test(f.name) });
    const name = Object.keys(zip).sort()[0];
    return name ? URL.createObjectURL(new Blob([zip[name]], { type: 'image/png' })) : null;
  } catch (e) {
    return null;
  }
}

// els: { stage, loading, errorBox, errorText, fallback, fallbackImg, notice, stats, buttons: {reset, grid, wire}, swatches[], fileSwatch }
// opts: { src, format, name }
export function mount(els, opts) {
  const { stage, loading, errorBox, fallback, notice, stats, buttons, swatches, fileSwatch } = els;
  const ac = new AbortController();
  const { signal } = ac;
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal });

  const stored = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } })();
  const choice = (() => { try { return { ...defaults, ...JSON.parse(stored || '{}') }; } catch (e) { return { ...defaults }; } })();
  const remember = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)); } catch (e) { /* private mode */ } };

  const setNotice = (text) => { notice.hidden = !text; notice.querySelector('span').textContent = text || ''; };
  const fail = (message) => { loading.hidden = true; errorBox.hidden = false; els.errorText.textContent = message; };

  loading.hidden = false;
  errorBox.hidden = true;
  fallback.hidden = true;
  fileSwatch.hidden = true;
  setNotice('');
  stats.textContent = '';
  Object.values(buttons).forEach((b) => { b.disabled = true; });
  buttons.wire.setAttribute('aria-pressed', 'false');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.9);
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(0.8, 1.2, 1);
  camera.add(key);
  scene.add(hemi, camera, key.target);

  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (e) {
    fail(`WebGL is not available in this browser: ${e.message}`);
    return { dispose() { ac.abort(); } };
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  const model = new THREE.Group();
  model.rotation.x = -Math.PI / 2;
  scene.add(model);

  let grid = null;
  let fit = null;
  let raf = 0;
  let thumbUrl = null;
  const meshes = [];
  let hasFileColors = false;

  const markSwatches = () => swatches.forEach((s) => {
    const target = s.closest('.model-swatches').dataset.target;
    s.setAttribute('aria-pressed', String(choice[target] === s.dataset.color));
  });

  const applyTheme = () => {
    scene.background = cssColor(token(choice.bg));
    hemi.color.copy(cssColor(token('fg')));
    hemi.groundColor.copy(cssColor(token('bg-darker')));
    const useFile = choice.mesh === 'file' && hasFileColors;
    const tint = useFile ? null : cssColor(token(choice.mesh));
    meshes.forEach((m) => {
      if (useFile && m.userData.fileColor) m.material.color.copy(m.userData.fileColor);
      else m.material.color.copy(tint || cssColor(token('purple')));
    });
    if (grid) grid.material.color.copy(cssColor(token('comment')));
    markSwatches();
  };

  const buildGrid = (box) => {
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, 10);
    const step = extent > 400 ? 50 : extent > 120 ? 20 : 10;
    const span = Math.ceil((extent * 1.6) / step) * step;
    grid = new THREE.GridHelper(span, span / step, 0xffffff, 0xffffff);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.position.set((box.min.x + box.max.x) / 2, box.min.z - 0.01, -(box.min.y + box.max.y) / 2);
    grid.visible = buttons.grid.getAttribute('aria-pressed') === 'true';
    scene.add(grid);
  };

  const frame = (box) => {
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const worldCenter = new THREE.Vector3(center.x, center.z, -center.y);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05;
    camera.near = Math.max(distance / 1000, 0.01);
    camera.far = distance * 50;
    camera.position.copy(worldCenter).add(new THREE.Vector3(1, 0.9, 1).normalize().multiplyScalar(distance));
    camera.updateProjectionMatrix();
    controls.target.copy(worldCenter);
    key.target.position.copy(worldCenter);
    controls.minDistance = radius * 0.05;
    controls.maxDistance = distance * 8;
    controls.update();
  };

  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const adopt = (object) => {
    const purple = cssColor(token('purple'));
    object.traverse((node) => {
      if (!node.isMesh) return;
      const source = Array.isArray(node.material) ? node.material[0] : node.material;
      const isDefault = !source || source.name === THREE.Loader.DEFAULT_MATERIAL_NAME || source.name === '' || !source.color;
      const own = !isDefault && !source.color.equals(new THREE.Color(0xffffff));
      node.material = standardMaterial(own ? source.color.clone() : purple);
      if (own) { node.userData.fileColor = source.color.clone(); hasFileColors = true; }
      if (!node.geometry.attributes.normal) node.geometry.computeVertexNormals();
      meshes.push(node);
    });
    model.add(object);
    if (hasFileColors) {
      fileSwatch.hidden = false;
      if (!stored) choice.mesh = 'file';
    }
  };

  const triangles = () => meshes.reduce((sum, m) => {
    const g = m.geometry;
    return sum + Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
  }, 0);

  const showFallback = (buffer, reason) => {
    thumbUrl = plateThumbnail(buffer);
    if (!thumbUrl) return fail(`${reason} and the file carries no plate thumbnail.`);
    loading.hidden = true;
    fallback.hidden = false;
    els.fallbackImg.src = thumbUrl;
    setNotice(`${reason}; showing the slicer's plate thumbnail embedded in the file instead.`);
  };

  const show = (object) => {
    const box = new THREE.Box3();
    object.updateMatrixWorld(true);
    object.traverse((node) => { if (node.isMesh) box.expandByObject(node); });
    if (box.isEmpty()) throw new Error('The file contains no triangles');
    adopt(object);
    const size = box.getSize(new THREE.Vector3());
    stats.textContent = ` · ${triangles().toLocaleString()} triangles · ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm`;
    buildGrid(box);
    fit = () => frame(box);
    fit();
    applyTheme();
    Object.values(buttons).forEach((b) => { b.disabled = false; });
    loading.hidden = true;
  };

  const load = async () => {
    const response = await fetch(opts.src, { signal });
    if (!response.ok) throw new Error(`The file could not be fetched (HTTP ${response.status})`);
    const buffer = await response.arrayBuffer();
    if (signal.aborted) return;
    try {
      show(parse(opts.format, buffer));
    } catch (e) {
      if (opts.format !== '3mf') throw e;
      console.warn('3MF could not be rendered:', e);
      showFallback(buffer, 'This 3MF cannot be rendered in the browser');
    }
  };

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.prepend(renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.zoomToCursor = true;
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  applyTheme();
  const mo = new MutationObserver(applyTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-palette', 'data-mode'] });

  on(buttons.reset, 'click', () => fit && fit());
  const toggle = (b) => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); return on; };
  on(buttons.grid, 'click', () => { const g = toggle(buttons.grid); if (grid) grid.visible = g; });
  on(buttons.wire, 'click', () => { const w = toggle(buttons.wire); meshes.forEach((m) => { m.material.wireframe = w; }); });
  swatches.forEach((s) => on(s, 'click', () => {
    choice[s.closest('.model-swatches').dataset.target] = s.dataset.color;
    remember();
    applyTheme();
  }));

  (function animate() {
    raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  load().catch((e) => {
    if (signal.aborted) return;
    console.error(e);
    fail(`Could not load ${opts.name}: ${e.message}`);
  });

  return {
    dispose() {
      ac.abort();
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      controls.dispose();
      meshes.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
      if (grid) { grid.geometry.dispose(); grid.material.dispose(); }
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  };
}
