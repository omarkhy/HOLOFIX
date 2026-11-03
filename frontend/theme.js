/*
 * theme.js — dark "museum after hours" or light "cream archive" (the palette of the museum reference).
 * The choice is remembered in this browser; the default is dark.
 * Pages react to the 'holofix:theme' event (3D scene, dot field, home drawing redraw their colours).
 */

const KEY = 'holofix.theme';

export function currentTheme() {
  return document.documentElement.dataset.theme || 'dark';
}

function initial() {
  try { const saved = localStorage.getItem(KEY); if (saved === 'light' || saved === 'dark') return saved; } catch { /* blocked */ }
  return 'dark';   // the signature look; light is one click away and remembered
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* blocked: works for this visit */ }
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.setAttribute('aria-checked', String(theme === 'dark'));   // switch "on" = dark
    btn.dataset.mode = theme;
  }
  dispatchEvent(new CustomEvent('holofix:theme', { detail: theme }));
}

setTheme(initial());
document.getElementById('theme-btn')?.addEventListener('click', () => setTheme(currentTheme() === 'light' ? 'dark' : 'light'));
