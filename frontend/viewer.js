/*
 * viewer.js — turns a PartsGraph JSON into an explodable hologram.
 *
 * Pipeline, top to bottom:
 *   1. load JSON                       (loadGraph)
 *   2. one Three.js object per part    (buildPart: coarse shape from `shape` + `size`)
 *   3. place parts by layer            (layoutParts: explode = move up along the layer axis)
 *   4. fibres for real connections     (buildFibres / updateFibres)
 *   5. interaction: hover, click, isolate a system, explode slider
 *   6. render loop with bloom          (the "glow" is a post-processing pass, not a texture)
 *
 * Coordinate convention: Three.js has Y pointing up.
 *   JSON position.x (0..1, left→right)  -> scene X
 *   JSON position.y (0..1, front→back)  -> scene Z (front = +Z, towards the viewer)
 *   JSON layer (0 = bottom)              -> scene Y
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------- Settings ----------

// Which graph to show. Override with ?data=path/to/file.json
const DATA_URL = new URLSearchParams(location.search).get('data')
  || '../data/samples/macbook_air_m1_2020.json';

// Device bounding box in scene units (1 unit ≈ 10 cm). A real M1 Air is 30.4 × 21.2 × 1.6 cm;
// thickness is exaggerated ×2.5 so the closed stack is still readable.
const DEVICE = { W: 3.04, D: 2.12, H: 0.4 };
const LAYER_GAP = 0.6;           // extra height per layer when fully exploded
const START_EXPLODE = 0.6;       // the load animation opens the model to 60 %

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
  maxLayer: 1,
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
camera.position.set(4.4, 3.6, 5.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2.5;
controls.maxDistance = 14;
controls.target.set(0, 1, 0);

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
  for (const r of [2.3, 2.55]) {
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

// ---------- 2. Parts -> geometry ----------

/** Real size of a part in scene units. */
function partSize(part) {
  return {
    w: part.size.w * DEVICE.W,
    d: part.size.d * DEVICE.D,
    h: Math.max(part.size.h * DEVICE.H, 0.012),
  };
}

/** One coarse primitive per shape type. Resemblance, not replica. */
function makeGeometry(part) {
  const { w, d, h } = partSize(part);
  switch (part.shape) {
    case 'cylinder': {
      const r = Math.min(w, d) / 2;
      return new THREE.CylinderGeometry(r, r, h, 32);
    }
    case 'screw':
      return new THREE.CylinderGeometry(w / 2, w / 2, h, 12);
    case 'frame': {
      // A rectangle with a rectangular hole, extruded upwards.
      const outer = new THREE.Shape();
      outer.moveTo(-w / 2, -d / 2); outer.lineTo(w / 2, -d / 2);
      outer.lineTo(w / 2, d / 2); outer.lineTo(-w / 2, d / 2); outer.closePath();
      const hole = new THREE.Path();
      const iw = w * 0.42, id = d * 0.36;   // inner opening, offset towards the back (keyboard well)
      hole.moveTo(-iw, -id + d * 0.1); hole.lineTo(iw, -id + d * 0.1);
      hole.lineTo(iw, id + d * 0.1); hole.lineTo(-iw, id + d * 0.1); hole.closePath();
      outer.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(outer, { depth: h, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);          // extrusion now points up (+Y)
      return geo;
    }
    case 'cable': {
      // A flat S-curve tube across the part's footprint.
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-w / 2, 0, 0),
        new THREE.Vector3(-w / 6, 0, d / 2),
        new THREE.Vector3(w / 6, 0, -d / 2),
        new THREE.Vector3(w / 2, 0, 0),
      ]);
      return new THREE.TubeGeometry(curve, 48, Math.max(h / 2, 0.012), 6, false);
    }
    default: // slab, board, chip, box
      return new THREE.BoxGeometry(w, h, d);
  }
}

/** Builds the hologram object for one part: a faint fill (also used for picking) + glowing edges. */
function buildPart(part) {
  const color = part.hazard ? COLORS.hazard : COLORS.holo;
  const geo = makeGeometry(part);

  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: LOOK.idle[0],
    depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  fill.userData.partId = part.id;

  // Edges: cables use their own centre line; everything else uses the outline of the mesh.
  const edgeGeo = part.shape === 'cable'
    ? new THREE.BufferGeometry().setFromPoints(geo.parameters.path.getPoints(64))
    : new THREE.EdgesGeometry(geo, 20);
  const EdgeType = part.shape === 'cable' ? THREE.Line : THREE.LineSegments;
  const edges = new EdgeType(edgeGeo, new THREE.LineBasicMaterial({
    color, transparent: true, opacity: LOOK.idle[1],
  }));

  // Boards get a fine inner grid so they read as "circuit" rather than "slab".
  const group = new THREE.Group();
  group.add(fill, edges);
  if (part.shape === 'board') group.add(boardTraces(part, color));
  scene.add(group);
  return { part, group, fill, edges };
}

function boardTraces(part, color) {
  const { w, d, h } = partSize(part);
  const pts = [];
  const n = 5;
  for (let i = 1; i < n; i++) {
    const x = -w / 2 + (w * i) / n;
    pts.push(new THREE.Vector3(x, h / 2 + 0.001, -d / 2), new THREE.Vector3(x, h / 2 + 0.001, d / 2));
    const z = -d / 2 + (d * i) / n;
    pts.push(new THREE.Vector3(-w / 2, h / 2 + 0.001, z), new THREE.Vector3(w / 2, h / 2 + 0.001, z));
  }
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
  lines.userData.isTrace = true;
  return lines;
}

// ---------- 3. Layout: the explode is one formula ----------

/**
 * y = (closed height of the layer) + explode × layer × gap
 * Closed: layers share the device thickness. Exploded: each layer lifts in proportion to its index,
 * so the stack opens like an accordion and parts keep their order.
 */
function layerY(layer) {
  const closed = (layer / state.maxLayer) * DEVICE.H;
  return closed + state.explode * layer * LAYER_GAP;
}

function layoutParts() {
  for (const { part, group } of state.parts.values()) {
    const x = (part.position.x - 0.5) * DEVICE.W;
    const z = (0.5 - part.position.y) * DEVICE.D;   // front of the device faces the viewer (+Z)
    const { h } = partSize(part);
    // Frames are extruded from their base; the others are centred on their origin.
    const y = layerY(part.layer) + (part.shape === 'frame' ? 0 : h / 2);
    group.position.set(x, y, z);
  }
  // Keep the camera looking at the middle of the stack as it grows.
  controls.target.y = (layerY(state.maxLayer) + DEVICE.H * 0.3) / 2;
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
  for (const f of state.fibres) {
    const a = state.parts.get(f.conn.source), b = state.parts.get(f.conn.target);
    if (!a || !b) continue;
    const start = a.group.position.clone();
    const end = b.group.position.clone();
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
    if (child.userData.isTrace) child.material.opacity = edgeOpacity * 0.25;
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
  state.maxLayer = Math.max(1, ...g.parts.map(p => p.layer));
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
