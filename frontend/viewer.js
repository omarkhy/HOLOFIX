/*
 * viewer.js — turns a PartsGraph JSON into an explodable hologram.
 *
 * Pipeline, top to bottom:
 *   1. load JSON                       (loadGraph)
 *   2. device frame from real dimensions (buildDevice: wedge profile, hinged lid)
 *   3. one Three.js object per part    (buildPart -> shapes.js)
 *   4. place parts + explode           (layoutParts)
 *   5. fibres for real connections     (buildFibres / updateFibres)
 *   6. interaction: hover, click, isolate a system, explode slider
 *   7. render loop with bloom          (the "glow" is a post-processing pass, not a texture)
 *
 * The slider has two phases:
 *   0 → SCAN_END   "materialise": the real device (lit, real colours) is turned into a hologram by
 *                  a scan line sweeping upwards. Done with two clipping planes at the same height:
 *                  solid materials keep what is ABOVE the line, hologram materials what is BELOW.
 *   SCAN_END → 1   "explode": the hologram parts separate.
 *
 * A device has two assemblies:
 *   base -> lies on the plinth. position.x: left→right, position.y: front→back, layer: bottom→top.
 *   lid  -> its own frame, rotated open on the hinge. position.y: 0 at the hinge → 1 at the top edge;
 *           layer 0 = outer back cover, higher layers = towards the user (panel, glass).
 * Three.js has Y pointing up; the front of the device faces the camera (+Z).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildShape, ABSOLUTE_SHAPES } from './shapes.js';

// ---------- Settings ----------

// Which graph to show. Override with ?data=path/to/file.json
const DATA_URL = new URLSearchParams(location.search).get('data')
  || '../data/samples/macbook_air_m1_2020.json';

// Scene scale: 1 unit = 10 cm, so millimetres × 0.01.
const MM = 0.01;
// Used when the graph has no dimensions (e.g. a generic template): a typical 13" laptop.
const FALLBACK_DIMENSIONS = { width: 300, depth: 210, height_min: 5, height_max: 16 };

const LID_OPEN_DEG = 108;        // how far the screen is opened
const LAYER_GAP = 0.44;          // base: extra height per layer when fully exploded
const SPREAD = 0.22;             // base: parts also move outwards from the centre (armor feel)
const LID_GAP = 0.5;             // lid: each layer moves towards the viewer
const STAGGER = 0.35;            // outer layers start moving before inner ones
const SCAN_END = 0.3;            // first 30 % of the slider = scan from real device to hologram
const EASE_RATE = 5;             // easing speed (per second): ~0.6 s to cover most of a slider move
const START_SLIDER = 0.8;        // the load animation runs the slider to 80 %
const BLOOM_STRENGTH = 0.6;

// Real-colour materials, one recipe per `finish`. `body` takes the device's own colour.
const FINISH = {
  body:     { metalness: 0.55, roughness: 0.38 },                    // anodised aluminium
  screen:   { color: '#050608', metalness: 0.2, roughness: 0.08 },   // black glass
  keys:     { color: '#141518', metalness: 0.1, roughness: 0.55 },   // keycaps
  internal: { color: '#2b2f34', metalness: 0.4, roughness: 0.5 },    // hidden parts
};

const COLORS = {
  holo: new THREE.Color('#6fe7f0'),
  hazard: new THREE.Color('#f5b04c'),
  data: new THREE.Color('#6fe7f0'),
  power: new THREE.Color('#f5b04c'),
  thermal: new THREE.Color('#ff7a6b'),
  mechanical: new THREE.Color('#b9b3a6'),
  plinth: new THREE.Color('#e9e4d8'),
};

// Opacity of [fill, edges] for each visual state of a part.
const LOOK = {
  idle:     [0.02, 0.7],
  hover:    [0.07, 1.0],
  selected: [0.09, 1.0],
  dimmed:   [0.004, 0.08],
};

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Global state (small on purpose) ----------

const state = {
  graph: null,
  parts: new Map(),     // part id -> { part, group, fill, edges }
  fibres: [],           // { conn, line, pulse, phase, offset }
  explode: 0,           // what is drawn: 0 = real device, 1 = fully exploded
  target: 0,            // where the slider is; `explode` eases towards it every frame
  hoveredId: null,
  selectedId: null,
  isolatedSystem: null, // system id or null for "all"
  dev: null,            // device frame: sizes, wedge function, lid pivot (see buildDevice)
  holoT: 0,             // 0 = real device, 1 = full hologram (scan progress)
};

// ---------- Scene setup ----------

const stageEl = document.getElementById('stage');
const tooltipEl = document.getElementById('tooltip');
const panelEl = document.getElementById('panel');
const railEl = document.getElementById('rail');
const sliderEl = document.getElementById('explode');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;   // needed for the scan-line clipping planes
stageEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Set the background on the scene (colour-managed), not renderer.setClearColor: with the bloom
// composer the clear colour gets gamma-encoded twice and the dark stage turns grey.
scene.background = new THREE.Color('#070a0e');
// Reflections for the metal: a procedural studio room baked into an environment map.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
// Soft key light from the upper front so the silver reads bright, like product shots.
scene.add(new THREE.HemisphereLight('#ffffff', '#20242a', 0.8));   // tuned for three.js 0.170
const keyLight = new THREE.DirectionalLight('#ffffff', 0.9);
keyLight.position.set(3, 6, 5);
scene.add(keyLight);

// The two scan-line planes. A Plane keeps points where normal·p + constant >= 0.
const holoClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);  // hologram: keep y <= scanY
const solidClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);  // real device: keep y >= scanY
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(4.6, 2.9, 5.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2.5;
controls.maxDistance = 14;
controls.target.set(0, 0.8, -0.3);

// Bloom = render the scene, then blur its bright pixels and add them back -> glow.
// (strength 0.6, radius 0.3, threshold 0.12: higher values wash the dark stage out.)
// The composer renders into an off-screen buffer, which does NOT inherit the renderer's
// antialiasing. samples: 4 = multisampling (MSAA) on that buffer, so edges stay smooth.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.3, 0.12);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const { clientWidth: w, clientHeight: h } = stageEl;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Resizing a WebGL canvas wipes it. Draw again right now (ResizeObserver runs before the
  // browser paints), so a blank frame never reaches the screen while the side menu animates.
  if (state.dev) composer.render();
}
new ResizeObserver(resize).observe(stageEl);

// The plinth: two faint rings under the exhibit, like a museum pedestal.
function buildPlinth() {
  for (const r of [2.4, 2.65]) {
    const pts = new THREE.EllipseCurve(0, 0, r, r).getPoints(128);
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, -0.05, p.y)));
    const mat = new THREE.LineBasicMaterial({ color: COLORS.plinth, transparent: true, opacity: r < 2.4 ? 0.14 : 0.06 });
    scene.add(new THREE.LineLoop(geo, mat));
  }
}

// ---------- 1. Load ----------

async function loadGraph(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.json();
}

// ---------- 2. Device frame ----------

/**
 * Everything that depends on the real device dimensions. The base is a wedge: thin at the front,
 * thick at the back (like the M1 Air: 4.1 mm → 16.1 mm with the lid closed). The lid is a constant
 * thickness slab that takes ~70 % of the thinnest edge.
 */
function buildDevice(graph) {
  const dims = graph.device.dimensions_mm || FALLBACK_DIMENSIONS;
  const W = dims.width * MM, D = dims.depth * MM;
  const lidT = dims.height_min * 0.7 * MM;
  const baseFront = dims.height_min * MM - lidT;
  const baseBack = dims.height_max * MM - lidT;

  // Height of the base's top surface at depth z (z = +D/2 is the front edge).
  const baseTopAt = (z) => {
    const t = THREE.MathUtils.clamp((D / 2 - z) / D, 0, 1);  // 0 at the front, 1 at the back
    return baseFront + (baseBack - baseFront) * t;
  };

  // Top-case cut-outs = footprints of the big input parts (keyboard, trackpad) in the base.
  const cutouts = graph.parts
    .filter(p => (p.assembly || 'base') === 'base' && p.system_id === 'input' && p.size.w * p.size.d > 0.02)
    .map(p => ({ x: (p.position.x - 0.5) * W, z: (0.5 - p.position.y) * D, w: p.size.w * W, d: p.size.d * D }));

  // The lid hangs from a pivot on the back edge of the base and is rotated open.
  const lidPivot = new THREE.Group();
  lidPivot.rotation.x = -THREE.MathUtils.degToRad(LID_OPEN_DEG);
  scene.add(lidPivot);

  const maxLayer = (assembly) => Math.max(1, ...graph.parts.filter(p => (p.assembly || 'base') === assembly).map(p => p.layer));

  // Vertical extent of the assembled device (lid tip included): the scan line travels this range.
  const top = baseTopAt(-D / 2) + Math.sin(THREE.MathUtils.degToRad(LID_OPEN_DEG)) * D + 0.05;

  return {
    W, D, lidT, baseBack, baseTopAt, cutouts, lidPivot, scanRange: [-0.03, top],
    radius: Math.min(W, D) * 0.045, wall: 0.03, deckThickness: 0.012,
    maxLayer: { base: maxLayer('base'), lid: maxLayer('lid') },
  };
}

// ---------- 3. Parts -> 3D objects ----------

/**
 * Real size of a part in scene units. size.h is relative to the thickness available where the
 * part sits: the lid thickness, or the base's wedge height at the part's depth (so parts near
 * the thin front edge come out thinner, as they are in reality).
 */
function partSize(part) {
  const { W, D, baseBack, lidT, baseTopAt } = state.dev;
  let H = baseBack;
  if ((part.assembly || 'base') === 'lid') H = lidT;
  else if (!ABSOLUTE_SHAPES.has(part.shape)) H = baseTopAt((0.5 - part.position.y) * D);
  return { w: part.size.w * W, d: part.size.d * D, h: Math.max(part.size.h * H, 0.006) };
}

/** Builds the hologram object for one part: a faint fill (also used for picking) + glowing edges. */
function buildPart(part) {
  const color = part.hazard ? COLORS.hazard : COLORS.holo;
  const { geo, lines, centreLine } = buildShape(part.shape, partSize(part), state.dev);

  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: LOOK.idle[0], clippingPlanes: [holoClip],
    depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  fill.userData.partId = part.id;

  // The real-colour version of the same geometry (shown before the scan).
  const recipe = FINISH[part.finish || 'internal'];
  // Creased normals: smooth shading across gentle curves (rounded corners), sharp shading
  // across real edges (> 30°). Without this every corner segment shows as a flat facet.
  const solid = new THREE.Mesh(toCreasedNormals(geo, Math.PI / 6), new THREE.MeshStandardMaterial({
    color: part.finish === 'body' ? (state.graph.device.color?.hex || '#c8c9cc') : recipe.color,
    metalness: recipe.metalness, roughness: recipe.roughness,
    side: THREE.DoubleSide, clippingPlanes: [solidClip],
  }));

  // Edges: cables draw their centre line; everything else draws the mesh outline
  // (EdgesGeometry keeps only edges where faces meet at > 20°, so curves stay clean).
  const edges = centreLine
    ? new THREE.Line(new THREE.BufferGeometry().setFromPoints(centreLine), new THREE.LineBasicMaterial({ color, transparent: true, clippingPlanes: [holoClip] }))
    : new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color, transparent: true, clippingPlanes: [holoClip] }));

  const group = new THREE.Group();
  group.add(solid, fill, edges);
  if (lines) {   // detail lines: board traces, screen area, camera
    const detail = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color, transparent: true, clippingPlanes: [holoClip] }));
    detail.userData.isTrace = true;
    group.add(detail);
  }

  // Lid parts live inside the rotated lid frame; base parts directly in the scene.
  ((part.assembly || 'base') === 'lid' ? state.dev.lidPivot : scene).add(group);

  // Anchor = centre of the part's geometry; fibres attach here.
  geo.computeBoundingBox();
  const anchor = geo.boundingBox.getCenter(new THREE.Vector3());
  return { part, group, solid, fill, edges, anchor };
}

// ---------- 4. Layout: where every part sits for the current explode value ----------

/**
 * Staggered explode: the slider value E (0..1) is turned into a per-part value e (0..1).
 * Outer layers (high rank) start immediately, inner ones start later — plates peel off
 * first, like armor coming apart. rank = layer / max layer of the part's assembly.
 */
function staggered(E, rank) {
  const delay = STAGGER * (1 - rank);
  return THREE.MathUtils.clamp((E - delay) / (1 - STAGGER), 0, 1);
}

function layoutParts() {
  const { W, D, lidT, baseTopAt, deckThickness, maxLayer, lidPivot } = state.dev;
  applyScan();
  // Parts only start separating once the scan is complete.
  const E = THREE.MathUtils.clamp((state.explode - SCAN_END) / (1 - SCAN_END), 0, 1);

  for (const { part, group } of state.parts.values()) {
    const assembly = part.assembly || 'base';
    const e = staggered(E, part.layer / maxLayer[assembly]);
    const s = partSize(part);

    if (assembly === 'lid') {
      // Lid frame: x across, z from the hinge (0) to the top edge (D), y through the lid thickness.
      const x = (part.position.x - 0.5) * W;
      const z = part.position.y * D;
      const yClosed = lidT * (1 - (part.layer + 0.5) / (maxLayer.lid + 1));
      group.position.set(x, yClosed - e * part.layer * LID_GAP, z);   // -y = towards the user
      continue;
    }

    if (ABSOLUTE_SHAPES.has(part.shape)) {
      // Shells are modelled in device coordinates; they only move up.
      group.position.set(0, e * part.layer * LAYER_GAP, 0);
      continue;
    }

    // Internal part, closed: layers spread evenly between the floor (layer 1) and the underside
    // of the top case (highest internal layer), measured at the part's own depth in the wedge.
    const x0 = (part.position.x - 0.5) * W;
    const z0 = (0.5 - part.position.y) * D;
    const floor = 0.006;
    const room = Math.max(baseTopAt(z0) - deckThickness - floor, s.h);
    const topInternal = Math.max(2, maxLayer.base - 1);
    const t = THREE.MathUtils.clamp((part.layer - 1) / (topInternal - 1), 0, 1);
    const yClosed = floor + s.h / 2 + t * (room - s.h);
    // Exploded: up by layer, and outwards from the centre.
    group.position.set(x0 * (1 + e * SPREAD), yClosed + e * part.layer * LAYER_GAP, z0 * (1 + e * SPREAD));
  }

  // The lid moves back and up as the base opens, so the two never collide.
  lidPivot.position.set(0, baseTopAt(-D / 2) + E * 0.3, -D / 2 - E * 1.7);

  updateFibres();
}

// ---------- 4b. Scan line: real device -> hologram ----------

let scanLine = null;

/** A glowing horizontal frame that marks the scan height. */
function buildScanLine() {
  const { W, D } = state.dev;
  const w = W * 1.15, z0 = D / 2 + 0.15, z1 = -D / 2 - 0.8;   // covers the base and the tilted lid
  const pts = [[-w / 2, z0], [w / 2, z0], [w / 2, z1], [-w / 2, z1], [-w / 2, z0]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: COLORS.holo }));
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, z0 - z1).rotateX(-Math.PI / 2).translate(0, 0, (z0 + z1) / 2),
    new THREE.MeshBasicMaterial({ color: COLORS.holo, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  scanLine = new THREE.Group();
  scanLine.add(frame, sheet);
  scene.add(scanLine);
}

/** Moves the clipping planes and scan line for the current slider value; fades glow and fibres in. */
function applyScan() {
  const T = THREE.MathUtils.clamp(state.explode / SCAN_END, 0, 1);
  const [y0, y1] = state.dev.scanRange;
  const y = y0 + (y1 - y0) * T;
  // Once the scan is complete the hologram must not be clipped at all: exploded parts rise
  // above the assembled height (that bug cut the top of the screen off).
  holoClip.constant = T >= 1 ? 1e6 : y;   // hologram visible below y
  solidClip.constant = -y;                // real device visible above y
  scanLine.position.y = y;
  scanLine.visible = T > 0 && T < 1;
  for (const e of state.parts.values()) e.solid.visible = T < 1;
  bloom.strength = BLOOM_STRENGTH * T;
  if (T !== state.holoT) { state.holoT = T; refreshLooks(); }
}

// ---------- 4. Fibres: one per REAL connection ----------

function buildFibres() {
  const seen = new Map(); // "a|b" -> how many fibres already between this pair (to fan them out)
  for (const conn of state.graph.connections) {
    const key = [conn.source, conn.target].sort().join('|');
    const index = seen.get(key) || 0;
    seen.set(key, index + 1);

    const color = COLORS[conn.kind] || COLORS.data;
    const geo = new THREE.BufferGeometry().setFromPoints(new Array(40).fill(0).map(() => new THREE.Vector3()));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }));

    // A small bright dot that travels along the fibre — the "signal".
    const pulseGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]);
    const pulse = new THREE.Points(pulseGeo, new THREE.PointsMaterial({
      color, size: 0.07, transparent: true, opacity: 0.9, depthWrite: false,
    }));

    scene.add(line, pulse);
    state.fibres.push({ conn, line, pulse, offset: index, phase: Math.random(), curve: null });
  }
}

/** Recompute every fibre's curve from the current part positions (called on every explode change). */
function updateFibres() {
  scene.updateMatrixWorld(true);   // lid parts are nested in the rotated lid, so use world positions
  for (const f of state.fibres) {
    const a = state.parts.get(f.conn.source), b = state.parts.get(f.conn.target);
    if (!a || !b) continue;
    const start = a.group.localToWorld(a.anchor.clone());
    const end = b.group.localToWorld(b.anchor.clone());
    // Control point lifted above the midpoint so the fibre arcs instead of cutting through parts.
    const mid = start.clone().add(end).multiplyScalar(0.5);
    mid.y += 0.25 + start.distanceTo(end) * 0.12;
    mid.z += f.offset * 0.18;
    f.curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    f.line.geometry.setFromPoints(f.curve.getPoints(39));
  }
}

// ---------- 5a. Visual state ----------

function partIsVisible(part) {
  return !state.isolatedSystem || part.system_id === state.isolatedSystem;
}

function setLook(entry, look) {
  const [fillOpacity, edgeOpacity] = LOOK[look];
  entry.fill.material.opacity = fillOpacity;
  entry.edges.material.opacity = edgeOpacity;
  // Real-colour view: hover/selection tints the part cyan; dimmed parts turn see-through.
  const m = entry.solid.material;
  m.emissive.set(look === 'hover' || look === 'selected' ? '#1b5a62' : '#000000');
  const wantTransparent = look === 'dimmed';
  if (m.transparent !== wantTransparent) { m.transparent = wantTransparent; m.needsUpdate = true; }
  m.opacity = wantTransparent ? 0.12 : 1;
  for (const child of entry.group.children) {
    if (child.userData.isTrace) child.material.opacity = edgeOpacity * 0.35;
  }
}

/** Single place that decides how everything looks, from state. Call after any state change. */
function refreshLooks() {
  for (const [id, entry] of state.parts) {
    let look = 'idle';
    if (!partIsVisible(entry.part)) look = 'dimmed';
    else if (state.selectedId && id !== state.selectedId) look = 'dimmed';
    if (id === state.hoveredId && partIsVisible(entry.part)) look = 'hover';
    if (id === state.selectedId) look = 'selected';
    // When a part is selected, keep its direct neighbours readable.
    if (state.selectedId && look === 'dimmed' && isNeighbour(id, state.selectedId) && partIsVisible(entry.part)) look = 'idle';
    setLook(entry, look);
  }
  for (const f of state.fibres) {
    const touchesSelection = state.selectedId && (f.conn.source === state.selectedId || f.conn.target === state.selectedId);
    const bothVisible = partIsVisible(state.parts.get(f.conn.source).part) && partIsVisible(state.parts.get(f.conn.target).part);
    let opacity = 0.45;
    if (state.selectedId) opacity = touchesSelection ? 1 : 0.05;
    else if (!bothVisible) opacity = 0.05;
    f.line.material.opacity = opacity * state.holoT;          // fibres appear with the hologram
    f.pulse.material.opacity = opacity > 0.2 ? state.holoT : 0;
  }
}

function isNeighbour(a, b) {
  return state.graph.connections.some(c => (c.source === a && c.target === b) || (c.source === b && c.target === a));
}

// ---------- 5b. Picking (hover + click) ----------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownAt = null;

function pickPart(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // Only pickable: parts in the isolated system (or all of them).
  const targets = [...state.parts.values()].filter(e => partIsVisible(e.part)).map(e => e.fill);
  const hit = raycaster.intersectObjects(targets, false)[0];
  return hit ? hit.object.userData.partId : null;
}

renderer.domElement.addEventListener('pointermove', (event) => {
  const id = pickPart(event);
  if (id !== state.hoveredId) {
    state.hoveredId = id;
    refreshLooks();
  }
  renderer.domElement.classList.toggle('pointing', !!id);
  if (id) {
    const rect = stageEl.getBoundingClientRect();
    tooltipEl.textContent = state.parts.get(id).part.name;
    tooltipEl.style.left = `${event.clientX - rect.left}px`;
    tooltipEl.style.top = `${event.clientY - rect.top}px`;
    tooltipEl.hidden = false;
  } else {
    tooltipEl.hidden = true;
  }
});

renderer.domElement.addEventListener('pointerleave', () => {
  state.hoveredId = null;
  tooltipEl.hidden = true;
  refreshLooks();
});

// A click is a press + release without dragging (otherwise it was a rotation).
renderer.domElement.addEventListener('pointerdown', (e) => { pointerDownAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!pointerDownAt) return;
  const moved = Math.hypot(event.clientX - pointerDownAt[0], event.clientY - pointerDownAt[1]);
  pointerDownAt = null;
  if (moved > 5) return;
  select(pickPart(event));
});

addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });

function select(id) {
  state.selectedId = id;
  refreshLooks();
  renderPanel();
}

// ---------- 5c. Systems rail ----------

function renderRail() {
  const counts = {};
  for (const p of state.graph.parts) counts[p.system_id] = (counts[p.system_id] || 0) + 1;
  const items = [{ id: null, name: 'All parts', n: state.graph.parts.length },
    ...state.graph.systems.filter(s => !s.parent_id).map(s => ({ id: s.id, name: s.name, n: counts[s.id] || 0 }))];

  railEl.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.setAttribute('aria-pressed', String(state.isolatedSystem === item.id));
    btn.innerHTML = `${item.name}<small>${item.n}</small>`;
    btn.addEventListener('click', () => {
      state.isolatedSystem = item.id;
      if (state.selectedId && !partIsVisible(state.parts.get(state.selectedId).part)) state.selectedId = null;
      renderRail();
      refreshLooks();
      renderPanel();
    });
    railEl.appendChild(btn);
  }
}

// ---------- 5d. Details panel ----------

const SERVICE = {
  replaceable: ['ok', 'Replaceable', 'Comes out with screws and connectors.'],
  glued: ['care', 'Replaceable with care', 'Held in with adhesive. Needs patience and the right tools.'],
  soldered: ['locked', 'Soldered', 'Fixed to the board. Only a board-level repair shop can change it.'],
  not_serviceable: ['locked', 'Not replaceable on its own', 'Replaced together with the larger assembly it belongs to.'],
};

const HAZARD_TEXT = {
  lithium_battery: 'Lithium battery. If it is swollen, punctured or hot, stop using the device and take it to a professional. Do not open it yourself.',
  mains_voltage: 'Mains voltage. Unplug before anything else; internal repairs are for a qualified technician.',
  hv_capacitor: 'High-voltage capacitor. It can stay charged after unplugging. Technician only.',
  ev_high_voltage: 'Electric vehicle high voltage. Technician only.',
  airbag: 'Airbag system. Technician only.',
  brakes: 'Brake system. Safety-critical: technician only.',
  fuel_system: 'Fuel system. Fire risk: technician only.',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderPanel() {
  const g = state.graph;
  const unverified = g.provenance === 'generated';
  const provenance = `<span class="provenance ${unverified ? 'unverified' : ''}">${unverified ? 'Unverified data: not yet checked against sources' : 'Extracted from cited sources'}</span>`;

  if (!state.selectedId) {
    const parts = g.parts.filter(partIsVisible);
    const n = (kind) => parts.filter(p => p.serviceability === kind).length;
    const system = g.systems.find(s => s.id === state.isolatedSystem);
    panelEl.innerHTML = `
      ${provenance}
      <p class="kicker">${system ? escapeHtml(system.name) : 'Exhibit'}</p>
      <h1>${escapeHtml(g.device.model_name)}</h1>
      <div class="stats">
        <div><b>${parts.length}</b><span>parts</span></div>
        <div><b>${n('replaceable') + n('glued')}</b><span>replaceable</span></div>
        <div><b>${n('soldered') + n('not_serviceable')}</b><span>locked in</span></div>
      </div>
      ${g.device.summary && !system ? `<p class="lead">${escapeHtml(g.device.summary)}</p>` : ''}
      ${Object.keys(g.device.key_specs || {}).length && !system ? `<h2>At a glance</h2>
      <dl class="specs">${Object.entries(g.device.key_specs).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>` : ''}
      <p class="quiet hint">Select a part to see what it does, whether you can replace it, and where the information comes from.</p>
      <h2>Your configuration</h2>
      <dl class="specs">${Object.entries(g.device.configuration).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
    return;
  }

  const p = state.parts.get(state.selectedId).part;
  const system = g.systems.find(s => s.id === p.system_id);
  const [cls, label, explain] = SERVICE[p.serviceability];
  const specs = Object.entries(p.specs);
  const links = g.connections.filter(c => c.source === p.id || c.target === p.id);

  panelEl.innerHTML = `
    ${provenance}
    <p class="kicker">${escapeHtml(system ? system.name : p.system_id)}</p>
    <h1>${escapeHtml(p.name)}</h1>
    <p class="lead">${escapeHtml(p.function)}</p>
    <div class="status ${cls}"><i></i><b>${label}</b><span>${explain}</span></div>
    ${p.hazard ? `<div class="hazard"><b>Safety</b>${HAZARD_TEXT[p.hazard]}</div>` : ''}
    ${specs.length ? `<h2>In this configuration</h2><dl class="specs">${specs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>` : ''}
    ${links.length ? `<h2>Connected to</h2><ul class="links">${links.map(c => {
      const other = state.parts.get(c.source === p.id ? c.target : c.source).part;
      return `<li><i class="kind ${c.kind}"></i><button data-part="${other.id}">${escapeHtml(other.name)}</button> <span class="quiet">${escapeHtml(c.label || c.kind)}</span></li>`;
    }).join('')}</ul>` : ''}
    <p class="source">
      ${p.source_url ? `Source: <a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">${escapeHtml(new URL(p.source_url).hostname.replace('www.', ''))}</a><br>` : 'No source cited.<br>'}
      Confidence ${Math.round(p.confidence * 100)}%
    </p>`;

  // Clicking a connected part jumps to it.
  panelEl.querySelectorAll('button[data-part]').forEach(btn =>
    btn.addEventListener('click', () => select(btn.dataset.part)));
}

// ---------- 5e. Explode slider ----------

// The slider only sets a target; the render loop glides `explode` towards it (see animate),
// so dragging feels smooth instead of jumping from step to step.
sliderEl.addEventListener('input', () => { state.target = sliderEl.value / 100; });

/**
 * The one orchestrated moment: the real device is scanned into a hologram, then opens up.
 * Plays once on load; afterwards the slider is fully in the user's hands.
 */
function introAnimation() {
  const setSlider = (v) => { state.explode = state.target = v; sliderEl.value = v * 100; layoutParts(); };
  if (REDUCED_MOTION) { setSlider(START_SLIDER); return; }
  const t0 = performance.now(), duration = 3200;
  const step = (now) => {
    const t = Math.min((now - t0) / duration, 1);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // ease in-out
    setSlider(eased * START_SLIDER);
    if (t < 1) requestAnimationFrame(step);
  };
  setTimeout(() => requestAnimationFrame(step), 900);   // let the real device be seen first
}

// ---------- 6. Render loop ----------

const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.1);      // seconds since last frame (capped after tab switches)
  const t = clock.elapsedTime;
  // Ease the drawn explode value towards the slider. Time-based exponential smoothing:
  // the same speed on a 30 Hz laptop and a 120 Hz screen.
  const gap = state.target - state.explode;
  if (Math.abs(gap) > 0.0005) {
    state.explode += REDUCED_MOTION ? gap : gap * (1 - Math.exp(-EASE_RATE * dt));
    layoutParts();
  }
  for (const f of state.fibres) {
    if (!f.curve) continue;
    const u = (t * 0.35 + f.phase) % 1;              // position along the fibre, 0..1
    f.pulse.geometry.attributes.position.setXYZ(0, ...f.curve.getPoint(u).toArray());
    f.pulse.geometry.attributes.position.needsUpdate = true;
  }
  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}

// ---------- Boot ----------

async function main() {
  try {
    state.graph = await loadGraph(DATA_URL);
  } catch (err) {
    document.getElementById('stage-status').textContent =
      `${err.message}. Serve the repo root with "python -m http.server" and open /frontend/.`;
    return;
  }
  document.getElementById('stage-status').remove();

  const g = state.graph;
  state.dev = buildDevice(g);
  document.title = `HOLOFIX · ${g.device.model_name}`;
  // Colour + the configuration values (skipping the chip line and anything repeated, e.g. the colour).
  const metaBits = [...new Set([g.device.color?.name, ...Object.entries(g.device.configuration)
    .filter(([k]) => k !== 'chip').map(([, v]) => v)].filter(Boolean))];
  document.getElementById('device-meta').innerHTML =
    `<strong>${escapeHtml(g.device.model_name)}</strong><span>${escapeHtml(metaBits.join(', '))}</span>`;

  buildPlinth();
  buildScanLine();
  for (const part of g.parts) state.parts.set(part.id, buildPart(part));
  buildFibres();
  layoutParts();
  refreshLooks();
  renderRail();
  renderPanel();
  resize();
  animate();
  await window.holofixBoot;   // let the opening scene finish first (see boot.js)
  introAnimation();
}

main();
