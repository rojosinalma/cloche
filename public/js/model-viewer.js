import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import * as fflate from 'three/addons/libs/fflate.module.js';

const card = document.getElementById('model-view');
const stage = document.getElementById('model-stage');
const loading = document.getElementById('model-loading');
const errorBox = document.getElementById('model-error');
const fallback = document.getElementById('model-fallback');
const notice = document.getElementById('model-notice');
const stats = document.getElementById('model-stats');
const buttons = { reset: document.getElementById('model-reset'), grid: document.getElementById('model-grid'), wire: document.getElementById('model-wire'), colors: document.getElementById('model-colors') };
const swatches = Array.from(document.querySelectorAll('.model-swatch'));
const fileSwatch = document.querySelector('.model-swatch-file');

const STORAGE_KEY = 'cloche.model-colors';
const defaults = { mesh: 'purple', bg: 'bg' };
const stored = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } })();
const choice = (() => {
  try { return { ...defaults, ...JSON.parse(stored || '{}') }; } catch (e) { return { ...defaults }; }
})();
const remember = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)); } catch (e) { /* private mode */ } };

const cssColor = (name) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000000');
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const setNotice = (text) => { notice.hidden = !text; notice.querySelector('span').textContent = text || ''; };
const fail = (message) => {
  loading.hidden = true;
  errorBox.hidden = false;
  document.getElementById('model-error-text').textContent = message;
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.9);
const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.position.set(0.8, 1.2, 1);
camera.add(key);
scene.add(hemi, camera, key.target);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
} catch (e) {
  fail(`WebGL is not available in this browser: ${e.message}`);
}

const controls = renderer ? new OrbitControls(camera, renderer.domElement) : null;
const model = new THREE.Group();
model.rotation.x = -Math.PI / 2;
scene.add(model);

let grid = null;
let fit = null;
const meshes = [];
let hasFileColors = false;

function markSwatches() {
  swatches.forEach((s) => {
    const target = s.closest('.model-swatches').dataset.target;
    s.classList.toggle('active', choice[target] === s.dataset.color);
  });
}

function applyTheme() {
  scene.background = cssColor(`--drac-${choice.bg}`);
  const comment = cssColor('--drac-comment');
  hemi.color.copy(cssColor('--drac-fg'));
  hemi.groundColor.copy(cssColor('--drac-bg-darker'));
  const useFile = choice.mesh === 'file' && hasFileColors;
  const tint = useFile ? null : cssColor(`--drac-${choice.mesh}`);
  meshes.forEach((m) => {
    if (useFile && m.userData.fileColor) m.material.color.copy(m.userData.fileColor);
    else m.material.color.copy(tint || cssColor('--drac-purple'));
  });
  if (grid) grid.material.color.copy(comment);
  markSwatches();
}

function buildGrid(box) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, 10);
  const step = extent > 400 ? 50 : extent > 120 ? 20 : 10;
  const span = Math.ceil((extent * 1.6) / step) * step;
  grid = new THREE.GridHelper(span, span / step, 0xffffff, 0xffffff);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.position.set((box.min.x + box.max.x) / 2, box.min.z - 0.01, -(box.min.y + box.max.y) / 2);
  grid.visible = buttons.grid.classList.contains('active');
  scene.add(grid);
}

function frame(box) {
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
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function standardMaterial(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide });
}

function adopt(object) {
  const purple = cssColor('--drac-purple');
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
}

function triangles() {
  return meshes.reduce((sum, m) => {
    const g = m.geometry;
    return sum + Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
  }, 0);
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

function showFallback(buffer, reason) {
  const url = plateThumbnail(buffer);
  if (!url) return fail(`${reason} and the file carries no plate thumbnail.`);
  loading.hidden = true;
  fallback.hidden = false;
  document.getElementById('model-fallback-img').src = url;
  setNotice(`${reason}; showing the slicer's plate thumbnail embedded in the file instead.`);
}

function show(object) {
  const geometryBox = new THREE.Box3();
  object.updateMatrixWorld(true);
  object.traverse((node) => { if (node.isMesh) geometryBox.expandByObject(node); });
  if (geometryBox.isEmpty()) throw new Error('The file contains no triangles');
  adopt(object);
  const size = geometryBox.getSize(new THREE.Vector3());
  stats.textContent = ` · ${triangles().toLocaleString()} triangles · ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm`;
  buildGrid(geometryBox);
  fit = () => frame(geometryBox);
  fit();
  applyTheme();
  Object.values(buttons).forEach((b) => { b.disabled = false; });
  loading.hidden = true;
}

async function load() {
  const format = card.dataset.format;
  const response = await fetch(card.dataset.src);
  if (!response.ok) throw new Error(`The file could not be fetched (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  let object;
  try {
    object = parse(format, buffer);
    show(object);
  } catch (e) {
    if (format !== '3mf') throw e;
    console.warn('3MF could not be rendered:', e);
    showFallback(buffer, 'This 3MF cannot be rendered in the browser');
  }
}

if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.prepend(renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  new ResizeObserver(resize).observe(stage);
  resize();
  applyTheme();
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  buttons.reset.addEventListener('click', () => fit && fit());
  buttons.grid.addEventListener('click', () => {
    const on = buttons.grid.classList.toggle('active');
    if (grid) grid.visible = on;
  });
  buttons.wire.addEventListener('click', () => {
    const on = buttons.wire.classList.toggle('active');
    meshes.forEach((m) => { m.material.wireframe = on; });
  });
  swatches.forEach((s) => s.addEventListener('click', () => {
    choice[s.closest('.model-swatches').dataset.target] = s.dataset.color;
    remember();
    applyTheme();
  }));

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  load().catch((e) => {
    console.error(e);
    fail(`Could not load ${card.dataset.name}: ${e.message}`);
  });
}
