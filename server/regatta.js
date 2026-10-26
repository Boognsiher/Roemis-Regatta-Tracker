'use strict';

/**
 * Regatta-Daten: Yardstick-Klassen, Bootsregistrierung, Start-/Ziellinie, Wettfahrten + Auswertung.
 * Persistenz wie im Rest der App: eine JSON-Datei, atomar geschrieben.
 */

const path = require('path');
const { customAlphabet } = require('nanoid');
const store = require('./store');
const timing = require('./timing');

const FILE = path.join(store.DATA_DIR, 'regatta.json');
const genId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 6);

const STATUS_CODES = ['DNS', 'DNF', 'DSQ', 'OCS', 'RET', 'DNC'];

/** @type {{classes: object[], boats: Record<string, object>, line: object|null, races: object[]}} */
const state = Object.assign(
  { classes: [], boats: {}, line: null, races: [] },
  store.loadJson(FILE, {})
);

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    store.saveJsonAtomic(FILE, state);
  }, 300);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isPoint = (p) => p && isNum(p.lat) && isNum(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
const point = (p) => ({ lat: p.lat, lon: p.lon });

// ---------- Yardstick-Klassen ----------

function addClass(name, yardstick) {
  const ys = Number(yardstick);
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'Klassenname fehlt');
  if (!(ys >= 30 && ys <= 400)) throw httpError(400, 'Yardstick-Zahl ungueltig (30-400)');
  const existing = state.classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.yardstick = ys;
    save();
    return existing;
  }
  const c = { id: genId(), name, yardstick: ys };
  state.classes.push(c);
  state.classes.sort((x, y) => x.name.localeCompare(y.name, 'de'));
  save();
  return c;
}

/** Liest eine Yardstick-Liste als Text: je Zeile "Name;Zahl" (auch Komma/Tab, Header werden ignoriert). */
function importClasses(text, replace) {
  if (replace) {
    // Klassen, die noch von Booten verwendet werden, bleiben erhalten.
    const used = new Set(Object.values(state.boats).map((b) => b.classId));
    state.classes = state.classes.filter((c) => used.has(c.id));
  }
  let added = 0;
  const skipped = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[;\t,]\s*"?(\d+(?:[.,]\d+)?)"?\s*$/);
    if (!m) { skipped.push(line); continue; }
    try {
      addClass(m[1].replace(/^"|"$/g, ''), m[2].replace(',', '.'));
      added += 1;
    } catch {
      skipped.push(line);
    }
  }
  return { added, skipped };
}

function deleteClass(id) {
  if (Object.values(state.boats).some((b) => b.classId === id)) {
    throw httpError(409, 'Klasse wird noch von einem Boot verwendet');
  }
  const before = state.classes.length;
  state.classes = state.classes.filter((c) => c.id !== id);
  if (state.classes.length === before) throw httpError(404, 'Klasse unbekannt');
  save();
}

// ---------- Boote ----------

function registerBoat(trackerId, { sailNo, helm, classId }) {
  if (!store.getTracker(trackerId)) throw httpError(404, 'Tracker unbekannt');
  if (!state.classes.some((c) => c.id === classId)) throw httpError(400, 'Klasse unbekannt');
  state.boats[trackerId] = {
    sailNo: String(sailNo || '').trim().slice(0, 20),
    helm: String(helm || '').trim().slice(0, 60),
    classId
  };
  save();
  return state.boats[trackerId];
}

function unregisterBoat(trackerId) {
  delete state.boats[trackerId];
  save();
}

// ---------- Linie ----------

function setLine(line) {
  if (!line || !isPoint(line.a) || !isPoint(line.b) || !isPoint(line.mark)) {
    throw httpError(400, 'Linie braucht a, b und mark (je lat/lon)');
  }
  const candidate = { a: point(line.a), b: point(line.b), mark: point(line.mark) };
  if (!timing.prepareLine(candidate)) throw httpError(400, 'Linie ungueltig (zu kurz oder Referenzpunkt auf der Linie)');
  state.line = candidate;
  save();
  return state.line;
}

// ---------- Wettfahrten ----------

function getRace(id) {
  const r = state.races.find((x) => x.id === id);
  if (!r) throw httpError(404, 'Wettfahrt unbekannt');
  return r;
}

function assertEditable(race) {
  if (race.official) throw httpError(409, 'Wettfahrt ist offiziell freigegeben - erst zuruecknehmen');
}

function createRace({ name, laps, minLapSeconds }) {
  const race = {
    id: genId(),
    name: String(name || `Wettfahrt ${state.races.length + 1}`).trim().slice(0, 60),
    laps: Math.max(1, Math.min(10, parseInt(laps, 10) || 2)),
    minLapSeconds: Math.max(10, parseInt(minLapSeconds, 10) || 120),
    startTs: null,
    line: state.line ? JSON.parse(JSON.stringify(state.line)) : null,
    overrides: {},
    official: false,
    createdAt: Date.now()
  };
  state.races.push(race);
  save();
  return race;
}

function updateRace(id, patch) {
  const race = getRace(id);
  assertEditable(race);
  if (patch.name != null) race.name = String(patch.name).trim().slice(0, 60) || race.name;
  if (patch.laps != null) race.laps = Math.max(1, Math.min(10, parseInt(patch.laps, 10) || race.laps));
  if (patch.minLapSeconds != null) race.minLapSeconds = Math.max(10, parseInt(patch.minLapSeconds, 10) || race.minLapSeconds);
  save();
  return race;
}

function deleteRace(id) {
  const race = getRace(id);
  assertEditable(race);
  state.races = state.races.filter((r) => r.id !== id);
  save();
}

/** Startsignal setzen (ts in ms, Standard: jetzt). Uebernimmt die aktuelle Linie. */
function startRace(id, ts) {
  const race = getRace(id);
  assertEditable(race);
  const t = isNum(ts) ? ts : Date.now();
  if (!state.line) throw httpError(400, 'Zuerst Start-/Ziellinie festlegen');
  race.startTs = t;
  race.line = JSON.parse(JSON.stringify(state.line));
  save();
  return race;
}

function clearStart(id) {
  const race = getRace(id);
  assertEditable(race);
  race.startTs = null;
  save();
  return race;
}

/** Manuelle Korrektur durch die Wettfahrtleitung: Status, Zielzeit, Zeitstrafe, Bemerkung. */
function setOverride(raceId, trackerId, o) {
  const race = getRace(raceId);
  assertEditable(race);
  if (!store.getTracker(trackerId)) throw httpError(404, 'Tracker unbekannt');
  const ov = {};
  if (o.status) {
    if (!STATUS_CODES.includes(o.status)) throw httpError(400, 'Statuscode ungueltig');
    ov.status = o.status;
  }
  if (o.finishTs != null && o.finishTs !== '') {
    if (!isNum(o.finishTs)) throw httpError(400, 'finishTs ungueltig');
    ov.finishTs = o.finishTs;
  }
  if (o.penaltySec) {
    if (!isNum(o.penaltySec) || o.penaltySec < 0) throw httpError(400, 'Zeitstrafe ungueltig');
    ov.penaltySec = o.penaltySec;
  }
  if (o.note) ov.note = String(o.note).slice(0, 200);
  if (Object.keys(ov).length) race.overrides[trackerId] = ov;
  else delete race.overrides[trackerId];
  save();
  return race;
}

function setOfficial(id, official) {
  const race = getRace(id);
  if (official && race.startTs == null) throw httpError(400, 'Wettfahrt hat keinen Start');
  race.official = !!official;
  race.officialAt = official ? Date.now() : null;
  save();
  return race;
}

// ---------- Auswertung ----------

function computeResults(race) {
  const base = {
    race: {
      id: race.id, name: race.name, laps: race.laps, startTs: race.startTs,
      official: race.official, officialAt: race.officialAt || null
    },
    entries: []
  };
  if (race.startTs == null) return base;

  const pl = timing.prepareLine(race.line);
  const entries = [];
  for (const [trackerId, boat] of Object.entries(state.boats)) {
    const tracker = store.getTracker(trackerId);
    const cls = state.classes.find((c) => c.id === boat.classId);
    if (!tracker || !cls) continue;
    const ov = race.overrides[trackerId] || {};

    const a = pl
      ? timing.analyzeBoat(pl, store.readHistory(trackerId), race)
      : { status: 'DNS', laps: [], finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: ['Keine Linie definiert'] };

    let { status, finishTs, elapsedSec } = a;
    const warnings = a.warnings.slice();
    if (ov.finishTs != null) {
      finishTs = ov.finishTs;
      elapsedSec = (finishTs - race.startTs) / 1000;
      status = 'FIN';
      warnings.push('Zielzeit manuell gesetzt');
    }
    if (ov.status) status = ov.status;

    let correctedSec = null;
    if (status === 'FIN' && elapsedSec != null) {
      correctedSec = timing.correctedSeconds(elapsedSec, cls.yardstick) + (ov.penaltySec || 0);
    }
    entries.push({
      trackerId,
      name: tracker.name,
      color: tracker.color,
      sailNo: boat.sailNo,
      helm: boat.helm,
      className: cls.name,
      yardstick: cls.yardstick,
      status,
      laps: a.laps.map((l) => ({ n: l.n, ts: l.ts, lapSeconds: l.lapSeconds })),
      finishTs,
      elapsedSec,
      correctedSec,
      penaltySec: ov.penaltySec || 0,
      uncertaintyMs: ov.finishTs != null ? null : a.uncertaintyMs,
      note: ov.note || '',
      warnings
    });
  }
  timing.rankEntries(entries);
  const order = (e) => (e.rank != null ? e.rank : 1e6);
  entries.sort((x, y) => order(x) - order(y) || x.name.localeCompare(y.name, 'de'));
  base.entries = entries;
  return base;
}

function toCsv(results) {
  const fmt = (s) => {
    if (s == null) return '';
    const t = Math.round(s);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Rang', 'Segelnr', 'Boot', 'Steuermann', 'Klasse', 'YS', 'Status', 'Gesegelte Zeit', 'Berechnete Zeit', 'Bemerkung']];
  for (const e of results.entries) {
    rows.push([e.rank ?? '', e.sailNo, e.name, e.helm, e.className, e.yardstick, e.status,
      fmt(e.elapsedSec), fmt(e.correctedSec), e.note]);
  }
  return '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n') + '\r\n';
}

function publicState() {
  return {
    classes: state.classes,
    boats: state.boats,
    line: state.line,
    races: state.races.map((r) => ({
      id: r.id, name: r.name, laps: r.laps, minLapSeconds: r.minLapSeconds, startTs: r.startTs,
      official: r.official, overrides: r.overrides
    }))
  };
}

module.exports = {
  state, STATUS_CODES, httpError, publicState,
  addClass, importClasses, deleteClass, registerBoat, unregisterBoat, setLine,
  getRace, createRace, updateRace, deleteRace, startRace, clearStart, setOverride, setOfficial,
  computeResults, toCsv
};
