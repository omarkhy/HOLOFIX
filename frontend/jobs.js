/*
 * jobs.js — run a long AI request as a background job and show, live, what each model is doing:
 *   ✓ Muse Spark   Reading teardowns… · 7 sources: ifixit.com, apple.com…      31.2 s
 *   ◌ Muse Spark   Building the parts graph…                                    12.4 s
 * The steps come from the server (backend/progress.py); we poll every 0.7 s.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param kind     identify | configure | extract | diagnose | photo | guide
 * @param payload  the request body of that route
 * @param onUpdate called with the job view ({steps, seconds}) at every poll, to redraw progress
 * @returns the job's result; throws Error(message) if it failed
 */
export async function runJob(kind, payload, onUpdate) {
  const start = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, payload }) });
  const started = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(readable(started.detail) || `The server answered ${start.status}.`);
  for (;;) {
    await new Promise(r => setTimeout(r, 700));
    const res = await fetch(`/api/jobs/${started.id}`);
    const view = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(view.detail || `The server answered ${res.status}.`);
    onUpdate?.(view);
    if (view.status === 'done') return view.result;
    if (view.status === 'error') throw new Error(view.error || 'The job failed.');
  }
}

function readable(detail) {
  if (Array.isArray(detail)) return detail.map(d => d.msg).join('; ');   // FastAPI validation errors
  return detail;
}

/** The progress card. `title` is the headline ("Opening your device"), `view` the latest job view. */
export function progressHtml(title, view) {
  const steps = view?.steps || [];
  return `<div class="live">
    <div class="live-head"><span class="live-kicker">Live AI analysis</span><span class="live-time">${view ? view.seconds.toFixed(1) : '0.0'} s</span></div>
    <p class="live-title">${esc(title)}</p>
    <ol class="live-steps">${steps.length ? steps.map(s => `
      <li class="${s.state}">
        <i aria-hidden="true"></i>
        <div><b>${esc(s.model)}</b><span>${esc(s.text)}</span></div>
        <small>${s.seconds.toFixed(1)} s</small>
      </li>`).join('') : '<li class="running"><i></i><div><b>HOLOFIX</b><span>Starting…</span></div><small></small></li>'}
    </ol>
  </div>`;
}
