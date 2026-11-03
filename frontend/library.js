/*
 * library.js — "Your devices": the devices this browser has saved.
 *
 * Stored in localStorage, so it is per browser, with no account (stated honestly in the UI and
 * README). Each entry only points at a parts graph the server already saved in
 * data/cache/graphs/, so reopening a device is instant and costs no API call.
 * localStorage can be unavailable (private mode, blocked storage): every access is wrapped.
 */

const KEY = 'holofix.library';
const LAST = 'holofix.lastViewed';
export const DEMO_PATH = '/data/samples/macbook_air_m1_2020.json';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** All saved devices, newest first. */
export function listDevices() { return read(KEY, []); }

export function hasDevice(path) { return listDevices().some(d => d.path === path); }

/** Save a device from its parts graph and the graph's URL path. */
export function addDevice(graph, path) {
  const devices = listDevices().filter(d => d.path !== path);
  devices.unshift({
    path,
    model_name: graph.device.model_name,
    configuration: graph.device.configuration,
    color: graph.device.color || null,
    parts: graph.parts.length,
    provenance: graph.provenance,
    saved_at: new Date().toISOString(),
  });
  return write(KEY, devices);
}

export function removeDevice(path) { write(KEY, listDevices().filter(d => d.path !== path)); }

/** The last device opened in the viewer (used by the "Explore" menu entry). */
export function setLastViewed(path) { write(LAST, path); }
export function lastViewed() { return read(LAST, null) || DEMO_PATH; }
