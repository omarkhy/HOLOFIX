/*
 * nav.js — the side menu. Collapsed = icons only, open = icons + labels (like YouTube).
 * Desktop: the menu is a column that widens. Phone (<= 860 px): it slides over the page
 * and closes on Esc, on a tap outside it, or when the window shrinks to phone size.
 * The open/closed choice is remembered in this browser (localStorage), which can be
 * unavailable (private mode, blocked storage) — hence the try/catch.
 */

const button = document.getElementById('menu-btn');
const drawer = document.getElementById('drawer');
const KEY = 'holofix.drawerOpen';
const phone = matchMedia('(max-width: 860px)');

function isOpen() { return document.body.classList.contains('drawer-open'); }

function setOpen(open, remember = true) {
  document.body.classList.toggle('drawer-open', open);
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Hide menu' : 'Show menu');
  if (remember && !phone.matches) {
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* storage unavailable: fine */ }
  }
}

let saved = false;
try { saved = localStorage.getItem(KEY) === '1'; } catch { /* default: collapsed */ }
setOpen(saved && !phone.matches, false);           // phones always start closed

button.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!isOpen()); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && phone.matches) setOpen(false, false); });
document.addEventListener('click', (e) => {
  if (phone.matches && isOpen() && !drawer.contains(e.target)) setOpen(false, false);
});
phone.addEventListener('change', () => { if (phone.matches) setOpen(false, false); });
