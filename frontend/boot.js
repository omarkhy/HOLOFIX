/*
 * boot.js — the opening scene: a real glass cube (refraction, iridescence, dispersion) spins
 * around Y, spins up, pops, then flies into the logo spot in the top-left corner.
 *
 * How the flight works: we don't move the cube in 3D. We measure where the cube is on screen and
 * where the logo is. The canvas is first cropped (CSS clip-path) to a rounded square around the
 * cube — an app icon — then that square is moved and shrunk (CSS transform) onto the logo.
 * The corner cube (brand.js) is the same glass cube at the same angle, and the intro cube slows
 * down to stop exactly at that angle, so the hand-over is invisible; then this canvas is deleted.
 *
 * The canvas is OPAQUE (alpha: false) on purpose: with a see-through canvas, the glass lets the
 * page underneath show through and the cube turns milky.
 *
 * window.holofixBoot is a Promise the viewer waits on, so its own scan intro starts afterwards.
 * Skipped on any click/key, after the first play in this browser session, and for users who
 * prefer reduced motion.
 */

import * as THREE from 'three';
import { makeGlassCube, dressScene, screenBox, cornerCubeBox, REST_Y, CAMERA } from './brand.js';

const BAR_COLOR = new THREE.Color('#e9f9ff');   // the light bar behind the cube (dims during power-down)
const overlay = document.getElementById('boot');
let finish;
window.holofixBoot = new Promise((resolve) => { finish = resolve; });

function alreadyPlayed() {
  try { return sessionStorage.getItem('holofix.booted') === '1'; } catch { return false; }
}
function markPlayed() {
  try { sessionStorage.setItem('holofix.booted', '1'); } catch { /* storage blocked: fine */ }
}

if (alreadyPlayed() || matchMedia('(prefers-reduced-motion: reduce)').matches) {
  overlay.remove();
  document.body.classList.remove('booting');
  finish();
} else {
  try {
    play();
  } catch (err) {
    // Never block the site because of the intro: log it, remove the cover, carry on.
    console.error('[boot] intro failed, skipping it:', err);
    overlay.remove();
    document.body.classList.remove('booting');
    finish();
  }
}

function play() {
  // Skip on any click or key — attached first, so it works even if something below fails.
  let end = () => { overlay.remove(); document.body.classList.remove('booting'); finish(); };
  const skip = () => { removeEventListener('keydown', skip); overlay.removeEventListener('click', skip); end(); };
  addEventListener('keydown', skip);
  overlay.addEventListener('click', skip);

  const W = innerWidth, H = innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  overlay.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#070a0e');
  dressScene(scene, renderer);   // same reflections and lights as the corner cube
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, W / H, 0.1, 100);
  camera.position.set(0, 0, CAMERA.z);

  // Backdrop: glass is only visible through what it bends, so it needs something behind it.
  const field = dotField(), bar = lightBar();
  scene.add(field, bar);

  // The cube: built by brand.js so it is identical to the corner cube.
  const cube = makeGlassCube();
  scene.add(cube);

  // ---- Timeline (milliseconds)
  // Timings (ms). Tuned 1.2x faster than the first version: snappy, like a console app launch.
  const SPIN = 1670, SPINUP = 580, FLY = 920;
  const t0 = performance.now();
  let flying = false, done = false, speed = 1.08;   // radians per second
  let landing = null;                              // set when the flight starts
  let last = t0;

  function frame(now) {
    if (done) return;
    const t = now - t0, dt = (now - last) / 1000; last = now;
    if (landing) {
      // Decelerate onto the corner cube's resting angle (ease-out), so the landing matches it.
      const k = Math.min((now - landing.t0) / landing.ms, 1);
      cube.rotation.y = landing.from + (landing.to - landing.from) * (1 - Math.pow(1 - k, 3));
    } else {
      if (t > SPIN) speed = Math.min(speed + dt * 21.6, 10.8);             // spin-up
      cube.rotation.y += speed * dt;
    }
    const pop = t > SPIN ? Math.sin(Math.min((t - SPIN) / SPINUP, 1) * Math.PI) * 0.18 : 0;
    cube.scale.setScalar(1 + pop);                                     // swell, then settle
    // Neon power-down: starts as the cube spins up, ends as the flight begins (before the crop),
    // so the background goes dark dot by dot instead of being cut away.
    const p = (t - (SPIN - 250)) / (SPINUP + 500);
    if (p > 0 && p < 1.05) {
      field.userData.powerDown(Math.min(p, 1));
      bar.material.color.copy(BAR_COLOR).multiplyScalar(Math.max(0, 1 - p * 1.2));   // bar dims too
    }
    if (t > SPIN + SPINUP && !flying) fly();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // Own time limit: whatever happens in the animation loop, the intro ends.
  setTimeout(() => end(), SPIN + SPINUP + FLY + 2500);

  /** Crop the canvas to a square around the cube, then fly it so the cube lands on the corner cube. */
  function fly() {
    flying = true;
    // Spin on, slowing down, to the next turn that ends at the corner cube's resting angle.
    const from = cube.rotation.y, TAU = Math.PI * 2;
    const to = REST_Y + TAU * Math.ceil((from + 2 - REST_Y) / TAU);
    landing = { from, to, t0: performance.now(), ms: FLY };
    cube.scale.setScalar(1);

    // Measure with the cube at its final pose (same projection, rotation at REST_Y).
    const save = cube.rotation.y; cube.rotation.y = REST_Y;
    const box = screenBox(cube, camera, W, H);
    cube.rotation.y = save;
    const target = cornerCubeBox();
    const scale = target.width / box.width;
    const side = Math.min(W, H) * 0.62;                  // square crop around the cube
    const inset = {
      top: box.cy - side / 2, left: box.cx - side / 2,
      right: W - (box.cx + side / 2), bottom: H - (box.cy + side / 2),
    };
    const crop = `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px round ${side * 0.22}px)`;
    const dx = target.cx - box.cx, dy = target.cy - box.cy;

    const canvas = renderer.domElement;
    canvas.style.transformOrigin = `${box.cx}px ${box.cy}px`;
    overlay.classList.add('clear');                     // the dark page cover fades, the app appears
    canvas.animate(
      [
        { clipPath: 'inset(0px 0px 0px 0px round 0px)', transform: 'none', opacity: 1, offset: 0 },
        { clipPath: crop, transform: 'none', opacity: 1, offset: 0.3 },
        { clipPath: crop, transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1, offset: 0.85 },
        { clipPath: crop, transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0, offset: 1 },  // melt into the corner cube
      ],
      { duration: FLY, easing: 'cubic-bezier(0.55, 0, 0.2, 1)', fill: 'forwards' },
    ).finished.then(() => end());
  }

  end = function () {
    if (done) return;
    done = true;
    markPlayed();
    document.body.classList.remove('booting');           // flat logo fades in
    overlay.classList.add('gone');
    setTimeout(() => { overlay.remove(); renderer.dispose(); }, 250);
    finish();
  };
}

/**
 * Cyan/violet dot matrix with a soft diagonal band of light. Each dot gets its own "switch-off"
 * time — outer dots first, a little random — so the field can power down like neon tubes:
 * powerDown(t) redraws it for a time t in [0, 1] of the power-down window.
 */
function dotField() {
  const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
  const g = c.getContext('2d');
  const dots = [];
  for (let y = 6; y < c.height; y += 14) for (let x = 6; x < c.width; x += 14) {
    const d = (y - (300 + x * 0.25)) / 140;
    const dist = Math.hypot((x - 800) / 800, (y - 500) / 500) / Math.SQRT2;   // 0 centre … 1 corner
    dots.push({
      x, y,
      rgb: d > 0 ? '150,160,255' : '111,231,240',
      a: Math.exp(-d * d * 1.6) * 0.7 + 0.04,
      off: Math.min(0.97, Math.max(0.05, (1 - dist) * 0.8 + Math.random() * 0.2)), // outer = earlier
      seed: Math.random(),
    });
  }

  /** Brightness of one dot: full, then 1–2 quick flickers just before its switch-off, then dark. */
  function level(dot, t) {
    const until = dot.off - t;                 // time left before this dot goes dark
    if (until <= 0) return 0;
    if (until > 0.12) return 1;
    const phase = Math.floor((until / 0.12) * 6 + dot.seed * 3);   // neon stutter
    return phase % 2 ? 0.15 : 1;
  }

  function draw(t) {
    g.fillStyle = '#070a0e'; g.fillRect(0, 0, c.width, c.height);   // dark base: faint dots stay faint
    for (const dot of dots) {
      const k = t === 0 ? 1 : level(dot, t);
      if (k <= 0) continue;
      g.fillStyle = `rgba(${dot.rgb},${dot.a * k})`;
      g.beginPath(); g.arc(dot.x, dot.y, 2.1, 0, Math.PI * 2); g.fill();
    }
    tex.needsUpdate = true;
  }

  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  draw(0);
  // Opaque on purpose: glass (transmission) only refracts opaque objects.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(18, 11.25), new THREE.MeshBasicMaterial({ map: tex }));
  mesh.position.z = -4;
  mesh.userData.powerDown = draw;
  return mesh;
}

/** A thin bright bar behind the cube: its broken image inside the glass is what reads as "glass". */
function lightBar() {
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(18, 0.06), new THREE.MeshBasicMaterial({ color: BAR_COLOR.clone() }));
  bar.position.set(0, -0.2, -3.9);
  bar.rotation.z = -0.25;
  return bar;
}
