import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
document.body.appendChild(renderer.domElement);
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromScene(room, 0.04);
room.dispose();
pmrem.dispose();
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let model = null;
const scene = new THREE.Scene();
scene.environment = environment.texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x696d80, 1.6));
const light = new THREE.DirectionalLight(0xffffff, 2.5);
light.position.set(4, 6, 8);
scene.add(light);
scene.add(light.target);

function disposeModel() {
  if (!model) return;
  scene.remove(model);
  const disposed = new Set();
  model.traverse(object => {
    for (const resource of [object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) {
      if (!resource || disposed.has(resource)) continue;
      disposed.add(resource);
      if (resource.isMaterial) {
        for (const value of Object.values(resource)) if (value?.isTexture && !disposed.has(value)) {
          disposed.add(value);
          value.dispose();
          value.source?.data?.close?.();
        }
      }
      resource.dispose();
    }
  });
  model = null;
}

window.assetfitRender = {
  async load(url) {
    disposeModel();
    const gltf = await loader.loadAsync(url);
    model = gltf.scene;
    scene.add(model);
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model, true);
    if (bounds.isEmpty()) throw new Error('The GLB has no renderable bounds.');
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('The GLB has degenerate or non-finite bounds.');
    return { center: center.toArray(), radius, min: bounds.min.toArray(), max: bounds.max.toArray() };
  },
  async capture({ width, height, camera: config, lighting }) {
    if (!model) throw new Error('No GLB is loaded.');
    renderer.setSize(width, height, false);
    const camera = config.projection === 'orthographic'
      ? new THREE.OrthographicCamera(-config.scale * width / height, config.scale * width / height, config.scale, -config.scale, config.near, config.far)
      : new THREE.PerspectiveCamera(config.fov ?? 35, width / height, config.near, config.far);
    camera.position.fromArray(config.position);
    camera.up.fromArray(config.up ?? [0, 1, 0]);
    camera.lookAt(new THREE.Vector3().fromArray(config.target));
    camera.updateMatrixWorld(true);
    light.position.fromArray(lighting.position);
    light.target.position.fromArray(lighting.target);
    light.target.updateMatrixWorld(true);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  },
  info() {
    const gl = renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { three: THREE.REVISION, webgl: gl.getParameter(gl.VERSION),
      gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      colorSpace: renderer.outputColorSpace, toneMapping: 'ACESFilmic', exposure: 1,
      environment: 'Three.js RoomEnvironment', alpha: true, antialias: true };
  },
  dispose() { disposeModel(); environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); },
};
