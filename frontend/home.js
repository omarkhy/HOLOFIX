/*
 * home.js — the home page: search, pick a variant, configure, extract, open in 3D.
 * Shown when the URL has no ?data=… (the viewer is shown when it has one).
 *
 * Flow (each step calls one backend route):
 *   search  -> POST /api/identify   -> variant cards (skipped if there is only one)
 *   variant -> POST /api/configure  -> option chips, "fixed at purchase" marked
 *   open    -> POST /api/extract    -> { path } -> the viewer at /?data=<path>
 *
 * Extraction takes 1–3 minutes the first time, so the waiting screen shows what the pipeline
 * is doing and the elapsed time. Results are cached by the server: the second time is instant.
 */

import { listDevices, removeDevice, addDevice, DEMO_PATH, lastViewed } from './library.js';

const params = new URLSearchParams(location.search);
const isHome = !params.has('data');
document.body.classList.toggle('mode-home', isHome);

// Menu entries: real links now.
document.querySelectorAll('[data-nav="explore"]').forEach(a => { a.href = `/?data=${encodeURIComponent(lastViewed())}`; });
/** Two pages share this section: "New device" (search) and "Your devices" (#library). */
function syncPage() {
  const lib = location.hash === '#library';
  document.body.classList.toggle('page-library', isHome && lib);
  document.querySelectorAll('[data-nav="home"]').forEach(a => a.setAttribute('aria-current', isHome && !lib ? 'page' : 'false'));
  document.querySelectorAll('[data-nav="library"]').forEach(a => a.setAttribute('aria-current', isHome && lib ? 'page' : 'false'));
}
syncPage();
addEventListener('hashchange', () => { syncPage(); renderLibrary(); if (location.hash !== '#library') input.focus(); });
if (isHome) document.querySelector('[data-nav="explore"]')?.removeAttribute('aria-current');

const home = document.getElementById('home');
const flow = document.getElementById('flow');
const form = document.getElementById('search');
const input = document.getElementById('query');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `The server answered ${res.status}.`);
  return data;
}

/** A waiting line with a live seconds counter; returns a function that stops it. */
function waiting(lines) {
  const t0 = Date.now();
  flow.innerHTML = `<div class="wait"><span class="pulse" aria-hidden="true"></span><p id="wait-line">${esc(lines[0])}</p><small id="wait-time">0 s</small></div>`;
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    document.getElementById('wait-time').textContent = `${s} s`;
    // Step through the pipeline's stages as time passes (they are honest descriptions of what runs).
    const i = Math.min(lines.length - 1, Math.floor(s / 25));
    document.getElementById('wait-line').textContent = lines[i];
  }, 500);
  return () => clearInterval(timer);
}

function failure(message, retry) {
  flow.innerHTML = `<div class="error"><p><b>That did not work.</b> ${esc(message)}</p><button class="btn" id="retry">Try again</button></div>`;
  document.getElementById('retry').addEventListener('click', retry);
}

// ---------- 1. search ----------

async function search(query) {
  history.replaceState(null, '', '/');
  const stop = waiting([`Searching the web for “${query}”…`, 'Checking which models share that name…']);
  try {
    const result = await api('/api/identify', { query });
    stop();
    if (!result.variants.length) return failure('No device matched that name. Try the full model name, e.g. “MacBook Air 2020”.', () => search(query));
    if (result.variants.length === 1 && !result.needs_choice) return chooseConfig(result.variants[0]);
    showVariants(result);
  } catch (e) { stop(); failure(e.message, () => search(query)); }
}

function showVariants(result) {
  flow.innerHTML = `
    <h2 class="step">“${esc(result.query)}” can mean ${result.variants.length} different machines. Which one is yours?</h2>
    <div class="cards">${result.variants.map((v, i) => `
      <button class="card" data-i="${i}">
        <strong>${esc(v.model_name)}</strong>
        <span class="meta">${esc(v.released)}${v.model_numbers.length ? ` · ${esc(v.model_numbers.join(', '))}` : ''}</span>
        <span class="tell">${esc(v.how_to_tell_apart)}</span>
      </button>`).join('')}</div>
    ${sources(result.sources)}`;
  flow.querySelectorAll('.card').forEach(b => b.addEventListener('click', () => chooseConfig(result.variants[+b.dataset.i])));
}

// ---------- 2. configure ----------

async function chooseConfig(variant) {
  const stop = waiting([`Looking up how the ${variant.model_name} was sold…`]);
  try {
    const cfg = await api('/api/configure', { variant });
    stop();
    showConfig(variant, cfg);
  } catch (e) { stop(); failure(e.message, () => chooseConfig(variant)); }
}

function showConfig(variant, cfg) {
  const chosen = Object.fromEntries(cfg.options.map(o => [o.key, o.default]));
  flow.innerHTML = `
    <h2 class="step">${esc(variant.model_name)}: how was yours configured?</h2>
    <p class="quiet">Pick what you bought. Options marked <em>fixed</em> can never be changed later, which matters for repair.</p>
    <div class="options">${cfg.options.map(o => `
      <fieldset class="option">
        <legend>${esc(o.label)}${o.upgradeable_later === false ? ' <em>fixed</em>' : ''}</legend>
        <div class="chips">${o.choices.map(c => `
          <label class="chip"><input type="radio" name="${esc(o.key)}" value="${esc(c)}" ${c === o.default ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}
        </div>
        ${o.note ? `<small class="quiet">${esc(o.note)}</small>` : ''}
      </fieldset>`).join('')}
    </div>
    <button class="btn primary" id="open">Open in 3D</button>
    ${sources(cfg.sources)}`;
  flow.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => { chosen[r.name] = r.value; }));
  document.getElementById('open').addEventListener('click', () => extract(variant, chosen));
}

// ---------- 3. extract ----------

async function extract(variant, configuration) {
  const stop = waiting([
    'Searching teardowns and repair guides…',
    'Reading official specs and dimensions…',
    'Building the parts graph…',
    'Linking parts: power, data, heat…',
    'Checking every cited source…',
    'Almost there. The first time takes 1–3 minutes; after that it opens instantly.',
  ]);
  try {
    const res = await api('/api/extract', { variant, configuration });
    // Remember it automatically: next time it is one click from "Your devices", no waiting.
    try { addDevice(await (await fetch(res.path)).json(), res.path); } catch { /* not fatal */ }
    stop();
    location.href = `/?data=${encodeURIComponent(res.path)}`;
  } catch (e) { stop(); failure(e.message, () => extract(variant, configuration)); }
}

function sources(urls) {
  if (!urls?.length) return '';
  const host = (u) => { try { return new URL(u).hostname.replace('www.', ''); } catch { return u; } };
  return `<p class="sources">Sources: ${urls.slice(0, 6).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join(', ')}</p>`;
}

// ---------- library ----------

const card = (d) => `
    <div class="device">
      <a href="/?data=${encodeURIComponent(d.path)}">
        <i class="swatch-dot" style="background:${esc(d.color?.hex || '#8a8f96')}"></i>
        <strong>${esc(d.model_name)}</strong>
        <span class="meta">${esc(Object.values(d.configuration || {}).filter(v => v !== d.color?.name).slice(1).join(', '))}</span>
        <span class="meta">${d.parts} parts · ${d.provenance === 'sourced' ? 'from cited sources' : 'unverified'}</span>
      </a>
      ${d.removable === false ? '' : `<button class="remove" data-path="${esc(d.path)}" aria-label="Remove ${esc(d.model_name)}">×</button>`}
    </div>`;

/** "New device" page: the 3 most recent devices. "Your devices" page: all of them + the demo. */
function renderLibrary() {
  const devices = listDevices();
  const full = location.hash === '#library';
  const list = document.getElementById('library-list');
  const demo = `
    <a class="device demo" href="/?data=${encodeURIComponent(DEMO_PATH)}">
      <strong>MacBook Air (M1, 2020)</strong>
      <span class="meta">Demo exhibit · hand-checked sample</span>
    </a>`;
  document.getElementById('library-title').textContent = full ? 'Your devices' : 'Recently opened';
  list.innerHTML = full ? devices.map(card).join('') + demo : devices.slice(0, 3).map(card).join('');
  const empty = document.getElementById('library-empty');
  empty.hidden = devices.length > 0;
  document.getElementById('library').hidden = !full && devices.length === 0;
  list.querySelectorAll('.remove').forEach(b => b.addEventListener('click', () => { removeDevice(b.dataset.path); renderLibrary(); }));
}

/** Popular laptops, pre-built by scripts/prebuild_featured.py: open instantly, no API call. */
async function renderFeatured() {
  let featured = [];
  try { featured = (await (await fetch('/data/featured/index.json')).json()).devices || []; } catch { /* not built yet */ }
  const box = document.getElementById('featured');
  // "Try …" suggestions: 3 random names (from the featured list if it exists).
  const names = featured.length ? featured.map(f => f.query) : ['MacBook Air 2020', 'Dell XPS 13 9310', 'Framework Laptop 13'];
  const pick = names.sort(() => Math.random() - 0.5).slice(0, 3);
  document.getElementById('examples').innerHTML = 'Try ' + pick.map(n => `<button type="button" class="link" data-example="${esc(n)}">${esc(n)}</button>`).join(', ');
  document.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.example; search(b.dataset.example); }));
  if (!featured.length) { box.hidden = true; return; }
  box.hidden = false;
  document.getElementById('featured-list').innerHTML = featured.map(f => `
    <a class="feat" href="/?data=${encodeURIComponent(f.path)}">
      <i class="swatch-dot" style="background:${esc(f.color || '#8a8f96')}"></i>
      <strong>${esc(f.model_name)}</strong><span class="meta">${f.parts} parts</span>
    </a>`).join('');
}

if (isHome) {
  home.hidden = false;
  import('./home-art.js');   // the slowly turning hologram on the right (loaded only on the home page)
  renderLibrary();
  renderFeatured();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) search(q);
  });
  if (location.hash !== '#library') input.focus();
}
