'use strict';

/**
 * Regatta-Daten: Yardstick-Klassen, Bootsregistrierung, Start-/Ziellinie, Wettfahrten + Auswertung.
 * Persistenz wie im Rest der App: eine JSON-Datei, atomar geschrieben.
 */

const path = require('path');
const { customAlphabet } = require('nanoid');
const store = require('./store');
const timing = require('./timing');
const courseLib = require('./course');

const FILE = path.join(store.DATA_DIR, 'regatta.json');
const genId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 6);

const STATUS_CODES = ['DNS', 'DNF', 'DSQ', 'OCS', 'RET', 'DNC'];

/** @type {{classes: object[], boats: Record<string, object>, line: object|null, races: object[]}} */
const state = Object.assign(
  { classes: [], boats: {}, line: null, course: null, courses: [], activeCourseId: null, races: [] },
  store.loadJson(FILE, {})
);

// ---------- Kurse (Vorlagen mit Geometrie + Zaehlregeln) ----------
// Ein Kurs buendelt Linie, Bahnmarken und die Regeln, nach denen gezaehlt wird. state.line/state.course sind die Arbeitskopie des
// aktiven Kurses (der Editor bearbeitet immer den aktiven Kurs); Wettfahrten kopieren Geometrie und Regeln eines Kurses beim Anlegen.
const COURSE_KINDS = {
  loop: { lapMode: 'loop', name: 'Neuer Rundkurs', description: 'Immer in dieselbe Richtung durch die Linie (Richtung Boje 1); Start und Ziel nur zwischen den Marken.' },
  bounce: { lapMode: 'bounce', name: 'Neuer Kurs (hin und zurueck)', description: 'Linie wird je Runde zweimal gegenlaeufig gekreuzt (Start auf die Kursseite, Rundenende zurueck).' }
};
const DEFAULT_COURSE = {
  name: 'Rundkurs, Linie in der Mitte (Boje 1 oben, Boje 2 unten)',
  description: 'Durchgang immer Richtung Boje 1 zwischen Zielboot und Zielboje; Abstieg von Boje 1 zu Boje 2 ausserhalb der Linie (Verlaengerung = Runden-Anzeiger); Start und Ziel nur zwischen den Marken; 2 Runden.',
  lapMode: 'loop'
};

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    store.saveJsonAtomic(FILE, state);
  }, 300);
}

/** Ausstehende Speicherung sofort ausfuehren (beim Beenden des Servers). */
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  store.saveJsonAtomic(FILE, state);
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

function newCourse(o = {}) {
  return {
    id: genId(),
    name: String(o.name || DEFAULT_COURSE.name).trim().slice(0, 80),
    description: String(o.description || '').slice(0, 400),
    lapMode: o.lapMode === 'bounce' ? 'bounce' : 'loop',
    startOnExtension: o.startOnExtension === true,
    laps: Math.max(1, Math.min(10, parseInt(o.laps, 10) || 2)),
    minLapSeconds: Math.max(10, parseInt(o.minLapSeconds, 10) || 120),
    cutoffMinutes: Math.min(24 * 60, Math.max(10, parseInt(o.cutoffMinutes, 10) || 180)),
    line: o.line ? JSON.parse(JSON.stringify(o.line)) : null,
    course: o.course ? JSON.parse(JSON.stringify(o.course)) : null
  };
}

function courseById(id) {
  return state.courses.find((c) => c.id === id) || null;
}

function activeCourse() {
  return courseById(state.activeCourseId) || state.courses[0] || null;
}

/** Beim Laden: Altbestand (eine globale Linie/ein Kurs) in einen ersten Kurs uebernehmen; sicherstellen, dass einer aktiv ist. */
function migrateCourses() {
  if (!Array.isArray(state.courses)) state.courses = [];
  if (!state.courses.length) {
    state.courses.push(newCourse({ ...DEFAULT_COURSE, line: state.line, course: state.course }));
  }
  if (!courseById(state.activeCourseId)) state.activeCourseId = state.courses[0].id;
  const a = activeCourse();
  state.line = a.line ? JSON.parse(JSON.stringify(a.line)) : null;
  state.course = a.course ? JSON.parse(JSON.stringify(a.course)) : null;
}

function listCourses() {
  return state.courses;
}

/** Neuer Kurs: nach Typ (loop/bounce) oder als Kopie eines bestehenden Kurses (Geometrie und Regeln). Wird aktiv. */
function createCourse({ name, kind, copyFrom }) {
  let c;
  if (copyFrom) {
    const src = courseById(copyFrom);
    if (!src) throw httpError(404, 'Kurs unbekannt');
    c = newCourse({ ...src, name: name || `${src.name} (Kopie)` });
  } else {
    const k = COURSE_KINDS[kind] || COURSE_KINDS.loop;
    c = newCourse({ name: name || k.name, description: k.description, lapMode: k.lapMode });
  }
  state.courses.push(c);
  activateCourse(c.id);
  return c;
}

function updateCourse(id, patch) {
  const c = courseById(id);
  if (!c) throw httpError(404, 'Kurs unbekannt');
  if (patch.name != null) c.name = String(patch.name).trim().slice(0, 80) || c.name;
  if (patch.description != null) c.description = String(patch.description).slice(0, 400);
  if (patch.lapMode != null) c.lapMode = patch.lapMode === 'bounce' ? 'bounce' : 'loop';
  if (patch.startOnExtension != null) c.startOnExtension = patch.startOnExtension === true || patch.startOnExtension === 'true';
  if (patch.laps != null) c.laps = Math.max(1, Math.min(10, parseInt(patch.laps, 10) || c.laps));
  if (patch.minLapSeconds != null) c.minLapSeconds = Math.max(10, parseInt(patch.minLapSeconds, 10) || c.minLapSeconds);
  if (patch.cutoffMinutes != null) c.cutoffMinutes = Math.min(24 * 60, Math.max(10, parseInt(patch.cutoffMinutes, 10) || c.cutoffMinutes));
  save();
  return c;
}

/** Kurs aktivieren: Linie und Bahnmarken des Kurses werden zur Arbeitskopie (Editor), neue Wettfahrten nutzen ihn als Vorgabe. */
function activateCourse(id) {
  const c = courseById(id);
  if (!c) throw httpError(404, 'Kurs unbekannt');
  state.activeCourseId = c.id;
  state.line = c.line ? JSON.parse(JSON.stringify(c.line)) : null;
  state.course = c.course ? JSON.parse(JSON.stringify(c.course)) : null;
  save();
  return c;
}

function deleteCourse(id) {
  if (!courseById(id)) throw httpError(404, 'Kurs unbekannt');
  if (state.courses.length <= 1) throw httpError(409, 'Der letzte Kurs kann nicht geloescht werden');
  state.courses = state.courses.filter((c) => c.id !== id);
  if (state.activeCourseId === id) activateCourse(state.courses[0].id);
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
  const ac = activeCourse();
  if (ac) ac.line = JSON.parse(JSON.stringify(candidate));
  save();
  return state.line;
}

/**
 * Grobe Bojen-Strecke (in Fahrtreihenfolge fuer EINE Runde, ohne Start/Ziel-Linie). Die genauen Positionen findet das
 * System selbst aus den Logs der Boote (Wendepunkte in der Naehe der gezeichneten Punkte).
 */
function setCourse(marks, radiusM, exact) {
  if (marks === null) { state.course = null; const a0 = activeCourse(); if (a0) a0.course = null; save(); return null; }
  // Eintrag = einzelne Boje {lat, lon} oder Tor {a: {lat, lon}, b: {lat, lon}} (zwei Marken, Durchfahrt zaehlt)
  const isGate = (m) => m && isPoint(m.a) && isPoint(m.b);
  if (!Array.isArray(marks) || marks.length < 1 || marks.length > 20 || !marks.every((m) => isPoint(m) || isGate(m))) {
    throw httpError(400, 'Kurs braucht 1-20 Eintraege (Boje: lat/lon, Tor: a und b mit lat/lon)');
  }
  const r = Number.isFinite(radiusM) ? Math.min(1000, Math.max(30, radiusM)) : 250;
  // exact: Positionen sind von der Wettfahrtleitung eingegeben (genau) und werden NICHT aus den Logs verfeinert
  state.course = { marks: marks.map((m) => (isGate(m) ? { a: point(m.a), b: point(m.b) } : point(m))), radiusM: r, exact: !!exact };
  const ac = activeCourse();
  if (ac) ac.course = JSON.parse(JSON.stringify(state.course));
  save();
  return state.course;
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

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);
const parseCutoff = (v, fallback) => Math.min(24 * 60, Math.max(10, parseInt(v, 10) || fallback));

/**
 * Wettfahrt anlegen. Geometrie (Linie, Bahnmarken) und Zaehlregeln kommen vom gewaehlten Kurs (courseId, sonst der aktive Kurs);
 * explizit angegebene Werte (Runden, Zielschluss, Modus, ...) ueberschreiben die Vorgaben des Kurses.
 * Mit startTs (auch in der Vergangenheit) wird sie sofort aus den vorhandenen Aufzeichnungen gewertet.
 */
function createRace({ name, laps, minLapSeconds, cutoffMinutes, startTs, lapMode, startOnExtension, courseId }) {
  const c = (courseId && courseById(courseId)) || activeCourse() || newCourse();
  if (courseId && !courseById(courseId)) throw httpError(404, 'Kurs unbekannt');
  const pick = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v);
  const race = {
    id: genId(),
    name: String(name || `Wettfahrt ${state.races.length + 1}`).trim().slice(0, 60),
    courseId: c.id,
    courseName: c.name,
    laps: Math.max(1, Math.min(10, parseInt(pick(laps, c.laps), 10) || 2)),
    minLapSeconds: Math.max(10, parseInt(pick(minLapSeconds, c.minLapSeconds), 10) || 120),
    cutoffMinutes: parseCutoff(pick(cutoffMinutes, c.cutoffMinutes), 180),
    lapMode: pick(lapMode, c.lapMode) === 'bounce' ? 'bounce' : 'loop',
    startOnExtension: pick(startOnExtension, c.startOnExtension) === true || pick(startOnExtension, c.startOnExtension) === 'true',
    startTs: null,
    line: clone(c.line),
    course: clone(c.course),
    overrides: {},
    official: false,
    createdAt: Date.now()
  };
  if (startTs != null && startTs !== '') {
    if (!isNum(startTs)) throw httpError(400, 'startTs ungueltig');
    if (!race.line) throw httpError(400, 'Zuerst Start-/Ziellinie festlegen');
    race.startTs = startTs;
  }
  state.races.push(race);
  save();
  return race;
}

/** Zielschluss einer Wettfahrt (ms): Durchgaenge danach zaehlen nicht mehr. */
function raceEnd(race) {
  return race.startTs == null ? null : race.startTs + (race.cutoffMinutes || 180) * 60000;
}

/** Linie und Kurs der Wettfahrt auf die aktuell gespeicherten Werte setzen (fuer nachtraegliche Wettfahrten). */
function applyGeometry(id, { line = true, course = true, courseId } = {}) {
  const race = getRace(id);
  assertEditable(race);
  const c = (courseId && courseById(courseId)) || courseById(race.courseId) || activeCourse();
  if (c) { race.courseId = c.id; race.courseName = c.name; }
  if (line) race.line = clone(c ? c.line : state.line);
  if (course) race.course = clone(c ? c.course : state.course);
  save();
  return race;
}

function updateRace(id, patch) {
  const race = getRace(id);
  assertEditable(race);
  if (patch.name != null) race.name = String(patch.name).trim().slice(0, 60) || race.name;
  if (patch.laps != null) race.laps = Math.max(1, Math.min(10, parseInt(patch.laps, 10) || race.laps));
  if (patch.minLapSeconds != null) race.minLapSeconds = Math.max(10, parseInt(patch.minLapSeconds, 10) || race.minLapSeconds);
  if (patch.startOnExtension != null) race.startOnExtension = patch.startOnExtension === true || patch.startOnExtension === 'true';
  if (patch.lapMode != null) race.lapMode = patch.lapMode === 'loop' ? 'loop' : 'bounce';
  if (patch.cutoffMinutes != null) race.cutoffMinutes = parseCutoff(patch.cutoffMinutes, race.cutoffMinutes || 180);
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
  // Geometrie des Kurses dieser Wettfahrt in der aktuellen Fassung uebernehmen (Aenderungen am Kurs vor dem Start gelten)
  const src = courseById(race.courseId);
  if (src && src.line) { race.line = clone(src.line); race.course = clone(src.course); }
  if (!race.line) throw httpError(400, 'Zuerst Start-/Ziellinie festlegen');
  race.startTs = t;
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

/** Nur die Positionen im Zeitfenster der Wettfahrt (15 min vor Start bis kurz nach Zielschluss). */
function windowFixes(fixes, race) {
  const from = race.startTs - 15 * 60000;
  const to = raceEnd(race) + 5 * 60000;
  return fixes.filter((f) => f.ts >= from && f.ts <= to);
}

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
      ? timing.analyzeBoat(pl, windowFixes(store.readHistoryCached(trackerId), race), { ...race, endTs: raceEnd(race) })
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
      lapInfo: a.lapInfo || null,
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
    course: state.course,
    courses: state.courses,
    activeCourseId: state.activeCourseId,
    races: state.races.map((r) => ({
      id: r.id, name: r.name, courseId: r.courseId || null, courseName: r.courseName || null, laps: r.laps, minLapSeconds: r.minLapSeconds, cutoffMinutes: r.cutoffMinutes || 180,
      lapMode: r.lapMode || 'bounce', startOnExtension: r.startOnExtension === true, startTs: r.startTs, official: r.official, overrides: r.overrides, hasLine: !!r.line, hasCourse: !!r.course
    }))
  };
}

// ---------- Live-Rangliste ----------

const LIVE_TTL_MS = 3000;
const liveCache = new Map();

/** Laeuft die Wettfahrt gerade (Start gesetzt, noch nicht Zielschluss, nicht offiziell abgeschlossen)? */
function isRunning(race, now = Date.now()) {
  return race.startTs != null && !race.official && now < raceEnd(race);
}

function computeLive(race, now = Date.now()) {
  const boats = [];
  const from = race.startTs - 15 * 60000;
  for (const [trackerId, boat] of Object.entries(state.boats)) {
    const tracker = store.getTracker(trackerId);
    const cls = state.classes.find((c) => c.id === boat.classId);
    if (!tracker || !cls) continue;
    boats.push({
      trackerId, name: tracker.name, sailNo: boat.sailNo, helm: boat.helm, className: cls.name, yardstick: cls.yardstick,
      color: tracker.color,
      fixes: store.readHistoryCached(trackerId).filter((f) => f.ts >= from && f.ts <= now)
    });
  }
  const ranking = courseLib.liveRanking({
    line: race.line,
    race: { startTs: race.startTs, laps: race.laps, minLapSeconds: race.minLapSeconds, endTs: raceEnd(race), lapMode: race.lapMode || 'bounce', startOnExtension: race.startOnExtension === true },
    approxMarks: race.course ? race.course.marks : [],
    boats,
    now,
    options: race.course ? { radiusM: race.course.radiusM || 250, exact: !!race.course.exact } : {}
  });
  const colors = Object.fromEntries(boats.map((b) => [b.trackerId, b.color]));
  ranking.entries.forEach((e) => { e.color = colors[e.trackerId]; });
  return {
    race: { id: race.id, name: race.name, laps: race.laps, startTs: race.startTs, official: race.official, running: isRunning(race, now) },
    ...ranking
  };
}

/** Wie computeLive, aber hoechstens alle LIVE_TTL_MS neu berechnet (viele Zuschauer, gleiche Daten). */
function getLive(id, now = Date.now()) {
  const race = getRace(id);
  if (race.startTs == null) throw httpError(400, 'Wettfahrt hat keinen Start');
  const c = liveCache.get(id);
  if (c && now - c.at < LIVE_TTL_MS) return c.data;
  const data = computeLive(race, now);
  liveCache.set(id, { at: now, data });
  return data;
}

function runningRaces(now = Date.now()) {
  return state.races.filter((r) => isRunning(r, now));
}

// ---------- Export ----------

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw httpError(400, `Zeit ungueltig: ${v}`);
  return n;
}

/** Aufzeichnungen fuer den Export waehlen: ganze Historie, Zeitfenster (from/to) oder eine Wettfahrt (race). */
function exportSelection({ race, from, to, trackers }) {
  let f = parseTime(from);
  let t = parseTime(to);
  let waypoints = [];
  let name = 'Regatta';
  const src = state.line || state.course ? { line: state.line, course: state.course } : { line: null, course: null };
  let geo = src;
  if (race) {
    const r = getRace(race);
    if (r.startTs == null) throw httpError(400, 'Wettfahrt hat keinen Start');
    f = r.startTs - 10 * 60000;
    t = raceEnd(r) + 10 * 60000;
    name = r.name;
    geo = { line: r.line, course: r.course };
  }
  if (geo.line) {
    waypoints.push({ lat: geo.line.a.lat, lon: geo.line.a.lon, name: 'Linie A' }, { lat: geo.line.b.lat, lon: geo.line.b.lon, name: 'Linie B' });
  }
  if (geo.course) {
    geo.course.marks.forEach((m, i) => {
      if (m.a) waypoints.push({ lat: m.a.lat, lon: m.a.lon, name: `Tor ${i + 1} A` }, { lat: m.b.lat, lon: m.b.lon, name: `Tor ${i + 1} B` });
      else waypoints.push({ lat: m.lat, lon: m.lon, name: `Boje ${i + 1}${geo.course.exact ? '' : ' (grob)'}` });
    });
  }
  const ids = trackers ? String(trackers).split(',').filter(Boolean) : store.listTrackers().map((x) => x.id);
  const entries = [];
  for (const id of ids) {
    const tr = store.getTracker(id);
    if (!tr) continue;
    const boat = state.boats[id];
    const cls = boat && state.classes.find((c) => c.id === boat.classId);
    entries.push({
      tracker: { id: tr.id, name: tr.name, loraId: tr.loraId ?? null },
      boat: boat ? { sailNo: boat.sailNo, helm: boat.helm, className: cls ? cls.name : '' } : null,
      fixes: store.readHistoryCached(id)
    });
  }
  return { entries, from: f, to: t, name, waypoints };
}

migrateCourses();

module.exports = {
  listCourses, createCourse, updateCourse, activateCourse, deleteCourse, courseById, activeCourse,
  exportSelection, computeLive, getLive, isRunning, runningRaces,
  flush, state, STATUS_CODES, httpError, publicState,
  setCourse, applyGeometry, raceEnd, windowFixes,
  addClass, importClasses, deleteClass, registerBoat, unregisterBoat, setLine,
  getRace, createRace, updateRace, deleteRace, startRace, clearStart, setOverride, setOfficial,
  computeResults, toCsv
};
