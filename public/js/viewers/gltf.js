// glTF 2.0 (.glb, .gltf) in the 3D view. The scene is parsed here with
// three.js's GLTFLoader (Draco and meshopt compressed meshes too); buffers and
// textures a .gltf names load from ?data=gltf&part=<uri>, next to the file in
// the same share. The parsed scene then goes to model.js, so the stage,
// colours, grid and controls are the model viewer's; the file's own
// materials are its "colours from the file". A file that does not parse
// shows the standard notice instead.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as THREE from 'three';

// Same three.js release as the import map in views/preview_modal.erb.
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/gltf/';
// Base URL of the file's relative resources; the URL modifier turns it into ?part=.
const PART_BASE = 'cloche-part:/';

function parse(buffer, src) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (url.startsWith(PART_BASE)
    ? `${src}&part=${encodeURIComponent(decodeURIComponent(url.slice(PART_BASE.length)))}`
    : url));
  const draco = new DRACOLoader(manager).setDecoderPath(DRACO_PATH);
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return new Promise((resolve, reject) => loader.parse(buffer, PART_BASE, resolve, reject))
    .finally(() => draco.dispose());
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
  try {
    const response = await fetch(ctx.src, { signal: ctx.signal });
    if (!response.ok) throw new Error(`the file could not be fetched (HTTP ${response.status})`);
    gltf = await parse(await response.arrayBuffer(), ctx.src);
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
