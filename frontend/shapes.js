/*
 * shapes.js — procedural geometry for every `shape` type in the parts graph.
 *
 * Two families:
 *  - Generic primitives (slab, board, chip, box, cylinder, cable, frame, screw): coarse
 *    "kind of component" shapes for internal parts.
 *  - Recognisable shapes (rounded_slab, keyboard, screen, shell_base, shell_deck): these carry
 *    the device's silhouette. The shell is built from the device's OFFICIAL dimensions
 *    (width, depth, min/max thickness), so the outline is real even if the internals are coarse.
 *
 * Every builder returns { geo, lines }:
 *   geo   -> solid geometry (faint fill + used for mouse picking; its edges are drawn)
 *   lines -> optional extra line geometry drawn faintly (board traces, screen area, camera...)
 *
 * Conventions: Y is up. Geometry is centred on its own origin unless `absolute` is set
 * (shells are modelled in device coordinates because the wedge depends on the Z position).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- Helpers ----------

/**
 * Rounded rectangle drawn into a Shape/Path. Coordinates are in "shape space" (x, s),
 * which becomes world (x, -s) on the ground plane after extrudeUp() — so we pass -z for s.
 */
function roundedRect(path, cx, cz, w, d, r) {
  r = Math.min(r, w / 2, d / 2);
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const s0 = -cz - d / 2, s1 = -cz + d / 2;
  path.moveTo(x0 + r, s0);
  path.lineTo(x1 - r, s0); path.quadraticCurveTo(x1, s0, x1, s0 + r);
  path.lineTo(x1, s1 - r); path.quadraticCurveTo(x1, s1, x1 - r, s1);
  path.lineTo(x0 + r, s1); path.quadraticCurveTo(x0, s1, x0, s1 - r);
  path.lineTo(x0, s0 + r); path.quadraticCurveTo(x0, s0, x0 + r, s0);
  return path;
}

/** Extrude a flat shape upwards: shape lies on the ground (XZ), thickness goes along +Y from 0 to h. */
function extrudeUp(shape, h) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 8 });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Remap every vertex height: y in [0,1] becomes bottom(z) + y * (top(z) - bottom(z)). Makes wedges. */
function taper(geo, bottomAt, topAt) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i), t = pos.getY(i);
    pos.setY(i, bottomAt(z) + t * (topAt(z) - bottomAt(z)));
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
}

/** mergeGeometries needs all inputs to look alike: non-indexed, same attributes. */
function merge(geos) {
  return mergeGeometries(geos.map(g => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position') n.deleteAttribute(name);
    return n;
  }));
}

function linesFromPoints(points) {
  return new THREE.BufferGeometry().setFromPoints(points);
}

// ---------- Generic primitives ----------

function box(w, h, d) { return { geo: new THREE.BoxGeometry(w, h, d) }; }

function roundedSlab(w, h, d) {
  const shape = roundedRect(new THREE.Shape(), 0, 0, w, d, Math.min(w, d) * 0.12);
  const geo = extrudeUp(shape, h);
  geo.translate(0, -h / 2, 0);
  return { geo };
}

function cylinder(w, h, d, segments = 32) {
  const r = Math.min(w, d) / 2;
  return { geo: new THREE.CylinderGeometry(r, r, h, segments) };
}

function cable(w, h, d) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-w / 2, 0, 0), new THREE.Vector3(-w / 6, 0, d / 2),
    new THREE.Vector3(w / 6, 0, -d / 2), new THREE.Vector3(w / 2, 0, 0),
  ]);
  return {
    geo: new THREE.TubeGeometry(curve, 48, Math.max(h / 2, 0.008), 6, false),
    centreLine: curve.getPoints(64),   // drawn instead of mesh edges (tubes have messy edges)
  };
}

function frame(w, h, d) {
  const outer = roundedRect(new THREE.Shape(), 0, 0, w, d, 0.02);
  outer.holes.push(roundedRect(new THREE.Path(), 0, 0, w * 0.84, d * 0.8, 0.02));
  const geo = extrudeUp(outer, h);
  geo.translate(0, -h / 2, 0);
  return { geo };
}

function board(w, h, d) {
  // A PCB: slab + faint grid of "traces" on top so it reads as a circuit.
  const pts = [];
  const top = h / 2 + 0.001, n = 5;
  for (let i = 1; i < n; i++) {
    const x = -w / 2 + (w * i) / n, z = -d / 2 + (d * i) / n;
    pts.push(new THREE.Vector3(x, top, -d / 2), new THREE.Vector3(x, top, d / 2));
    pts.push(new THREE.Vector3(-w / 2, top, z), new THREE.Vector3(w / 2, top, z));
  }
  return { geo: new THREE.BoxGeometry(w, h, d), lines: linesFromPoints(pts) };
}

// ---------- Recognisable shapes ----------

/**
 * Keyboard: a thin plate plus one small box per key. Row layouts in key units (1 = letter key),
 * approximating a modern laptop layout: function row (half height), 4 letter rows, bottom row.
 */
const KEY_ROWS = [
  { h: 0.55, keys: Array(14).fill(1) },
  { h: 1, keys: [...Array(13).fill(1), 1.5] },
  { h: 1, keys: [1.5, ...Array(12).fill(1), 1] },
  { h: 1, keys: [1.75, ...Array(11).fill(1), 1.75] },
  { h: 1, keys: [2.25, ...Array(10).fill(1), 2.25] },
  { h: 1, keys: [1, 1, 1, 1.25, 5, 1.25, 1, 3] },
];

function keyboard(w, h, d) {
  const plateH = h * 0.35, keyH = h * 0.65, gap = 0.12;
  const parts = [new THREE.BoxGeometry(w, plateH, d).translate(0, -h / 2 + plateH / 2, 0)];
  const totalRowUnits = KEY_ROWS.reduce((s, r) => s + r.h, 0);
  const unitZ = d / totalRowUnits;
  let zBack = -d / 2;                                    // rows run from the back (fn row) to the front
  for (const row of KEY_ROWS) {
    const rowD = row.h * unitZ;
    const unitX = w / row.keys.reduce((s, k) => s + k, 0);
    let x = -w / 2;
    for (const k of row.keys) {
      const kw = k * unitX;
      parts.push(new THREE.BoxGeometry(kw - gap * unitX, keyH, rowD - gap * unitZ)
        .translate(x + kw / 2, -h / 2 + plateH + keyH / 2, zBack + rowD / 2));
      x += kw;
    }
    zBack += rowD;
  }
  return { geo: merge(parts) };
}

/**
 * Screen (display panel), modelled flat in the lid's own frame. Extra lines: the visible
 * display area inside the bezel, and the camera dot near the top edge (far from the hinge).
 */
function screen(w, h, d) {
  const { geo } = roundedSlab(w, h, d);
  const y = -h / 2 - 0.002;                             // drawn on the face that looks at the user
  const sideBezel = w * 0.035, topBezel = d * 0.06, bottomBezel = d * 0.04;
  // In the lid frame, local +Z points away from the hinge (= towards the top of the screen).
  const x0 = -w / 2 + sideBezel, x1 = w / 2 - sideBezel;
  const z0 = -d / 2 + bottomBezel, z1 = d / 2 - topBezel;
  const pts = [
    [x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0],
  ].flatMap(([a, b, c, e]) => [new THREE.Vector3(a, y, b), new THREE.Vector3(c, y, e)]);
  const cam = new THREE.EllipseCurve(0, d / 2 - topBezel / 2, 0.012, 0.012).getPoints(16);
  for (let i = 0; i < cam.length - 1; i++) {
    pts.push(new THREE.Vector3(cam[i].x, y, cam[i].y), new THREE.Vector3(cam[i + 1].x, y, cam[i + 1].y));
  }
  return { geo, lines: linesFromPoints(pts) };
}

/**
 * Bottom case: a wedge-shaped tray (thin at the front, thick at the back) with rounded corners,
 * a floor, and four round feet. Built in absolute device coordinates.
 */
function shellBase(ctx) {
  const { W, D, radius, wall, baseTopAt, deckThickness } = ctx;
  const walls = roundedRect(new THREE.Shape(), 0, 0, W, D, radius);
  walls.holes.push(roundedRect(new THREE.Path(), 0, 0, W - 2 * wall, D - 2 * wall, radius - wall));
  const wallGeo = taper(extrudeUp(walls, 1), () => 0, z => baseTopAt(z) - deckThickness);
  const floor = extrudeUp(roundedRect(new THREE.Shape(), 0, 0, W, D, radius), 0.006);
  const feet = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) =>
    new THREE.CylinderGeometry(0.07, 0.07, 0.008, 24).translate(sx * (W / 2 - 0.3), -0.004, sz * (D / 2 - 0.22)));
  return { geo: merge([wallGeo, floor, ...feet]) };
}

/**
 * Top case: the deck plate following the wedge's top surface, with cut-outs where the
 * keyboard and trackpad sit. Cut-outs come from those parts' positions in the graph (ctx.cutouts).
 */
function shellDeck(ctx) {
  const { W, D, radius, baseTopAt, deckThickness, cutouts } = ctx;
  const plate = roundedRect(new THREE.Shape(), 0, 0, W, D, radius);
  for (const c of cutouts) plate.holes.push(roundedRect(new THREE.Path(), c.x, c.z, c.w + 0.03, c.d + 0.03, 0.03));
  return { geo: taper(extrudeUp(plate, 1), z => baseTopAt(z) - deckThickness, z => baseTopAt(z)) };
}

// ---------- Dispatcher ----------

/** Which shapes are modelled in absolute device coordinates (not centred on the part). */
export const ABSOLUTE_SHAPES = new Set(['shell_base', 'shell_deck']);

/**
 * @param shape  the part's `shape` string
 * @param size   {w, h, d} in scene units
 * @param ctx    device context (dimensions, wedge function, cut-outs) for the shells
 */
export function buildShape(shape, size, ctx) {
  const { w, h, d } = size;
  switch (shape) {
    case 'shell_base': return shellBase(ctx);
    case 'shell_deck': return shellDeck(ctx);
    case 'keyboard': return keyboard(w, h, d);
    case 'screen': return screen(w, h, d);
    case 'rounded_slab': return roundedSlab(w, h, d);
    case 'board': return board(w, h, d);
    case 'cylinder': return cylinder(w, h, d);
    case 'screw': return cylinder(w, h, d, 12);
    case 'cable': return cable(w, h, d);
    case 'frame': return frame(w, h, d);
    default: return box(w, h, d);                         // slab, chip, box
  }
}
