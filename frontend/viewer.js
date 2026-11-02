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
const LAYER_GAP = 0.34;          // base: extra height per layer when fully exploded
const SPREAD = 0.22;             // base: parts also move outwards from the centre (armor feel)
const LID_GAP = 0.35;            // lid: each layer moves towards the viewer
const STAGGER = 0.35;            // outer layers start moving before inner ones
const START_EXPLODE = 0.75;      // the load animation opens the model to 75 %

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
  explode: 0,           // 0 = assembled, 1 = fully exploded
  hoveredId: null,
  selectedId: null,
  isolatedSystem: null, // system id or null for "all"
  dev: null,            // device frame: sizes, wedge function, lid pivot (see buildDevice)
};

// ---------- Scene setup ----------

const stageEl = document.getElementById('stage');
const tooltipEl = document.getElementById('tooltip');
const panelEl = document.getElementById('panel');
const railEl = document.getElementById('rail');
const sliderEl = document.getElementById('explode');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stageEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Set the background on the scene (colour-managed), not renderer.setClearColor: with the bloom
// composer the clear colour gets gamma-encoded twice and the dark stage turns grey.
scene.background = new THREE.Color('#070a0e');
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(4.6, 2.9, 5.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2.5;
controls.maxDistance = 14;
controls.target.set(0, 0.8, -0.3);

// Bloom = render the scene, then blur its bright pixels and add them back -> glow.
// (strength 0.6, radius 0.3, threshold 0.12: higher values wash the dark stage out.)
const composer = new EffectComposer(renderer);
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

  return {
    W, D, lidT, baseBack, baseTopAt, cutouts, lidPivot,
    radius: Math.min(W, D) * 0.045, wall: 0.03, deckThickness: 0.012,
    maxLayer: { base: maxLayer('base'), lid: maxLayer('lid') },
  };
}

// ---------- 3. Parts -> 3D objects ----------

/** Real size of a part in scene units. Heights are relative to the base (or lid) thickness. */
function partSize(part) {
  const { W, D, baseBack, lidT } = state.dev;
  const H = (part.assembly || 'base') === 'lid' ? lidT : baseBack;
  return { w: part.size.w * W, d: part.size.d * D, h: Math.max(part.size.h * H, 0.006) };
}

/** Builds the hologram object for one part: a faint fill (also used for picking) + glowing edges. */
function buildPart(part) {
  const color = part.hazard ? COLORS.hazard : COLORS.holo;
  const { geo, lines, centreLine } = buildShape(part.shape, partSize(part), state.dev);

  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: LOOK.idle[0],
    depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  fill.userData.partId = part.id;

  // Edges: cables draw their centre line; everything else draws the mesh outline
  // (EdgesGeometry keeps only edges where faces meet at > 20°, so curves stay clean).
  const edges = centreLine
    ? new THREE.Line(new THREE.BufferGeometry().setFromPoints(centreLine), new THREE.LineBasicMaterial({ color, transparent: true }))
    : new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color, transparent: true }));

  const group = new THREE.Group();
  group.add(fill, edges);
  if (lines) {   // detail lines: board traces, screen area, camera
    const detail = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color, transparent: true }));
    detail.userData.isTrace = true;
    group.add(detail);
  }

  // Lid parts live inside the rotated lid frame; base parts directly in the scene.
  ((part.assembly || 'base') === 'lid' ? state.dev.lidPivot : scene).add(group);

  // Anchor = centre of the part's geometry; fibres attach here.
  geo.computeBoundingBox();
  const anchor = geo.boundingBox.getCenter(new THREE.Vector3());
  return { part, group, fill, edges, anchor };
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
  const E = state.explode;

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

    // Internal part: sits on the floor inside the wedge, stacked a little by layer when closed.
    const x0 = (part.position.x - 0.5) * W;
    const z0 = (0.5 - part.position.y) * D;
    const room = baseTopAt(z0) - deckThickness - 0.008;
    const yClosed = 0.008 + s.h / 2 + Math.max(0, part.layer - 1) * room * 0.25;
    // Exploded: up by layer, and outwards from the centre.
    group.position.set(x0 * (1 + e * SPREAD), yClosed + e * part.layer * LAYER_GAP, z0 * (1 + e * SPREAD));
  }

  // The lid moves back and up as the base opens, so the two never collide.
  lidPivot.position.set(0, baseTopAt(-D / 2) + E * 0.3, -D / 2 - E * 1.7);

  updateFibres();
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
    f.line.material.opacity = opacity;
    f.pulse.material.opacity = opacity > 0.2 ? 1 : 0;
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
      <p class="quiet">Select a part to see what it does, whether you can replace it, and where the information comes from.</p>
      <h2>Configuration</h2>
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

sliderEl.addEventListener('input', () => {
  state.explode = sliderEl.value / 100;
  layoutParts();
});

/** The one orchestrated moment: the device opens up once on load. */
function introAnimation() {
  if (REDUCED_MOTION) {
    state.explode = START_EXPLODE;
    sliderEl.value = START_EXPLODE * 100;
    layoutParts();
    return;
  }
  const t0 = performance.now(), duration = 1800;
  const step = (now) => {
    const t = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    state.explode = eased * START_EXPLODE;
    sliderEl.value = state.explode * 100;
    layoutParts();
    if (t < 1) requestAnimationFrame(step);
  };
  setTimeout(() => requestAnimationFrame(step), 400);
}

// ---------- 6. Render loop ----------

const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();
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
  document.getElementById('device-meta').innerHTML =
    `<strong>${escapeHtml(g.device.model_name)}</strong><span>${escapeHtml(Object.values(g.device.configuration).slice(1).join(', '))}</span>`;

  buildPlinth();
  for (const part of g.parts) state.parts.set(part.id, buildPart(part));
  buildFibres();
  layoutParts();
  refreshLooks();
  renderRail();
  renderPanel();
  resize();
  animate();
  introAnimation();
}

main();
