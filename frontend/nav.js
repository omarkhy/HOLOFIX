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

// ---------- Dot field in the top-left corner ----------
// Same look as the intro backdrop: cyan dots above a diagonal, violet below, each dot fading
// with distance from the corner. Drawn once on a canvas (and again on resize).
const dots = document.getElementById('corner-dots');
function drawDots() {
  const w = Math.min(760, innerWidth), h = 300, dpr = Math.min(devicePixelRatio, 2);
  dots.width = w * dpr; dots.height = h * dpr;
  dots.style.width = `${w}px`; dots.style.height = `${h}px`;
  const g = dots.getContext('2d');
  g.scale(dpr, dpr);
  const step = 10;
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      // Fade: strongest in the corner, gone by ~95 % of the width / height.
      const fade = Math.max(0, 1 - Math.hypot(x / (w * 0.95), y / (h * 0.95)));
      if (fade <= 0) continue;
      const violet = y > 34 + x * 0.12;                // diagonal split, as in the intro
      const a = Math.pow(fade, 1.6) * 0.6;
      const light = document.documentElement.dataset.theme === 'light';
      g.fillStyle = violet ? (light ? `rgba(98,70,190,${a})` : `rgba(154,123,255,${a})`)
                           : (light ? `rgba(15,108,116,${a})` : `rgba(111,231,240,${a})`);
      g.beginPath(); g.arc(x, y, 1.15, 0, Math.PI * 2); g.fill();
    }
  }
}
drawDots();
addEventListener('resize', drawDots);
addEventListener('holofix:theme', drawDots);
