'use strict';

/**
 * Sehr einfache, dateibasierte Persistenz (JSON).
 * Kein DB-Server noetig -> laeuft ueberall, auch auf einem Raspberry Pi.
 * Reicht locker fuer ein paar Dutzend Tracker mit Positions-Updates alle paar Sekunden.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nanoid, customAlphabet } = require('nanoid');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TRACKERS_FILE = path.join(DATA_DIR, 'trackers.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
// Vollstaendige, unbegrenzte Aufzeichnung aller Fixes (Grundlage fuer die offizielle Zeitmessung).
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// Wie viele Punkte pro Tracker als "Spur" (Track auf der Karte) behalten werden.
const MAX_TRAIL_POINTS = parseInt(process.env.MAX_TRAIL_POINTS || '1000', 10);
// Nach wie vielen Sekunden ohne Update ein Tracker als "offline" gilt.
const STALE_AFTER_MS = parseInt(process.env.STALE_AFTER_SECONDS || '90', 10) * 1000;

const idAlphabet = '23456789abcdefghjkmnpqrstuvwxyz'; // ohne 0/O/1/l/i zur besseren Lesbarkeit
const genId = customAlphabet(idAlphabet, 6);

const COLOR_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000',
  '#000075', '#a9a9a9'
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(file, data) {
  ensureDataDir();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

ensureDataDir();

/** @type {Record<string, {id:string,name:string,token:string,color:string,createdAt:number}>} */
let trackers = loadJson(TRACKERS_FILE, {});
/** @type {Record<string, {latest: object|null, trail: object[]}>} */
let positions = loadJson(POSITIONS_FILE, {});

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveJsonAtomic(TRACKERS_FILE, trackers);
    saveJsonAtomic(POSITIONS_FILE, positions);
  }, 1000);
}

/** Ausstehende Speicherung sofort ausfuehren (beim Beenden des Servers). */
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveJsonAtomic(TRACKERS_FILE, trackers);
  saveJsonAtomic(POSITIONS_FILE, positions);
}

function pickColor() {
  const used = new Set(Object.values(trackers).map((t) => t.color));
  const free = COLOR_PALETTE.find((c) => !used.has(c));
  return free || COLOR_PALETTE[Object.keys(trackers).length % COLOR_PALETTE.length];
}

/** Kleinste freie LoRa-Nummer (1..250) - so heisst das Funk-Geraet in der Firmware (TRACKER_ID). */
function nextLoraId() {
  const used = new Set(Object.values(trackers).map((t) => t.loraId).filter((n) => n != null));
  for (let n = 1; n <= 250; n += 1) if (!used.has(n)) return n;
  return null;
}

function createTracker(name) {
  const id = genId();
  const token = nanoid(32);
  const tracker = {
    id,
    name: (name || `Tracker ${id}`).slice(0, 60),
    token,
    color: pickColor(),
    loraId: nextLoraId(),
    createdAt: Date.now()
  };
  trackers[id] = tracker;
  positions[id] = { latest: null, trail: [] };
  scheduleSave();
  return tracker;
}

function listTrackers() {
  return Object.values(trackers);
}

function getTracker(id) {
  return trackers[id] || null;
}

function deleteTracker(id) {
  const existed = !!trackers[id];
  delete trackers[id];
  delete positions[id];
  try { fs.unlinkSync(historyFile(id)); } catch { /* keine Historie vorhanden */ }
  historyCache.delete(id);
  if (existed) scheduleSave();
  return existed;
}

function verifyToken(id, token) {
  const t = trackers[id];
  if (!t || !token || typeof token !== 'string') return false;
  const a = crypto.createHash('sha256').update(t.token).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function renameTracker(id, name) {
  const t = trackers[id];
  if (!t) return null;
  t.name = (name || t.name).slice(0, 60);
  scheduleSave();
  return t;
}

function historyFile(id) {
  return path.join(HISTORY_DIR, `${id}.jsonl`);
}

function appendHistory(id, entry) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(historyFile(id), JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[history] Schreiben fehlgeschlagen:', err.message);
  }
}

/** Alle aufgezeichneten Fixes eines Trackers (ungeordnet, ggf. mit Duplikaten). */
function readHistory(id) {
  let raw;
  try {
    raw = fs.readFileSync(historyFile(id), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* halbe Zeile nach Absturz ueberspringen */ }
  }
  return out;
}

/** Tracker zu einem Tracker-Token finden (null = Token gehoert keinem Tracker). Zeitkonstanter Vergleich. */
function findTrackerByToken(token) {
  if (!token || typeof token !== 'string') return null;
  let found = null;
  for (const t of Object.values(trackers)) {
    if (verifyToken(t.id, token)) found = t; // alle durchlaufen, damit die Laufzeit nicht verraet, wo ein Treffer liegt
  }
  return found;
}

function getTrackerByLoraId(n) {
  return Object.values(trackers).find((t) => t.loraId === n) || null;
}

/** LoRa-Nummer eines Trackers aendern (null = keine). Gibt Fehlermeldung als String zurueck oder null. */
function setLoraId(id, n) {
  const t = trackers[id];
  if (!t) return 'Tracker unbekannt';
  if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 250)) return 'LoRa-Nr muss 1-250 sein';
  const other = n === null ? null : getTrackerByLoraId(n);
  if (other && other.id !== id) return `LoRa-Nr ${n} ist schon bei "${other.name}" vergeben`;
  t.loraId = n;
  scheduleSave();
  return null;
}

// Gecachte Historie: Datei wird nur einmal komplett gelesen, danach nur noch das neu Angehaengte. Das Ergebnis darf
// von Aufrufern nicht veraendert werden (gemeinsames Array).
const historyCache = new Map();
function readHistoryCached(id) {
  const file = historyFile(id);
  let st;
  try { st = fs.statSync(file); } catch { historyCache.delete(id); return []; }
  let c = historyCache.get(id);
  if (!c || st.size < c.size) c = { size: 0, fixes: [], carry: '' };
  if (st.size > c.size) {
    const len = st.size - c.size;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, c.size); } finally { fs.closeSync(fd); }
    const lines = (c.carry + buf.toString('utf8')).split('\n');
    c.carry = lines.pop(); // letzte (evtl. unvollstaendige) Zeile erst beim naechsten Mal
    for (const line of lines) {
      if (!line) continue;
      try { c.fixes.push(JSON.parse(line)); } catch { /* defekte Zeile ueberspringen */ }
    }
    c.size = st.size;
  }
  historyCache.set(id, c);
  return c.fixes;
}

/** Pro Tracker: Anzahl Eintraege sowie erste/letzte Zeit der Aufzeichnung. */
function historySummary() {
  return Object.values(trackers).map((t) => {
    const fixes = readHistoryCached(t.id);
    let first = null;
    let last = null;
    for (const f of fixes) {
      if (first === null || f.ts < first) first = f.ts;
      if (last === null || f.ts > last) last = f.ts;
    }
    return { trackerId: t.id, name: t.name, loraId: t.loraId ?? null, count: fixes.length, firstTs: first, lastTs: last };
  });
}

function recordPosition(id, pos) {
  if (!positions[id]) positions[id] = { latest: null, trail: [] };
  const entry = {
    lat: pos.lat,
    lon: pos.lon,
    accuracy: pos.accuracy ?? null,
    speed: pos.speed ?? null, // m/s
    heading: pos.heading ?? null, // Grad
    battery: pos.battery ?? null, // 0..1
    ts: pos.ts || Date.now()
  };
  appendHistory(id, entry);
  const trail = positions[id].trail;
  // Nachgesendete (aeltere) Fixes duerfen die "aktuelle" Position nicht ueberschreiben.
  if (!positions[id].latest || entry.ts >= positions[id].latest.ts) positions[id].latest = entry;
  trail.push(entry);
  if (trail.length > 1 && trail[trail.length - 2].ts > entry.ts) trail.sort((x, y) => x.ts - y.ts);
  if (positions[id].trail.length > MAX_TRAIL_POINTS) {
    positions[id].trail.splice(0, positions[id].trail.length - MAX_TRAIL_POINTS);
  }
  scheduleSave();
  return entry;
}

function isStale(entry) {
  if (!entry) return true;
  return Date.now() - entry.ts > STALE_AFTER_MS;
}

// Wie viele Spurpunkte pro Boot beim Laden/Verbinden an die Zuschauer gehen (ausgeduennt, damit es klein bleibt).
const PUBLIC_TRAIL_POINTS = parseInt(process.env.PUBLIC_TRAIL_POINTS || '150', 10);

/** Gleichmaessig auf hoechstens max Punkte ausduennen (erster und letzter Punkt bleiben). */
function decimate(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(arr[Math.round(i * step)]);
  return out;
}

/**
 * Oeffentliche Sicht auf einen Tracker. Standard: mit (ausgeduennter) Spur - fuer das erste Laden.
 * { trail: false }: nur letzte Position, ohne Spur - fuer Live-Updates (der Browser haengt sie selbst an die Spur an).
 */
function getPublicTracker(id, { trail = true } = {}) {
  const t = trackers[id];
  if (!t) return null;
  const pos = positions[id] || { latest: null, trail: [] };
  const out = {
    id: t.id,
    name: t.name,
    color: t.color,
    latest: pos.latest,
    stale: isStale(pos.latest)
  };
  if (trail) out.trail = decimate(pos.trail, PUBLIC_TRAIL_POINTS);
  return out;
}

/** Nur der Online/Offline-Zustand aller Tracker (sehr klein) - fuer die regelmaessige Statusmeldung. */
function staleMap() {
  const out = {};
  for (const t of Object.values(trackers)) out[t.id] = isStale((positions[t.id] || {}).latest);
  return out;
}

function listPublicTrackers() {
  return listTrackers().map((t) => getPublicTracker(t.id));
}

function clearTrail(id) {
  if (!positions[id]) return false;
  positions[id].trail = positions[id].latest ? [positions[id].latest] : [];
  scheduleSave();
  return true;
}

module.exports = {
  readHistoryCached,
  historySummary,
  flush,
  findTrackerByToken,
  decimate,
  staleMap,
  getTrackerByLoraId,
  setLoraId,
  readHistory,
  loadJson,
  saveJsonAtomic,
  DATA_DIR,
  createTracker,
  listTrackers,
  getTracker,
  deleteTracker,
  verifyToken,
  renameTracker,
  recordPosition,
  getPublicTracker,
  listPublicTrackers,
  clearTrail,
  STALE_AFTER_MS
};
