/*
 * brand.js — the small glass cube in the top-left corner. It is the same object as the intro
 * cube (same material, tilt, lights, camera), rendered live in a tiny canvas, so when the intro
 * cube lands here nothing visibly changes. It is also the menu button: hovering turns it a
 * quarter turn. Drawn once, then only re-drawn while it is turning (no constant GPU cost).
 *
 * The canvas is see-through, and the corner cube uses a see-through version of the glass
 * (opacity instead of transmission): real refraction needs an opaque scene behind the glass,
 * otherwise it turns milky — and at 44 px refraction is invisible anyway. Same tint, edges,
 * highlights and iridescence, with the header's dot field showing through.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Shared with boot.js: the intro cube must land at exactly this pose.
export const TILT_X = THREE.MathUtils.degToRad(24);
export const REST_Y = THREE.MathUtils.degToRad(35);
export const CAMERA = { fov: 30, z: 9 };

/** The glass recipe, shared by the intro and the corner cube. */
export function makeGlassCube() {
  const glass = new THREE.MeshPhysicalMaterial({
    roughness: 0.04, transmission: 1, thickness: 1.4, ior: 1.5, dispersion: 0.35,
    iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [200, 600],
    clearcoat: 0.7, clearcoatRoughness: 0.08, specularIntensity: 0.8,
  });
  const cube = new THREE.Mesh(new RoundedBoxGeometry(2, 2, 2, 8, 0.18), glass);
  cube.rotation.set(TILT_X, REST_Y, 0);
  return cube;
}

/** Lights + reflections shared by both scenes. */
export function dressScene(scene, renderer) {
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const rimA = new THREE.PointLight('#6fe7f0', 22, 12); rimA.position.set(3.5, 1.5, 2);
  const rimB = new THREE.PointLight('#9a7bff', 14, 12); rimB.position.set(-3.5, -1.5, 2);
  const key = new THREE.DirectionalLight('#ffffff', 1.3); key.position.set(-3, 4, 5);
  scene.add(rimA, rimB, key);
}

/** Bounding box of a mesh on screen (CSS px) for a canvas of size W x H. */
export function screenBox(mesh, camera, W, H) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const xs = [], ys = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new THREE.Vector3(x, y, z).project(camera);
    xs.push((p.x + 1) / 2 * W); ys.push((1 - p.y) / 2 * H);
  }
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return { width: right - left, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

// ---------- The corner cube ----------

const host = document.getElementById('brand-cube');
const SIZE = host.clientWidth || 44;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * 1.5);   // supersample: it is small, keep edges crisp
renderer.setSize(SIZE, SIZE);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
dressScene(scene, renderer);
scene.environmentIntensity = 1.3;   // brighter edge highlights: at 44 px they carry the "glass" look
const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 100);
camera.position.set(0, 0, CAMERA.z);
const cube = makeGlassCube();
cube.material = cube.material.clone();
Object.assign(cube.material, { transmission: 0, transparent: true, opacity: 0.72, depthWrite: false });
cube.material.color.set('#121922');   // dark glass tint, like the intro cube seen against the dark
scene.add(cube);

/** Where the cube sits on screen: boot.js aims its landing at this. */
export function cornerCubeBox() {
  const r = host.getBoundingClientRect();
  const b = screenBox(cube, camera, r.width, r.height);
  return { width: b.width, cx: r.left + b.cx, cy: r.top + b.cy };
}

renderer.render(scene, camera);

// Hover: a smooth quarter turn, then rest. Only renders while turning.
let turning = null;
function turn() {
  if (turning) return;
  const from = cube.rotation.y, to = from + Math.PI / 2, t0 = performance.now(), ms = 650;
  turning = requestAnimationFrame(function step(now) {
    const k = Math.min((now - t0) / ms, 1);
    cube.rotation.y = from + (to - from) * (1 - Math.pow(1 - k, 3));   // ease-out
    renderer.render(scene, camera);
    turning = k < 1 ? requestAnimationFrame(step) : null;
  });
}
host.closest('button').addEventListener('pointerenter', turn);
host.closest('button').addEventListener('focus', turn);
