'use strict';

/**
 * Sehr einfache, dateibasierte Persistenz (JSON).
 * Kein DB-Server noetig -> laeuft ueberall, auch auf einem Raspberry Pi.
 * Reicht locker fuer ein paar Dutzend Tracker mit Positions-Updates alle paar Sekunden.
 */

const fs = require('fs');
const path = require('path');
const { nanoid, customAlphabet } = require('nanoid');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TRACKERS_FILE = path.join(DATA_DIR, 'trackers.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const CONFIGS_FILE = path.join(DATA_DIR, 'configs.json');

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
/** Segeluhr-Konfiguration pro Tracker (frei strukturiertes JSON vom Handy). @type {Record<string, {updatedAt:number,data:object}>} */
let configs = loadJson(CONFIGS_FILE, {});

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveJsonAtomic(TRACKERS_FILE, trackers);
    saveJsonAtomic(POSITIONS_FILE, positions);
    saveJsonAtomic(CONFIGS_FILE, configs);
  }, 1000);
}

function pickColor() {
  const used = new Set(Object.values(trackers).map((t) => t.color));
  const free = COLOR_PALETTE.find((c) => !used.has(c));
  return free || COLOR_PALETTE[Object.keys(trackers).length % COLOR_PALETTE.length];
}

function createTracker(name) {
  const id = genId();
  const token = nanoid(32);
  const tracker = {
    id,
    name: (name || `Tracker ${id}`).slice(0, 60),
    token,
    color: pickColor(),
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
  delete configs[id];
  if (existed) scheduleSave();
  return existed;
}

function verifyToken(id, token) {
  const t = trackers[id];
  return !!t && !!token && t.token === token;
}

function renameTracker(id, name) {
  const t = trackers[id];
  if (!t) return null;
  t.name = (name || t.name).slice(0, 60);
  scheduleSave();
  return t;
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
  positions[id].latest = entry;
  positions[id].trail.push(entry);
  if (positions[id].trail.length > MAX_TRAIL_POINTS) {
    positions[id].trail.splice(0, positions[id].trail.length - MAX_TRAIL_POINTS);
  }
  scheduleSave();
  return entry;
}

function getConfig(id) {
  return configs[id] || null;
}

function setConfig(id, data) {
  if (!trackers[id]) return null;
  configs[id] = { updatedAt: Date.now(), data };
  scheduleSave();
  return configs[id];
}

function isStale(entry) {
  if (!entry) return true;
  return Date.now() - entry.ts > STALE_AFTER_MS;
}

function getPublicTracker(id) {
  const t = trackers[id];
  if (!t) return null;
  const pos = positions[id] || { latest: null, trail: [] };
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    latest: pos.latest,
    trail: pos.trail,
    stale: isStale(pos.latest)
  };
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
  getConfig,
  setConfig,
  STALE_AFTER_MS
};
