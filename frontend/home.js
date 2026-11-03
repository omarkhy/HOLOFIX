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

import { listDevices, removeDevice, addDevice, DEMO_PATH, lastViewed, listDiagnoses, listGuides } from './library.js';
import { runJob, progressHtml } from './jobs.js';

const params = new URLSearchParams(location.search);
const isHome = !params.has('data');
document.body.classList.toggle('mode-home', isHome);

// Menu entries: real links now.
document.querySelectorAll('[data-nav="explore"]').forEach(a => { a.href = `/?data=${encodeURIComponent(lastViewed())}`; });
document.querySelectorAll('[data-nav="diagnose"]').forEach(a => { a.href = '/#diagnoses'; });
/**
 * The home section holds four pages, picked by the URL hash:
 *   (none) New device · #library Your devices · #diagnoses Diagnoses · #method Method & accuracy
 * Elements carry data-page="new library…"; CSS shows only the current page's elements.
 */
const PAGES = { '': 'new', '#library': 'library', '#diagnoses': 'diagnoses', '#method': 'method' };
const NAV = { new: 'home', library: 'library', diagnoses: 'diagnose', method: 'method' };
function currentPage() { return PAGES[location.hash] || 'new'; }

function syncPage() {
  const page = currentPage();
  document.body.dataset.page = isHome ? page : '';
  document.querySelectorAll('.drawer [data-nav]').forEach(a => a.setAttribute('aria-current',
    (isHome && NAV[page] === a.dataset.nav) || (!isHome && a.dataset.nav === 'explore') ? 'page' : 'false'));
  if (!isHome) return;
  if (page === 'new' || page === 'library') renderLibrary();
  if (page === 'diagnoses') renderDiagnoses();
  if (page === 'method') renderMethod();
  if (page === 'new') input.focus();
  document.getElementById('home').scrollTop = 0;
}
addEventListener('hashchange', syncPage);


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

/** Run a job and draw its live steps in the flow box. */
function job(kind, payload, title) {
  flow.innerHTML = progressHtml(title, null);
  return runJob(kind, payload, (view) => { flow.innerHTML = progressHtml(title, view); });
}

function failure(message, retry) {
  flow.innerHTML = `<div class="error"><p><b>That did not work.</b> ${esc(message)}</p><button class="btn" id="retry">Try again</button></div>`;
  document.getElementById('retry').addEventListener('click', retry);
}

// ---------- 1. search ----------

async function search(query) {
  history.replaceState(null, '', '/');
  try {
    const result = await job('identify', { query }, `Finding “${query}”`);
    if (!result.variants.length) return failure('No device matched that name. Try the full model name, e.g. “MacBook Air 2020”.', () => search(query));
    if (result.variants.length === 1 && !result.needs_choice) return chooseConfig(result.variants[0]);
    showVariants(result);
  } catch (e) { failure(e.message, () => search(query)); }
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
  try {
    const cfg = await job('configure', { variant }, `How was your ${variant.model_name} configured?`);
    showConfig(variant, cfg);
  } catch (e) { failure(e.message, () => chooseConfig(variant)); }
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
  try {
    const res = await job('extract', { variant, configuration },
      `Opening the ${variant.model_name}: the first time takes a few minutes, after that it is instant`);
    // Remember it automatically: next time it is one click from "Your devices", no waiting.
    try { addDevice(await (await fetch(res.path)).json(), res.path); } catch { /* not fatal */ }
    location.href = `/?data=${encodeURIComponent(res.path)}`;
  } catch (e) { failure(e.message, () => extract(variant, configuration)); }
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
  document.getElementById('library-title').className = full ? 'page-title' : '';
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

// ---------- Diagnoses page ----------

function renderDiagnoses() {
  const all = listDiagnoses();
  const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } };
  document.getElementById('diag-list').innerHTML = all.length ? all.map(d => {
    const top = d.result?.suspects?.[0];
    const guides = listGuides(d.path).filter(g => g.symptom === d.symptom);
    const open = `/?data=${encodeURIComponent(d.path)}&diag=${encodeURIComponent(d.symptom)}`;
    return `<div class="diag-card">
      <a class="diag-main" href="${open}">
        <span class="meta">${esc(d.model_name)} · ${esc(when(d.at))}</span>
        <strong>“${esc(d.symptom)}”</strong>
        <span class="d-top">${top ? `Most likely: <b>${esc(top.part_name || top.part_id.replace(/_/g, ' '))}</b> ${Math.round(top.likelihood * 100)}%` : 'Unfinished'}</span>
      </a>
      <div class="diag-tags">${d.photo ? '<span class="tag">photo</span>' : ''}${d.result?.safety_stop ? '<span class="tag stop">safety stop</span>' : ''}</div>
      <div class="diag-actions">
        <a class="btn small" href="${open}">Open in 3D</a>
        ${guides.length ? guides.map(g => `<a class="btn small primary" href="${esc(g.url)}" target="_blank" rel="noopener">Repair guide: ${esc(g.title)} ↗</a>`).join('')
          : '<span class="btn small disabled" title="Open the diagnosis and choose a part’s repair guide to create one">No repair guide yet</span>'}
      </div>
    </div>`;
  }).join('') : '<p class="quiet">No diagnosis yet. Open a device and describe what is wrong in the bar above the model, or add a photo.</p>';
  const devices = [...listDevices(), { path: DEMO_PATH, model_name: 'MacBook Air (M1, 2020) · demo' }];
  document.getElementById('diag-devices').innerHTML = devices.map(d =>
    `<a class="feat" href="/?data=${encodeURIComponent(d.path)}&diagnose"><strong>${esc(d.model_name)}</strong></a>`).join('');
}

// ---------- Method & accuracy page ----------

async function renderMethod() {
  const box = document.getElementById('method');
  let r = null;
  try { const res = await fetch('/data/eval/results.json', { cache: 'no-store' }); if (res.ok) r = await res.json(); } catch { /* not run yet */ }
  const pct = (x) => x == null ? '—' : `${Math.round(x * 100)}%`;
  const bar = (x, cls = '') => `<span class="bar ${cls}"><i style="width:${Math.round((x || 0) * 100)}%"></i></span>`;
  const results = r ? `
    <h2>Measured accuracy</h2>
    <p class="quiet">Run on ${esc(new Date(r.generated_at).toLocaleDateString())} by <code>python -m eval.run_eval</code>. These numbers are generated by the script, not typed by hand.</p>
    <h3>Diagnosis: is the real cause in the answer? (${r.diagnosis.n} documented cases)</h3>
    <table class="eval"><thead><tr><th></th><th>Top-1</th><th>Top-3</th><th>Avg. time</th></tr></thead><tbody>
      ${Object.entries(r.diagnosis.modes).map(([k, m]) => `<tr><th>${k === 'grounded' ? 'Muse Spark + repair sources (HOLOFIX)' : 'Muse Spark alone'}</th>
        <td>${bar(m.top1)}${pct(m.top1)}</td><td>${bar(m.top3, 'b')}${pct(m.top3)}</td><td class="num">${m.avg_seconds}s</td></tr>`).join('')}
    </tbody></table>
    <h3>Safety: dangerous cases stopped</h3>
    <p>${r.safety.caught} of ${r.safety.n} dangerous cases (swollen battery, smoke, airbag, brakes, fuel…) were stopped with “see a professional” and no steps. ${bar(r.safety.n ? r.safety.caught / r.safety.n : 0, 'g')}<br>
      <span class="quiet">False alarms on ordinary cases: ${r.safety.false_stops} of ${r.diagnosis.n - r.safety.n}.</span></p>
    ${r.extraction?.length ? `<h3>Parts lists against hand-checked teardowns</h3>
    <table class="eval"><thead><tr><th>Device</th><th>Found (recall)</th><th>Correct (precision)</th></tr></thead><tbody>
      ${r.extraction.map(e => `<tr><th>${esc(e.device)}</th><td>${bar(e.recall)}${pct(e.recall)} <small>${e.matched}/${e.expected}</small></td><td>${bar(e.precision, 'b')}${pct(e.precision)}</td></tr>`).join('')}
    </tbody></table>` : ''}` : `<h2>Measured accuracy</h2><p class="quiet">The evaluation has not been run on this copy yet: <code>python -m eval.run_eval</code>.</p>`;

  box.innerHTML = `
    <h1 class="page-title">Method &amp; accuracy</h1>
    <p class="lead">How HOLOFIX turns a model name into an explodable device and a diagnosis, which Meta model does what, the rules it can never break, and how well it actually works.</p>
    <h2>How it works</h2>
    <ol class="method-steps">
      <li><b>Identify</b><span><em>Muse Spark + web search</em> finds every machine sold under the name you typed and how to tell them apart.</span></li>
      <li><b>Configure</b><span><em>Muse Spark</em> lists the purchase options (chip, memory, storage), and which are fixed forever.</span></li>
      <li><b>Extract the parts</b><span><em>Muse Spark</em> reads teardowns, repair guides and spec sheets, then writes a parts graph forced into a schema (structured output). Our validator checks every reference and sends errors back for repair; a second pass links the parts (power, data, heat).</span></li>
      <li><b>Build the 3D model</b><span>Procedural, in the browser: the outer shell from the official dimensions, every part from its size, layer and position. No 3D files.</span></li>
      <li><b>Diagnose</b><span><em>Muse Spark</em> searches repair guides and forums for your model and symptom, ranks the likely parts, and asks the one question that best narrows them down.</span></li>
      <li><b>Read a photo</b><span><em>Muse Spark (vision)</em> describes visible damage; <em>SAM 3.1</em> outlines it on your photo.</span></li>
      <li><b>Repair guide</b><span><em>Muse Spark</em> writes cited steps and finds real prices; HOLOFIX adds up the totals.</span></li>
    </ol>
    <h2>Rules enforced in code, not in prompts</h2>
    <ul class="rules">
      <li>Every source shown must be a page the search actually returned; invented links are deleted.</li>
      <li>Screw sizes, counts and torques appear only when the step cites a source. Every price cites its page; totals are computed, never written by the AI.</li>
      <li>Swollen or damaged batteries, smoke, mains voltage, airbags, brakes, fuel and high-voltage systems: diagnosis only, “see a professional”, no steps.</li>
      <li>Suspect parts must exist in the device's parts graph. Likelihoods are normalised.</li>
      <li>If extraction fails, a generic layout is shown, clearly labelled “Unverified”.</li>
    </ul>
    ${results}
    <h2>Limitations</h2>
    <ul class="rules">
      <li>Internal part positions are estimated from text and photos of teardowns: the outer shape is accurate, the inside is approximate.</li>
      <li>Diagnosis is a starting point, not a guarantee. The evaluation cases are documented failures, not a clinical trial.</li>
      <li>Your devices and diagnoses are stored in this browser only (no account).</li>
    </ul>`;
}

if (isHome) {
  home.hidden = false;
  import('./home-art.js');   // the slowly turning hologram on the right (loaded only on the home page)
  renderFeatured();
  syncPage();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) search(q);
  });

}

if (!isHome) syncPage();   // viewer: highlight Explore in the menu
