import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { HELPER_LIB } from './constants.js';
import { $ } from './utils.js';

export let renderer, scene, camera, controls, grid;
export let currentModel = null;

export function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1016);
  scene.fog = new THREE.Fog(0x0d1016, 40, 120);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(8, 6, 10);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enableRotate = true;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.enabled = true;

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202830, 0.9));
  const ambient = new THREE.AmbientLight(0xffffff, 0.25); scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(10, 16, 8); scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dir2.position.set(-8, 6, -6); scene.add(dir2);

  grid = new THREE.GridHelper(40, 40, 0x2a3344, 0x1a2030);
  scene.add(grid);
  const axes = new THREE.AxesHelper(2); axes.visible = false; scene.add(axes);

  return { renderer, scene, camera, controls, grid };
}

export function applyTheme(lightTheme) {
  const bg = lightTheme ? 0xf0f2f5 : 0x0d1016;
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 40, 120);
  scene.remove(grid);
  grid.geometry?.dispose();
  grid.material?.dispose();
  grid = new THREE.GridHelper(40, 40,
    lightTheme ? 0xc0c5cd : 0x2a3344,
    lightTheme ? 0xe0e3e8 : 0x1a2030
  );
  scene.add(grid);
}

export function resize() {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    }
  });
}

export function setModel(obj) {
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
  }
  if (!obj || !obj.isObject3D) throw new Error('buildModel did not return a THREE.Object3D');

  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  obj.position.sub(center);

  currentModel = obj;
  scene.add(obj);

  obj.traverse((o) => {
    if (o.isMesh && o.material) {
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      materials.forEach((m) => {
        if (!m) return;
        m.side = THREE.FrontSide;
        m.depthTest = true;
        m.depthWrite = true;
        if (!m.transparent || m.opacity >= 0.99) {
          m.transparent = false;
          m.opacity = 1;
        }
      });
      if (o.geometry && o.geometry.attributes.normal) {
        o.geometry.computeVertexNormals();
      }
    }
  });

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = (camera.fov * Math.PI) / 180;
  let dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.9;
  dist = Math.max(dist, 4);
  const angle = Math.PI / 5;
  camera.position.set(dist * Math.cos(angle), dist * 0.7, dist * Math.sin(angle) * 1.4 + dist * 0.3);
  controls.target.set(0, 0, 0);
  controls.update();

  let verts = 0, tris = 0;
  obj.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      const v = g.attributes.position?.count ?? 0;
      verts += v;
      tris += g.index ? g.index.count / 3 : v / 3;
    }
  });
  $('stats').innerHTML = `<b>${Math.round(tris)}</b> triangles · <b>${verts}</b> vertices · <b>${maxDim.toFixed(2)}</b> units`;
  $('emptyHint').style.display = 'none';
  document.querySelectorAll('.exports button').forEach((b) => (b.disabled = false));
  return { tris, verts, maxDim };
}

export function runModelCode(code) {
  const runner = new Function(
    'THREE',
    HELPER_LIB + '\n' + code + '\n;if(typeof buildModel==="function")return buildModel(THREE);if(typeof buildModel!=="undefined")return buildModel;throw new Error("buildModel is not defined in the generated code");'
  );
  const obj = runner(THREE);
  return setModel(obj);
}

export async function exportModel(format, nameRoot) {
  if (!currentModel) return;
  const name = (nameRoot.trim() || 'model').replace(/[^a-zA-Z0-9_-]/g, '_');
  let blob, filename;
  if (format === 'stl') {
    const ascii = new STLExporter().parse(currentModel);
    blob = new Blob([ascii], { type: 'model/stl' });
    filename = name + '.stl';
  } else if (format === 'obj') {
    const text = new OBJExporter().parse(currentModel);
    blob = new Blob([text], { type: 'text/plain' });
    filename = name + '.obj';
  } else if (format === 'glb') {
    const result = await new Promise((resolve, reject) => {
      new GLTFExporter().parse(currentModel, resolve, reject, { binary: true });
    });
    blob = new Blob([result], { type: 'model/gltf-binary' });
    filename = name + '.glb';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
