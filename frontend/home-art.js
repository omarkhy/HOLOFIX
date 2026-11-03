/*
 * home-art.js — the home page illustration, live: an exploded laptop drawn with glowing lines,
 * turning very slowly on itself and bobbing up and down (like a dropped item in Minecraft).
 *
 * Why live lines instead of a GIF: a GIF of this would be several MB, blurry and limited to
 * 256 colours. A few hundred line segments cost almost nothing to draw, stay sharp at any size,
 * and the browser pauses the loop when the tab is hidden. No bloom pass: the glow is a CSS
 * drop-shadow. With reduced motion it stays still. If WebGL fails, the static SVG remains.
 */

import * as THREE from 'three';
import { currentTheme } from './theme.js';

// Line colours per theme: [main, faint, amber]. Light = ink-blue blueprint on cream paper.
const INK = { dark: ['#6fe7f0', '#6fe7f0', '#f5b04c'], light: ['#0f6c74', '#0f6c74', '#b5640c'] };

const host = document.getElementById('home-art');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TURN_SECONDS = 72;   // one full turn (slow: it should feel like an exhibit, not a spinner)
const BOB_SECONDS = 5.5;   // one up-and-down
const BOB_HEIGHT = 7;      // in drawing units (the laptop is 300 wide)

try { start(); } catch (err) { console.warn('[home-art] static fallback:', err); }

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
  renderer.setClearColor(0x000000, 0);   // fully transparent: the page background shows through
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  host.classList.add('is-live');

  const scene = new THREE.Scene();
  // Orthographic camera at the classic isometric angle: same look as the static drawing.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  camera.position.set(400, 330, 400);
  camera.lookAt(0, 0, 0);

  const model = buildLaptop();
  scene.add(model);
  const recolour = () => {
    const [main, faint, amber] = INK[currentTheme()] || INK.dark;
    model.traverse((o) => { if (o.material?.userData.role) o.material.color.set({ holo: main, faint, amber, fibre: o.material.userData.fibre === 'amber' ? amber : main }[o.material.userData.role]); });
    renderer.render(scene, camera);
  };
  addEventListener('holofix:theme', recolour);
  recolour();

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const view = 720;                                       // drawing units visible vertically (lid included)
    camera.top = view / 2 + 70; camera.bottom = -view / 2 + 70;
    camera.left = -view / 2 * (w / h); camera.right = view / 2 * (w / h);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  new ResizeObserver(resize).observe(host);
  resize();
  if (REDUCED) return;

  renderer.setAnimationLoop((ms) => {
    if (!document.body.classList.contains('mode-home')) return;
    const t = ms / 1000;
    model.rotation.y = (t / TURN_SECONDS) * Math.PI * 2;                 // endless slow turn
    model.position.y = Math.sin((t / BOB_SECONDS) * Math.PI * 2) * BOB_HEIGHT;   // gentle bob
    renderer.render(scene, camera);
  });
}

/** The same exploded laptop as home-art.svg, built in 3D from line segments. */
function buildLaptop() {
  const W = 300, D = 210, Z = [-120, -50, 20, 90];        // layer heights: case, internals, keyboard, top case
  const x = (v) => v - W / 2, z = (v) => D / 2 - v;          // drawing coords -> centred, front = +z
  const sets = { holo: [], faint: [], amber: [] };
  const seg = (set, a, b) => sets[set].push(new THREE.Vector3(...a), new THREE.Vector3(...b));
  const rect = (set, x0, y0, x1, y1, h) => {
    const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([u, v]) => [x(u), h, z(v)]);
    for (let i = 0; i < 4; i++) seg(set, p[i], p[(i + 1) % 4]);
  };
  const circle = (set, cx, cy, h, r) => {
    for (let i = 0; i < 20; i++) {
      const a0 = (i / 20) * Math.PI * 2, a1 = ((i + 1) / 20) * Math.PI * 2;
      seg(set, [x(cx) + r * Math.cos(a0), h, z(cy) + r * Math.sin(a0)], [x(cx) + r * Math.cos(a1), h, z(cy) + r * Math.sin(a1)]);
    }
  };

  rect('holo', 0, 0, W, D, Z[0]);                                          // bottom case
  for (const [u, v] of [[30, 25], [W - 30, 25], [30, D - 25], [W - 30, D - 25]]) circle('faint', u, v, Z[0], 7);
  rect('amber', 40, 18, W - 40, 98, Z[1]);                                 // battery
  rect('holo', 95, 120, 205, 190, Z[1]);                                   // logic board
  for (let i = 1; i < 5; i++) seg('faint', [x(95 + 22 * i), Z[1], z(120)], [x(95 + 22 * i), Z[1], z(190)]);
  rect('holo', 138, 140, 162, 165, Z[1]);                                  // chip
  rect('faint', 12, 110, 36, 170, Z[1]); rect('faint', W - 36, 110, W - 12, 170, Z[1]);   // speakers
  for (let r = 0; r < 5; r++) for (let c = 0; c < 12; c++) {               // keys
    const u = 36 + c * 19.5, v = 104 + r * 16; rect('faint', u, v, u + 16, v + 13, Z[2]);
  }
  rect('holo', 95, 16, 205, 82, Z[2]);                                     // trackpad
  rect('holo', 0, 0, W, D, Z[3]);                                          // top case + cut-outs
  rect('faint', 32, 100, W - 32, 186, Z[3]); rect('faint', 92, 13, 208, 85, Z[3]);
  // lid, standing behind and leaning back
  const hingeY = Z[3] + 30, top = hingeY + 200, back = 50, zb = z(D + 20), zt = zb - back;
  const lid = [[x(0), hingeY, zb], [x(W), hingeY, zb], [x(W), top, zt], [x(0), top, zt]];
  for (let i = 0; i < 4; i++) seg('holo', lid[i], lid[(i + 1) % 4]);
  const inner = [[x(12), hingeY + 12, zb - 3], [x(W - 12), hingeY + 12, zb - 3], [x(W - 12), top - 12, zt + 3], [x(12), top - 12, zt + 3]];
  for (let i = 0; i < 4; i++) seg('faint', inner[i], inner[(i + 1) % 4]);

  const group = new THREE.Group();
  const mat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const looks = { holo: mat('#6fe7f0', 0.95), faint: mat('#6fe7f0', 0.45), amber: mat('#f5b04c', 0.95) };
  for (const [k, m] of Object.entries(looks)) m.userData.role = k;
  for (const [k, pts] of Object.entries(sets)) group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), looks[k]));

  // Dashed exploded-view guides at the four corners.
  const guides = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([[0, 0], [W, 0], [W, D], [0, D]].flatMap(([u, v]) =>
      [new THREE.Vector3(x(u), Z[0], z(v)), new THREE.Vector3(x(u), Z[3], z(v))])),
    Object.assign(new THREE.LineDashedMaterial({ color: '#6fe7f0', dashSize: 4, gapSize: 6, transparent: true, opacity: 0.4 }), { userData: { role: 'faint' } }));
  guides.computeLineDistances();
  group.add(guides);

  // Fibres (real-connection style): battery -> board, keyboard -> board, board -> lid.
  const fibre = (a, b, lift, color) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const M = A.clone().add(B).multiplyScalar(0.5); M.y += lift;
    const m = mat(color, 0.8); m.userData = { role: 'fibre', fibre: color === '#f5b04c' ? 'amber' : 'holo' };
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(A, M, B).getPoints(32)), m));
  };
  fibre([x(150), Z[1], z(60)], [x(150), Z[1], z(150)], 45, '#f5b04c');
  fibre([x(150), Z[2], z(48)], [x(150), Z[1], z(150)], 35, '#6fe7f0');
  fibre([x(150), Z[1], z(150)], [x(150), hingeY + 90, zb - 20], 60, '#6fe7f0');
  return group;
}
