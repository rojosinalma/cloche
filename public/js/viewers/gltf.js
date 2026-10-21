// glTF 2.0 (.glb, .gltf) in the 3D view. The scene is parsed here with
// three.js's GLTFLoader; buffers and textures a .gltf names load from
// ?data=gltf&part=<uri>, next to the file in the same share. Decoders load
// only when the file declares their extension: Draco meshes, meshopt meshes
// and KTX2 (Basis Universal) textures. The parsed scene then goes to
// model.js, so the stage, colours, grid and controls are the model viewer's;
// the file's own materials are its "colours from the file". A file that does
// not parse shows the standard notice instead; textures that cannot be
// decoded and extensions the loader does not know become a notice over the
// model.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as THREE from 'three';

// Same three.js release as the import map in views/preview_modal.erb.
const LIBS = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/';
const DRACO_PATH = `${LIBS}draco/gltf/`;
const BASIS_PATH = `${LIBS}basis/`;
const DRACO = 'KHR_draco_mesh_compression';
const MESHOPT = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];
const BASISU = 'KHR_texture_basisu';
// Base URL of the file's relative resources; the URL modifier turns it into ?part=.
const PART_BASE = 'cloche-part:/';
const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_JSON = 0x4e4f534a; // "JSON"

// The extensions the file declares, read from its JSON (a .glb's first chunk) before the parse.
function extensionsOf(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const glb = bytes.length >= 20 && view.getUint32(0, true) === GLB_MAGIC && view.getUint32(16, true) === GLB_JSON;
    const json = JSON.parse(new TextDecoder().decode(glb ? bytes.subarray(20, 20 + view.getUint32(12, true)) : bytes));
    return { used: json.extensionsUsed || [], required: json.extensionsRequired || [] };
  } catch (e) {
    return { used: [], required: [] }; // GLTFLoader names what is wrong with the file
  }
}

// KTX2Loader picks the texture format from what the GPU supports, so it needs a WebGL renderer before the
// parse. The 3D view's renderer exists only later; a throwaway one answers and goes.
async function basisLoader(manager) {
  const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
  const loader = new KTX2Loader(manager).setTranscoderPath(BASIS_PATH);
  const renderer = new THREE.WebGLRenderer();
  try { loader.detectSupport(renderer); } finally { renderer.dispose(); renderer.forceContextLoss(); }
  try {
    await loader.init();
  } catch (e) {
    loader.dispose();
    throw e;
  }
  return loader;
}

// Without the transcoder a KTX2 texture is left out: its fallback image is used when the file has one.
const skipBasis = (parser) => ({
  name: BASISU,
  loadTexture(index) {
    const def = parser.json.textures[index];
    if (!def.extensions?.[BASISU]) return null;
    return def.source === undefined ? Promise.resolve(null) : null;
  }
});

async function parse(buffer, src, used) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (url.startsWith(PART_BASE)
    ? `${src}&part=${encodeURIComponent(decodeURIComponent(url.slice(PART_BASE.length)))}`
    : url));
  const loader = new GLTFLoader(manager);
  const notes = [];
  let draco = null;
  let ktx2 = null;
  if (used.includes(DRACO)) {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    loader.setDRACOLoader(draco = new DRACOLoader(manager).setDecoderPath(DRACO_PATH));
  }
  if (used.some((e) => MESHOPT.includes(e))) {
    loader.setMeshoptDecoder((await import('three/addons/libs/meshopt_decoder.module.js')).MeshoptDecoder);
  }
  if (used.includes(BASISU)) {
    try {
      loader.setKTX2Loader(ktx2 = await basisLoader(manager));
    } catch (e) {
      console.warn('KTX2 transcoder could not be loaded:', e);
      loader.register(skipBasis);
      notes.push('The KTX2 textures could not be decoded (the Basis Universal transcoder did not load), so the model shows without them.');
    }
  }
  try {
    return { gltf: await loader.parseAsync(buffer, PART_BASE), notes };
  } finally {
    draco?.dispose();
    ktx2?.dispose();
  }
}

const materials = (object) => {
  const all = new Set();
  object.traverse((n) => { if (n.isMesh) [n.material].flat().forEach((m) => m && all.add(m)); });
  return [...all];
};

const disposeObject = (object) => object.traverse((n) => {
  if (!n.isMesh) return;
  n.geometry.dispose();
  [n.material].flat().forEach((m) => {
    if (!m) return;
    Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
    m.dispose();
  });
});

export async function mount(ctx) {
  const fail = (message) => { ctx.tools.replaceChildren(); ctx.notice(message, 'exclamation-triangle'); };
  let gltf;
  let notes;
  let extensions;
  try {
    const response = await fetch(ctx.src, { signal: ctx.signal });
    if (!response.ok) throw new Error(`the file could not be fetched (HTTP ${response.status})`);
    const buffer = await response.arrayBuffer();
    extensions = extensionsOf(buffer);
    ({ gltf, notes } = await parse(buffer, ctx.src, extensions.used));
  } catch (e) {
    if (ctx.signal.aborted) return null;
    console.warn('glTF could not be read:', e);
    fail(`This glTF file could not be read: ${e.message || e}`);
    return null;
  }
  const scene = gltf.scene || gltf.scenes?.[0];
  if (ctx.signal.aborted) { if (scene) disposeObject(scene); return null; }
  let meshes = 0;
  scene?.traverse((n) => { if (n.isMesh) meshes += 1; });
  if (!meshes) { fail('This glTF file holds no meshes to show.'); return null; }

  // Required extensions no plugin of the loader handles: the scene loads, but may miss what they add.
  const known = gltf.parser.extensions;
  const unknown = extensions.required.filter((e) => !known[e]);
  if (unknown.length) notes.push(`This file needs glTF extensions the viewer does not support (${unknown.join(', ')}), so parts of it may look different.`);

  // glTF is Y up in metres; the 3D view expects Z up in millimetres.
  const object = new THREE.Group();
  object.rotation.x = Math.PI / 2;
  object.scale.setScalar(1000);
  object.add(scene);

  const model = await ctx.load('model');
  if (ctx.signal.aborted) { disposeObject(scene); return null; }
  return model.mount(ctx, {
    object,
    keepMaterials: true,
    notice: notes.join(' '),
    // Metallic PBR materials read as black without an environment; only the file's own metals get one.
    setup: ({ renderer }) => {
      const metals = materials(scene).filter((m) => 'envMap' in m && m.metalness > 0);
      if (!metals.length) return null;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      metals.forEach((m) => { m.envMap = env; m.envMapIntensity = 0.5; m.needsUpdate = true; });
      return () => { env.dispose(); pmrem.dispose(); };
    }
  });
}
