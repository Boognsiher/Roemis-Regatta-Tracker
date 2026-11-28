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
const autostart = require('./autostart');
const quality = require('./quality');

const FILE = path.join(store.DATA_DIR, 'regatta.json');
const genId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 6);

const STATUS_CODES = ['DNS', 'DNF', 'DSQ', 'OCS', 'RET', 'DNC'];

/** @type {{classes: object[], boats: Record<string, object>, line: object|null, races: object[]}} */
const state = Object.assign(
  { classes: [], boats: {}, line: null, finishLine: null, course: null, courses: [], activeCourseId: null, liveCourseId: null, races: [] },
  store.loadJson(FILE, {})
);

// ---------- Kurse (Vorlagen mit Geometrie + Zaehlregeln) ----------
// Ein Kurs buendelt Linie, Bahnmarken und die Regeln, nach denen gezaehlt wird. state.line/state.course sind die Arbeitskopie des
// aktiven Kurses (der Editor bearbeitet immer den aktiven Kurs); Wettfahrten kopieren Geometrie und Regeln eines Kurses beim Anlegen.
const COURSE_KINDS = {
  loop: { lapMode: 'loop', name: 'Neuer Rundkurs', description: 'Immer in dieselbe Richtung durch die Linie (Richtung Boje 1); Start und Ziel nur zwischen den Marken.' },
  bounce: { lapMode: 'bounce', name: 'Neuer Kurs (hin und zurueck)', description: 'Linie wird je Runde zweimal gegenlaeufig gekreuzt (Start auf die Kursseite, Rundenende zurueck).' },
  distance: { lapMode: 'distance', name: 'Neue Langstrecke (Start, Bojen, Ziel)', description: 'Eine Wertung von Start bis Ziel, keine Runden: Start-Linie, Bojen der Reihe nach, Ziel (eigene Ziellinie oder dieselbe Linie zurueck). Die Bojen werden geprueft und fehlende gemeldet.' }
};

/** Zaehlmodus normalisieren: 'loop' (Rundkurs), 'bounce' (hin und zurueck) oder 'distance' (Langstrecke Start - Bojen - Ziel). */
const normLapMode = (v) => (v === 'bounce' ? 'bounce' : v === 'distance' ? 'distance' : 'loop');
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
    lapMode: normLapMode(o.lapMode),
    startOnExtension: o.startOnExtension === true,
    laps: normLapMode(o.lapMode) === 'distance' ? 1 : Math.max(1, Math.min(10, parseInt(o.laps, 10) || 2)),
    minLapSeconds: Math.max(10, parseInt(o.minLapSeconds, 10) || 120),
    cutoffMinutes: Math.min(24 * 60, Math.max(10, parseInt(o.cutoffMinutes, 10) || 180)),
    line: o.line ? JSON.parse(JSON.stringify(o.line)) : null,
    finishLine: o.finishLine ? JSON.parse(JSON.stringify(o.finishLine)) : null,
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
  state.finishLine = a.finishLine ? JSON.parse(JSON.stringify(a.finishLine)) : null;
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

/** Kurs als Datei (JSON) zum Wiederverwenden: enthaelt Regeln und die komplette Geometrie (Linie, Ziellinie, Bojen mit Umrundungsseite). */
function exportCourse(id) {
  const c = courseById(id);
  if (!c) throw httpError(404, 'Kurs unbekannt');
  const { name, description, lapMode, laps, minLapSeconds, cutoffMinutes, startOnExtension, line, finishLine, course } = c;
  return { format: 'regattazeit-kurs', version: 1, exportedAt: new Date().toISOString(), course: { name, description, lapMode, laps, minLapSeconds, cutoffMinutes, startOnExtension, line, finishLine, course } };
}

/** Kurs aus einer Export-Datei als NEUEN Kurs anlegen (wird aktiv). Geometrie wird wie bei der Eingabe geprueft. */
function importCourse(data) {
  const isGate = (m) => m && isPoint(m.a) && isPoint(m.b);
  const withRounding = (m) => (m.rounding === 'port' || m.rounding === 'starboard' ? { ...point(m), rounding: m.rounding } : point(m));
  const src = data && data.format === 'regattazeit-kurs' && data.course;
  if (!src || typeof src !== 'object') throw httpError(400, 'Keine gueltige Kurs-Datei (erwartet: Export aus "Kurs exportieren")');
  if (src.line && !(isPoint(src.line.a) && isPoint(src.line.b) && isPoint(src.line.mark))) throw httpError(400, 'Linie in der Datei ungueltig');
  const c = newCourse({ ...src, name: `${src.name || 'Importierter Kurs'}` });
  if (c.line) c.line = { a: point(c.line.a), b: point(c.line.b), mark: point(c.line.mark) };
  if (c.finishLine && !(isPoint(c.finishLine.a) && isPoint(c.finishLine.b))) c.finishLine = null;
  if (c.course) {
    const marks = Array.isArray(c.course.marks) ? c.course.marks : [];
    if (marks.some((m) => !(isGate(m) || isPoint(m)))) throw httpError(400, 'Bojen in der Datei ungueltig');
    c.course = { marks: marks.map((m) => (isGate(m) ? { a: point(m.a), b: point(m.b) } : withRounding(m))), radiusM: Number(c.course.radiusM) || 250, exact: !!c.course.exact };
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
  if (patch.lapMode != null) { c.lapMode = normLapMode(patch.lapMode); if (c.lapMode === 'distance') c.laps = 1; }
  if (patch.startOnExtension != null) c.startOnExtension = patch.startOnExtension === true || patch.startOnExtension === 'true';
  if (patch.laps != null && c.lapMode !== 'distance') c.laps = Math.max(1, Math.min(10, parseInt(patch.laps, 10) || c.laps));
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
  state.finishLine = c.finishLine ? JSON.parse(JSON.stringify(c.finishLine)) : null;
  state.course = c.course ? JSON.parse(JSON.stringify(c.course)) : null;
  save();
  return c;
}

function deleteCourse(id) {
  if (!courseById(id)) throw httpError(404, 'Kurs unbekannt');
  if (state.courses.length <= 1) throw httpError(409, 'Der letzte Kurs kann nicht geloescht werden');
  state.courses = state.courses.filter((c) => c.id !== id);
  if (state.activeCourseId === id) activateCourse(state.courses[0].id);
  if (state.liveCourseId === id) state.liveCourseId = null;
  save();
}

/**
 * Kurs auf der oeffentlichen Live-Karte aufschalten (courseId) oder abschalten (null). Unabhaengig vom Kurs, den die Wettfahrtleitung gerade bearbeitet
 * (aktiver Kurs): auf der Live-Karte erscheint nur, was die Wettfahrtleitung aufgeschaltet hat; Aenderungen am aufgeschalteten Kurs sind sofort sichtbar.
 */
function setLiveCourse(courseId) {
  if (courseId === null || courseId === undefined || courseId === '') { state.liveCourseId = null; save(); return null; }
  const c = courseById(courseId);
  if (!c) throw httpError(404, 'Kurs unbekannt');
  state.liveCourseId = c.id;
  save();
  return c;
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
 * Ziellinie fuer die Langstrecke (eigene Linie, getrennt vom Start): { a, b, mark? } oder null (= Ziel ueber die Start-Linie). Die Referenz "mark" legt die
 * Kursseite fest (Seite, von der die Boote kommen); ohne Angabe gilt die LETZTE Boje des Kurses (siehe resolveFinishLine).
 */
function setFinishLine(line) {
  const ac = activeCourse();
  if (line === null) {
    state.finishLine = null;
    if (ac) ac.finishLine = null;
    save();
    return null;
  }
  if (!line || !isPoint(line.a) || !isPoint(line.b) || (line.mark != null && !isPoint(line.mark))) {
    throw httpError(400, 'Ziellinie braucht a und b (je lat/lon), optional mark');
  }
  const candidate = { a: point(line.a), b: point(line.b) };
  if (line.mark != null) candidate.mark = point(line.mark);
  const pj = timing.makeProjector((candidate.a.lat + candidate.b.lat) / 2, (candidate.a.lon + candidate.b.lon) / 2);
  const pa = pj(candidate.a);
  const pb = pj(candidate.b);
  if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < 1) throw httpError(400, 'Ziellinie zu kurz (weniger als 1 m)');
  if (candidate.mark && !timing.prepareLine(candidate)) throw httpError(400, 'Ziellinie ungueltig (Referenzpunkt liegt auf der Linie)');
  state.finishLine = candidate;
  if (ac) ac.finishLine = JSON.parse(JSON.stringify(candidate));
  save();
  return state.finishLine;
}

/**
 * Ziellinie einer Wettfahrt mit Referenzpunkt (fuer timing.prepareLine): eingegebene Referenz, sonst die letzte Boje des Kurses (bei einem Tor deren Mitte).
 * Rueckgabe: Linie | null (keine eigene Ziellinie) | undefined (Ziellinie vorhanden, aber ohne Referenz und ohne Kurs-Bojen).
 */
function resolveFinishLine(race) {
  const f = race && race.finishLine;
  if (!f) return null;
  if (f.mark) return f;
  const marks = race.course && race.course.marks;
  if (!marks || !marks.length) return undefined;
  const last = marks[marks.length - 1];
  const mark = last.a && last.b ? { lat: (last.a.lat + last.b.lat) / 2, lon: (last.a.lon + last.b.lon) / 2 } : last;
  const line = { a: f.a, b: f.b, mark };
  return timing.prepareLine(line) ? line : undefined;
}

/**
 * Grobe Bojen-Strecke (in Fahrtreihenfolge fuer EINE Runde, ohne Start/Ziel-Linie). Die genauen Positionen findet das
 * System selbst aus den Logs der Boote (Wendepunkte in der Naehe der gezeichneten Punkte).
 */
const DEFAULT_RADIUS_M = 250;         // Standard-Suchradius (Rundkurs/Hin-und-zurueck)
const LONG_COURSE_RADIUS_M = 400;     // Langstrecke: man faehrt nicht so nah an die Boje; der alte Standardwert 250 wird dort als 400 gewertet
/** Wirksamer Radius der Bojenpruefung. Langstrecke: Standardwert 250 -> 400 m; jeder andere eingegebene Wert gilt unveraendert. */
function markRadius(race) {
  const r = (race.course && race.course.radiusM) || DEFAULT_RADIUS_M;
  return race.lapMode === 'distance' && r === DEFAULT_RADIUS_M ? LONG_COURSE_RADIUS_M : r;
}

function setCourse(marks, radiusM, exact) {
  if (marks === null) { state.course = null; const a0 = activeCourse(); if (a0) a0.course = null; save(); return null; }
  // Eintrag = einzelne Boje {lat, lon} oder Tor {a: {lat, lon}, b: {lat, lon}} (zwei Marken, Durchfahrt zaehlt)
  const isGate = (m) => m && isPoint(m.a) && isPoint(m.b);
  if (!Array.isArray(marks) || marks.length < 1 || marks.length > 20 || !marks.every((m) => isPoint(m) || isGate(m))) {
    throw httpError(400, 'Kurs braucht 1-20 Eintraege (Boje: lat/lon, Tor: a und b mit lat/lon)');
  }
  const r = Number.isFinite(radiusM) ? Math.min(1000, Math.max(30, radiusM)) : 250;
  // exact: Positionen sind von der Wettfahrtleitung eingegeben (genau) und werden NICHT aus den Logs verfeinert
  // Einzelne Bojen koennen eine Umrundungsrichtung tragen: 'port' = Boje an Backbord lassen (gegen den Uhrzeigersinn), 'starboard' = an Steuerbord (im Uhrzeigersinn)
  const withRounding = (m) => (m.rounding === 'port' || m.rounding === 'starboard' ? { ...point(m), rounding: m.rounding } : point(m));
  state.course = { marks: marks.map((m) => (isGate(m) ? { a: point(m.a), b: point(m.b) } : withRounding(m))), radiusM: r, exact: !!exact };
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
function createRace({ name, laps, minLapSeconds, cutoffMinutes, startTs, lapMode, startOnExtension, courseId, auto, autoFrom, autoTo }) {
  const c = (courseId && courseById(courseId)) || activeCourse() || newCourse();
  if (courseId && !courseById(courseId)) throw httpError(404, 'Kurs unbekannt');
  const pick = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v);
  const race = {
    id: genId(),
    name: String(name || `Wettfahrt ${state.races.length + 1}`).trim().slice(0, 60),
    courseId: c.id,
    courseName: c.name,
    laps: normLapMode(pick(lapMode, c.lapMode)) === 'distance' ? 1 : Math.max(1, Math.min(10, parseInt(pick(laps, c.laps), 10) || 2)),
    minLapSeconds: Math.max(10, parseInt(pick(minLapSeconds, c.minLapSeconds), 10) || 120),
    cutoffMinutes: parseCutoff(pick(cutoffMinutes, c.cutoffMinutes), 180),
    lapMode: normLapMode(pick(lapMode, c.lapMode)),
    startOnExtension: pick(startOnExtension, c.startOnExtension) === true || pick(startOnExtension, c.startOnExtension) === 'true',
    startTs: null,
    auto: auto === true || auto === 'true',
    autoFrom: isNum(autoFrom) ? autoFrom : Date.now(),   // ab wann Positionen fuer die Start-Erkennung zaehlen
    autoTo: isNum(autoTo) ? autoTo : null,                 // bis wann (null = laufend); in der Vergangenheit = nachtraegliche Auswertung
    classStarts: {},                                       // automatisch erkannte Startzeiten je Klasse { classId: { ts, final, boats, early } }
    classEnds: {},                                         // automatisch erkanntes Ende je Klasse { classId: { ts, reason } }
    line: clone(c.line),
    finishLine: clone(c.finishLine),
    course: clone(c.course),
    overrides: {},
    official: false,
    createdAt: Date.now()
  };
  if (!race.auto && startTs != null && startTs !== '') {
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
  if (race.auto) {
    const ends = Object.values(race.classStarts || {}).map((s) => s.ts + (race.cutoffMinutes || 180) * 60000);
    return ends.length ? Math.max(...ends) : null;
  }
  return race.startTs == null ? null : race.startTs + (race.cutoffMinutes || 180) * 60000;
}

/** Startzeit einer Klasse (ms): bei automatischer Erkennung die erkannte Klassen-Startzeit, sonst der gemeinsame Start. */
function classStart(race, classId) {
  if (race.auto) { const s = (race.classStarts || {})[classId]; return s ? s.ts : null; }
  return race.startTs;
}
const classCutoffTs = (race, start) => start + (race.cutoffMinutes || 180) * 60000;

/** Boote (trackerId -> classId) der Wettfahrt, nur mit gueltiger Klasse und bekanntem Tracker. */
function raceBoats() {
  return Object.entries(state.boats).filter(([id, b]) => store.getTracker(id) && state.classes.some((c) => c.id === b.classId)).map(([id, b]) => ({ trackerId: id, classId: b.classId }));
}

/**
 * Automatische Start-Erkennung aktualisieren (nur Wettfahrten mit auto=true). Endgueltig erkannte Starts (final) bleiben stehen.
 * race.startTs wird auf den fruehesten Klassenstart gesetzt, damit die uebrige Oberflaeche (Anzeige "gestartet") unveraendert funktioniert.
 */
function refreshAuto(race, now = Date.now()) {
  if (!race.auto || race.official) return;
  const pl = timing.prepareLine(race.line);
  if (!pl) return;
  race.classStarts = race.classStarts || {};
  const upTo = Math.min(now, race.autoTo != null ? race.autoTo : now);
  const complete = race.autoTo != null && now >= race.autoTo;
  const boats = raceBoats();
  let changed = false;
  for (const cls of state.classes) {
    const cur = race.classStarts[cls.id];
    if (cur && cur.final) continue;
    const cands = {};
    for (const b of boats.filter((x) => x.classId === cls.id)) {
      const fixes = store.readHistoryCached(b.trackerId).filter((f) => f.ts >= race.autoFrom && f.ts <= upTo);
      cands[b.trackerId] = autostart.boatStartCandidates(pl, fixes, { minLapSeconds: race.minLapSeconds, startExtensionM: race.startOnExtension ? 400 : 0 });
    }
    const det = autostart.detectClassStart(cands, upTo, { complete, minLapSeconds: race.minLapSeconds });
    if (det.ts == null) {
      if (cur) { delete race.classStarts[cls.id]; changed = true; }
      continue;
    }
    const next = { ts: det.ts, final: det.final, boats: det.boats, early: det.early };
    if (JSON.stringify(cur) !== JSON.stringify(next)) { race.classStarts[cls.id] = next; changed = true; }
  }
  const starts = Object.values(race.classStarts).map((s) => s.ts);
  const first = starts.length ? Math.min(...starts) : null;
  if (race.startTs !== first) { race.startTs = first; changed = true; }
  if (changed) { save(); liveCache.delete(race.id); }
}

/**
 * Ende je Klasse festhalten: alle gestarteten Boote im Ziel (Zeit des letzten) oder Zielschluss erreicht.
 * meta: [{ classId, started, status, finishTs }] aus der Auswertung.
 */
function refreshEnds(race, meta, now = Date.now()) {
  if (!race.auto || race.official) return;
  race.classEnds = race.classEnds || {};
  let changed = false;
  for (const cls of state.classes) {
    const cs = (race.classStarts || {})[cls.id];
    if (!cs || !cs.final || race.classEnds[cls.id]) continue;
    const mine = meta.filter((m) => m.classId === cls.id && m.started);
    let end = null;
    if (now >= classCutoffTs(race, cs.ts)) end = { ts: classCutoffTs(race, cs.ts), reason: 'Zielschluss' };
    else if (mine.length && mine.every((m) => m.status === 'FIN' && m.finishTs != null)) end = { ts: Math.max(...mine.map((m) => m.finishTs)), reason: 'alle im Ziel' };
    if (end) { race.classEnds[cls.id] = end; changed = true; }
  }
  if (changed) { save(); liveCache.delete(race.id); }
}

/** Phase einer Klasse: WAIT (kein Start erkannt), STARTING (Start erkannt, noch nicht endgueltig), RACING, DONE. */
/**
 * Regelmaessig aufrufen (index.js): wertet automatische Wettfahrten aus, damit Start und Ende auch ohne Zuschauer erkannt werden
 * (die Wettfahrt erscheint dann von selbst als gestartet bzw. beendet). Nur bis 24 h nach Scharfstellung und nur solange nicht alle Klassen beendet sind.
 */
function tickAuto(now = Date.now()) {
  for (const race of state.races) {
    if (!race.auto || race.official || !race.line) continue;
    if (now > (race.autoFrom || 0) + 24 * 3600000) continue;
    const cls = state.classes.filter((c) => raceBoats().some((b) => b.classId === c.id));
    if (cls.length && cls.every((c) => (race.classEnds || {})[c.id])) continue;
    computeResults(race, now);
  }
}

function classPhase(race, classId) {
  const cs = (race.classStarts || {})[classId];
  if (!cs) return 'WAIT';
  if ((race.classEnds || {})[classId]) return 'DONE';
  return cs.final ? 'RACING' : 'STARTING';
}

function autoClasses(race) {
  return state.classes.filter((c) => raceBoats().some((b) => b.classId === c.id)).map((c) => {
    const cs = (race.classStarts || {})[c.id] || null;
    const ce = (race.classEnds || {})[c.id] || null;
    return { classId: c.id, name: c.name, phase: classPhase(race, c.id), startTs: cs ? cs.ts : null, startFinal: !!(cs && cs.final), startBoats: cs ? cs.boats.length : 0, early: cs ? cs.early.length : 0, endTs: ce ? ce.ts : null, endReason: ce ? ce.reason : null };
  });
}

/** Linie und Kurs der Wettfahrt auf die aktuell gespeicherten Werte setzen (fuer nachtraegliche Wettfahrten). */
function applyGeometry(id, { line = true, course = true, courseId } = {}) {
  const race = getRace(id);
  assertEditable(race);
  const c = (courseId && courseById(courseId)) || courseById(race.courseId) || activeCourse();
  if (c) { race.courseId = c.id; race.courseName = c.name; }
  if (line) { race.line = clone(c ? c.line : state.line); race.finishLine = clone(c ? c.finishLine : state.finishLine); }
  if (course) race.course = clone(c ? c.course : state.course);
  save();
  return race;
}

function updateRace(id, patch) {
  const race = getRace(id);
  assertEditable(race);
  if (patch.name != null) race.name = String(patch.name).trim().slice(0, 60) || race.name;
  if (patch.laps != null && race.lapMode !== 'distance') race.laps = Math.max(1, Math.min(10, parseInt(patch.laps, 10) || race.laps));
  if (patch.minLapSeconds != null) race.minLapSeconds = Math.max(10, parseInt(patch.minLapSeconds, 10) || race.minLapSeconds);
  if (patch.startOnExtension != null) race.startOnExtension = patch.startOnExtension === true || patch.startOnExtension === 'true';
  if (patch.lapMode != null) { race.lapMode = normLapMode(patch.lapMode); if (race.lapMode === 'distance') race.laps = 1; }
  if (patch.auto != null) { race.auto = patch.auto === true || patch.auto === 'true'; if (race.auto) { race.classStarts = {}; race.classEnds = {}; race.startTs = null; race.autoFrom = isNum(patch.autoFrom) ? patch.autoFrom : Date.now(); } }
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
  race.auto = false;                           // manueller Start gilt fuer alle Klassen und ersetzt die automatische Erkennung
  race.startTs = t;
  save();
  return race;
}

function clearStart(id) {
  const race = getRace(id);
  assertEditable(race);
  race.startTs = null;
  race.classStarts = {};
  race.classEnds = {};
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
function windowFixes(fixes, race, start = race.startTs) {
  const from = start - 15 * 60000;
  const to = classCutoffTs(race, start) + 5 * 60000;
  return fixes.filter((f) => f.ts >= from && f.ts <= to);
}

function computeResults(race, now = Date.now()) {
  refreshAuto(race, now);
  const base = {
    race: {
      id: race.id, name: race.name, laps: race.laps, startTs: race.startTs,
      official: race.official, officialAt: race.officialAt || null, auto: !!race.auto, classes: race.auto ? autoClasses(race) : []
    },
    entries: []
  };
  if (race.startTs == null) return base;

  const pl = timing.prepareLine(race.line);
  const distance = race.lapMode === 'distance';
  const finishLine = distance ? resolveFinishLine(race) : null;          // null = Ziel ueber die Start-Linie, undefined = Ziellinie ohne Referenz
  const finishPl = finishLine ? timing.prepareLine(finishLine) : null;
  const entries = [];
  const meta = [];
  for (const [trackerId, boat] of Object.entries(state.boats)) {
    const tracker = store.getTracker(trackerId);
    const cls = state.classes.find((c) => c.id === boat.classId);
    if (!tracker || !cls) continue;
    const ov = race.overrides[trackerId] || {};
    const cStart = classStart(race, cls.id);                       // Startzeit dieser Klasse (null = Klasse noch nicht gestartet)
    const cEnd = cStart == null ? null : classCutoffTs(race, cStart);

    const fixes = pl && cStart != null ? windowFixes(store.readHistoryCached(trackerId), race, cStart) : [];
    const a = pl && cStart == null
      ? { status: 'DNS', laps: [], finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: ['Klasse noch nicht gestartet'] }
      : pl
      ? timing.analyzeBoat(pl, fixes, { ...race, startTs: cStart, endTs: cEnd, finishPl })
      : { status: 'DNS', laps: [], finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: ['Keine Linie definiert'] };
    if (distance && finishLine === undefined) a.warnings = a.warnings.concat('Ziellinie hat keine Referenz (Kursseite): Referenzpunkt eingeben oder Bojen festlegen');
    // Langstrecke: Bojen der Reihe nach pruefen (Start-Durchgang bis Ziel bzw. Zielschluss); fehlende werden gemeldet, ohne die Wertung zu aendern
    let markResults = null;
    if (distance && pl && a.startPassTs && race.course && race.course.marks && race.course.marks.length) {
      markResults = courseLib.checkMarks({
        pl, fixes, approxMarks: race.course.marks, startPassTs: a.startPassTs, endTs: a.finishTs || cEnd, options: { radiusM: markRadius(race) }
      }).map((m) => ({ n: m.k + 1, ts: m.t, passOnly: m.passOnly, inOrder: m.inOrder, rounding: m.rounding, side: m.side, wrongSide: m.wrongSide, closestM: m.closestM }));
      const missing = markResults.filter((m) => m.ts == null).map((m) => m.n);
      if (missing.length) {
        const near = markResults.filter((m) => m.ts == null && m.closestM != null).map((m) => `Boje ${m.n}: ${m.closestM} m`).join(', ');
        a.warnings = a.warnings.concat(`Boje ${missing.join(', ')} nicht gerundet/passiert (Radius ${markRadius(race)} m${near ? `; naechste Annaeherung ${near}` : ''}) - bitte pruefen`);
      }
      const SIDE = { port: 'an Backbord', starboard: 'an Steuerbord' };
      markResults.filter((m) => m.wrongSide).forEach((m) => {
        a.warnings = a.warnings.concat(`Boje ${m.n} ${SIDE[m.side]} gelassen, verlangt ist ${SIDE[m.rounding]} (falsche Umrundungsrichtung) - bitte pruefen`);
      });
      const wrongOrder = markResults.filter((m) => m.ts != null && !m.inOrder).map((m) => m.n);
      if (wrongOrder.length) a.warnings = a.warnings.concat(`Boje ${wrongOrder.join(', ')} wurde vor einer frueheren Boje gerundet (falsche Reihenfolge) - bitte pruefen`);
    }

    let { status, finishTs, elapsedSec } = a;
    const warnings = a.warnings.slice();
    if (ov.finishTs != null) {
      finishTs = ov.finishTs;
      elapsedSec = (finishTs - cStart) / 1000;
      status = 'FIN';
      warnings.push('Zielzeit manuell gesetzt');
    }
    if (ov.status) status = ov.status;

    // Datenqualitaet (nur Warnung, aendert weder Status noch Zeit noch Rang): Zeitfenster Start-Durchgang bis Ziel bzw. Zielschluss
    // (bei laufender Wettfahrt bis jetzt). Gemessen wird am GPS-Ziel (a.finishTs), nicht an einer manuell gesetzten Zielzeit -
    // gerade dann will die Wettfahrtleitung sehen, wie gut die Spur war.
    let q = null;
    if (pl && cStart != null) {
      const startPass = a.startCrossingTs ?? a.startPassTs ?? null;
      const from = startPass ?? cStart;
      const to = a.finishTs ?? Math.min(cEnd, now);
      const events = [];
      if (startPass != null) events.push({ label: 'Start', ts: startPass });
      (a.laps || []).forEach((l) => { if (l.ts !== a.finishTs) events.push({ label: `Runde ${l.n}`, ts: l.ts }); });
      if (a.finishTs != null) events.push({ label: 'Ziel', ts: a.finishTs });
      (markResults || []).forEach((m) => { if (m.ts != null) events.push({ label: `Boje ${m.n}`, ts: m.ts }); });
      q = quality.boatQuality({ fixesRaw: fixes, from, to, events });
      // Ohne jede Position steht schon "Keine GPS-Daten ab dem Start" in den Warnungen; kein zweiter Satz dazu.
      const qw = q.metrics.pointsRaw > 0 ? quality.qualityWarning(q) : null;
      if (qw) warnings.push(qw);
    }

    let correctedSec = null;
    if (status === 'FIN' && elapsedSec != null) {
      correctedSec = timing.correctedSeconds(elapsedSec, cls.yardstick) + (ov.penaltySec || 0);
    }
    meta.push({ classId: cls.id, started: (a.startCrossingTs ?? a.startPassTs ?? null) != null, status, finishTs });
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
      startCrossingTs: a.startCrossingTs ?? a.startPassTs ?? null,
      marks: markResults,
      quality: q,
      warnings
    });
  }
  refreshEnds(race, meta, now);
  if (race.auto) base.race.classes = autoClasses(race);
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
    finishLine: state.finishLine,
    course: state.course,
    courses: state.courses,
    activeCourseId: state.activeCourseId,
    liveCourseId: state.liveCourseId || null,
    liveCourse: (() => { const c = courseById(state.liveCourseId); return c ? { id: c.id, name: c.name, line: c.line || null, finishLine: c.finishLine || null, marks: (c.course && c.course.marks) || [] } : null; })(),
    races: state.races.map((r) => ({
      id: r.id, name: r.name, courseId: r.courseId || null, courseName: r.courseName || null, laps: r.laps, minLapSeconds: r.minLapSeconds, cutoffMinutes: r.cutoffMinutes || 180,
      lapMode: r.lapMode || 'bounce', startOnExtension: r.startOnExtension === true, startTs: r.startTs, official: r.official, auto: !!r.auto, autoFrom: r.autoFrom || null, autoTo: r.autoTo || null, classes: r.auto ? autoClasses(r) : [], overrides: r.overrides, hasLine: !!r.line, hasFinishLine: !!r.finishLine, hasCourse: !!r.course
    }))
  };
}

// ---------- Live-Rangliste ----------

const LIVE_TTL_MS = 3000;
const liveCache = new Map();

/** Laeuft die Wettfahrt gerade (Start gesetzt, noch nicht Zielschluss, nicht offiziell abgeschlossen)? */
function isRunning(race, now = Date.now()) {
  if (race.auto) {
    return !race.official && Object.entries(race.classStarts || {}).some(([id, s]) => !(race.classEnds || {})[id] && now < classCutoffTs(race, s.ts));
  }
  return race.startTs != null && !race.official && now < raceEnd(race);
}

function computeLive(race, now = Date.now()) {
  const from = race.startTs - 15 * 60000;
  const boats = [];
  for (const [trackerId, boat] of Object.entries(state.boats)) {
    const tracker = store.getTracker(trackerId);
    const cls = state.classes.find((c) => c.id === boat.classId);
    if (!tracker || !cls) continue;
    boats.push({
      trackerId, name: tracker.name, sailNo: boat.sailNo, helm: boat.helm, className: cls.name, yardstick: cls.yardstick, classId: cls.id,
      color: tracker.color,
      fixes: store.readHistoryCached(trackerId).filter((f) => f.ts >= from && f.ts <= now)
    });
  }
  const mkRace = (startTs) => ({
    startTs, laps: race.laps, minLapSeconds: race.minLapSeconds, endTs: startTs == null ? null : classCutoffTs(race, startTs), lapMode: race.lapMode || 'bounce', startOnExtension: race.startOnExtension === true,
    finishLine: race.lapMode === 'distance' ? (resolveFinishLine(race) || null) : null
  });
  const opts = race.course ? { radiusM: markRadius(race), exact: !!race.course.exact } : {};
  const rank = (args) => courseLib.liveRanking({ line: race.line, approxMarks: race.course ? race.course.marks : [], now, options: opts, ...args });

  let ranking;
  if (!race.auto) {
    ranking = rank({ race: mkRace(race.startTs), boats });
  } else {
    // Jede Klasse hat ihre eigene Startzeit: pro Klasse rechnen, danach zusammenfuehren und neu nach berechneter Zeit ordnen
    const parts = [];
    const waiting = [];
    for (const cls of state.classes) {
      const group = boats.filter((b) => b.classId === cls.id);
      if (!group.length) continue;
      const cs = classStart(race, cls.id);
      if (cs == null) { waiting.push(...group); continue; }
      parts.push(rank({ race: mkRace(cs), boats: group.map((b) => ({ ...b, fixes: b.fixes.filter((f) => f.ts >= cs - 15 * 60000) })) }));
    }
    const head = parts[0] || rank({ race: mkRace(null), boats: [] });
    ranking = { ...head, entries: parts.flatMap((x) => x.entries) };
    ranking.entries.push(...waiting.map((b) => ({
      trackerId: b.trackerId, name: b.name, sailNo: b.sailNo, helm: b.helm, className: b.className, yardstick: b.yardstick,
      status: 'PRESTART', lapsDone: 0, lapNow: 1, lapUncertain: false, marksDone: 0, progressM: 0, progressPct: 0, elapsedSec: null,
      correctedSec: null, projectedCorrectedSec: null, rank: null, gapCorrectedSec: null, gapM: null, speedKn: null, lastFixAgeSec: null
    })));
    const time = (e) => (e.status === 'FIN' ? e.correctedSec : e.projectedCorrectedSec);
    const ranked = ranking.entries.filter((e) => time(e) != null).sort((x, y) => time(x) - time(y));
    ranking.entries.forEach((e) => { e.rank = null; e.gapCorrectedSec = null; });
    ranked.forEach((e, i) => { e.rank = i + 1; e.gapCorrectedSec = time(e) - time(ranked[0]); });
    ranking.leaderId = ranked.length ? ranked[0].trackerId : null;
    courseLib.addNeighbors(ranking.entries);                       // Nachbarn ueber alle Klassen neu bestimmen
    ranking.entries.sort((x, y) => (x.rank ?? 1e6) - (y.rank ?? 1e6) || y.progressM - x.progressM || x.name.localeCompare(y.name, 'de'));
    ranking.elapsedSec = race.startTs == null ? null : Math.max(0, (now - race.startTs) / 1000);
  }
  const colors = Object.fromEntries(boats.map((b) => [b.trackerId, b.color]));
  ranking.entries.forEach((e) => { e.color = colors[e.trackerId]; });
  return {
    race: { id: race.id, name: race.name, laps: race.laps, startTs: race.startTs, official: race.official, running: isRunning(race, now), auto: !!race.auto, classes: race.auto ? autoClasses(race) : [] },
    ...ranking
  };
}

/**
 * Ansicht einer Wettfahrt fuer die Live-Karte: Kurs-Stand der Wettfahrt, Spuren der registrierten Boote im Zeitfenster der Wettfahrt
 * (15 min vor dem Klassen-Start bis Zielschluss + 5 min, bei laufender Wettfahrt bis jetzt), auf max Punkte je Boot ausgeduennt.
 * Die Zuordnung der Spuren ergibt sich aus Zeitfenster und Registrierung; es werden keine Daten kopiert.
 */
function raceView(id, { max = 3000, now = Date.now() } = {}) {
  const race = getRace(id);
  refreshAuto(race, now);
  const cutoffMs = (race.cutoffMinutes || 180) * 60000;
  const out = {
    race: { id: race.id, name: race.name, startTs: race.startTs, official: race.official, running: isRunning(race, now), auto: !!race.auto, lapMode: race.lapMode || 'bounce', laps: race.laps, classes: race.auto ? autoClasses(race) : [] },
    course: { line: race.line || null, finishLine: race.lapMode === 'distance' ? (resolveFinishLine(race) || race.finishLine || null) : (race.finishLine || null), marks: (race.course && race.course.marks) || [], radiusM: race.course ? markRadius(race) : null },
    window: null,
    boats: []
  };
  if (race.startTs == null) return out;
  const to = Math.min(now, (raceEnd(race) || race.startTs + cutoffMs) + 5 * 60000);
  out.window = { from: race.startTs - 15 * 60000, to };
  for (const b of raceBoats()) {
    const tracker = store.getTracker(b.trackerId);
    const cls = state.classes.find((c) => c.id === b.classId);
    const boat = state.boats[b.trackerId];
    const start = classStart(race, b.classId) ?? race.startTs;
    const from = start - 15 * 60000;
    const pts = timing.normalizeFixes(store.readHistoryCached(b.trackerId).filter((f) => f.ts >= from && f.ts <= to));   // ohne schlechte Genauigkeit und Rauschen
    if (!pts.length) continue;
    const step = Math.max(1, Math.ceil(pts.length / max));
    const thin = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
      .map((f) => ({ ts: f.ts, lat: f.lat, lon: f.lon, speed: f.speed ?? null }));
    out.boats.push({ trackerId: b.trackerId, name: tracker.name, color: tracker.color, sailNo: boat.sailNo, helm: boat.helm, className: cls.name, startTs: start, points: thin });
  }
  return out;
}

/**
 * Best-of einer Wettfahrt: schnellstes Boot (gesegelt/berechnet), hoechste Geschwindigkeit und Durchschnittsgeschwindigkeit, kuerzeste/laengste Strecke.
 * Strecke und Tempo zaehlen vom Start-Durchgang bis zum Ziel (nur Boote im Ziel); Tempo aus den Positionen (10-s-Fenster, Ausreisser-sicher),
 * weil nicht jede Quelle (LoRa-Tracker) eine Geschwindigkeit mitschickt.
 */
function raceStats(id, now = Date.now()) {
  const race = getRace(id);
  const res = computeResults(race, now);
  const out = { race: { id: race.id, name: race.name, startTs: race.startTs }, awards: [], boats: [], quality: {} };
  if (race.startTs == null) return out;
  // Datenqualitaet aller Boote (auch nicht im Ziel) fuer die Boots-Details der Live-Karte; die Live-Rangliste selbst rechnet sie nicht
  // (alle 5 s, waere zu teuer), das Best-of wird ohnehin aus computeResults geladen.
  for (const e of res.entries) if (e.quality) out.quality[e.trackerId] = { level: e.quality.level, reasons: e.quality.reasons, source: e.quality.source };
  const KN = 1.9438445;
  const metres = (a, b) => Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
  for (const e of res.entries) {
    if (e.status !== 'FIN' || e.finishTs == null) continue;
    const t0 = e.startCrossingTs != null ? e.startCrossingTs : e.finishTs - e.elapsedSec * 1000;
    const fixes = timing.normalizeFixes(store.readHistoryCached(e.trackerId).filter((f) => f.ts >= t0 - 15000 && f.ts <= e.finishTs + 15000))
      .filter((f) => f.ts >= t0 && f.ts <= e.finishTs);
    if (fixes.length < 2) continue;
    let dist = 0;
    for (let i = 1; i < fixes.length; i += 1) dist += metres(fixes[i - 1], fixes[i]);
    let maxMs = 0;
    for (let i = 0, j = 0; i < fixes.length; i += 1) {
      while (j < fixes.length - 1 && fixes[j].ts - fixes[i].ts < 10000) j += 1;
      const dt = (fixes[j].ts - fixes[i].ts) / 1000;
      if (dt >= 8) maxMs = Math.max(maxMs, metres(fixes[i], fixes[j]) / dt);
    }
    const sailedSec = (e.finishTs - t0) / 1000;
    out.boats.push({
      trackerId: e.trackerId, name: e.name, sailNo: e.sailNo, className: e.className, rank: e.rank, elapsedSec: e.elapsedSec, correctedSec: e.correctedSec,
      distanceM: Math.round(dist), maxSpeedKn: Math.round(maxMs * KN * 10) / 10, avgSpeedKn: sailedSec > 0 ? Math.round((dist / sailedSec) * KN * 10) / 10 : null
    });
  }
  const label = (b) => [b.sailNo, b.name].filter(Boolean).join(' ');
  const best = (list, key, dir) => list.length ? list.reduce((a, b) => (dir * (b[key] - a[key]) > 0 ? b : a)) : null;
  const add = (title, b, value, unit) => { if (b) out.awards.push({ title, boat: label(b), className: b.className, value, unit }); };
  const fin = out.boats;
  const byElapsed = best(fin.filter((b) => b.elapsedSec != null), 'elapsedSec', -1);
  const byCorrected = best(fin.filter((b) => b.correctedSec != null), 'correctedSec', -1);
  add('Schnellstes Boot (gesegelte Zeit)', byElapsed, byElapsed && byElapsed.elapsedSec, 's');
  add('Sieger nach Yardstick (berechnete Zeit)', byCorrected, byCorrected && byCorrected.correctedSec, 's');
  const fastest = best(fin, 'maxSpeedKn', 1);
  add('Hoechstgeschwindigkeit', fastest, fastest && fastest.maxSpeedKn, 'kn');
  const avg = best(fin.filter((b) => b.avgSpeedKn != null), 'avgSpeedKn', 1);
  add('Hoechste Durchschnittsgeschwindigkeit', avg, avg && avg.avgSpeedKn, 'kn');
  const shortest = best(fin, 'distanceM', -1);
  add('Kuerzeste Strecke', shortest, shortest && shortest.distanceM, 'm');
  if (fin.length > 1) { const longest = best(fin, 'distanceM', 1); add('Laengste Strecke', longest, longest && longest.distanceM, 'm'); }
  return out;
}

/** Live-Rangliste zu einem beliebigen Zeitpunkt (Zeitleiste einer beendeten oder laufenden Wettfahrt); nicht gecacht. */
function getLiveAt(id, at) {
  const race = getRace(id);
  if (!Number.isFinite(at)) throw httpError(400, 'at ungueltig');
  refreshAuto(race, at);
  if (race.startTs == null || at < race.startTs) {
    return { race: { id: race.id, name: race.name, startTs: race.startTs, official: race.official, running: false, auto: !!race.auto, classes: race.auto ? autoClasses(race) : [] }, updatedAt: at, elapsedSec: null, needsCourse: false, marks: [], entries: [], leaderId: null, foremostId: null };
  }
  return computeLive(race, at);
}

/** Wie computeLive, aber hoechstens alle LIVE_TTL_MS neu berechnet (viele Zuschauer, gleiche Daten). */
function getLive(id, now = Date.now()) {
  const race = getRace(id);
  if (race.auto) {
    const c0 = liveCache.get(id);
    if (c0 && now - c0.at < LIVE_TTL_MS) return c0.data;
    computeResults(race, now);                                    // aktualisiert Start-Erkennung und Klassen-Ende
    if (race.startTs == null) {
      const waiting = { race: { id: race.id, name: race.name, laps: race.laps, startTs: null, official: race.official, running: false, auto: true, classes: autoClasses(race) }, updatedAt: now, elapsedSec: null, needsCourse: false, marks: [], entries: [], leaderId: null, foremostId: null };
      liveCache.set(id, { at: now, data: waiting });
      return waiting;
    }
  } else if (race.startTs == null) throw httpError(400, 'Wettfahrt hat keinen Start');
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
  let name = 'Regatta';
  let geo = { line: state.line, finishLine: state.finishLine, course: state.course };
  if (race) {
    const r = getRace(race);
    if (r.startTs == null) throw httpError(400, 'Wettfahrt hat keinen Start');
    f = r.startTs - 10 * 60000;
    t = raceEnd(r) + 10 * 60000;
    name = r.name;
    geo = { line: r.line, finishLine: r.finishLine, course: r.course };
  }
  // Kurs als Wegpunkte (Linie, Ziellinie, Referenz, Bojen/Tore) und als Route in Fahrtreihenfolge
  const waypoints = [];
  const route = [];
  const SIDE = { port: ' (Backbord lassen)', starboard: ' (Steuerbord lassen)' };
  if (geo.line) {
    waypoints.push({ lat: geo.line.a.lat, lon: geo.line.a.lon, name: 'Start Linie A' }, { lat: geo.line.b.lat, lon: geo.line.b.lon, name: 'Start Linie B' });
    if (geo.line.mark) waypoints.push({ lat: geo.line.mark.lat, lon: geo.line.mark.lon, name: 'Referenz Kursseite' });
    route.push({ lat: (geo.line.a.lat + geo.line.b.lat) / 2, lon: (geo.line.a.lon + geo.line.b.lon) / 2, name: 'Start' });
  }
  if (geo.course) {
    geo.course.marks.forEach((m, i) => {
      if (m.a) {
        waypoints.push({ lat: m.a.lat, lon: m.a.lon, name: `Tor ${i + 1} A` }, { lat: m.b.lat, lon: m.b.lon, name: `Tor ${i + 1} B` });
        route.push({ lat: (m.a.lat + m.b.lat) / 2, lon: (m.a.lon + m.b.lon) / 2, name: `Tor ${i + 1}` });
      } else {
        const nm = `Boje ${i + 1}${SIDE[m.rounding] || ''}${geo.course.exact ? '' : ' (grob)'}`;
        waypoints.push({ lat: m.lat, lon: m.lon, name: nm });
        route.push({ lat: m.lat, lon: m.lon, name: nm });
      }
    });
  }
  if (geo.finishLine && geo.finishLine.a && geo.finishLine.b) {
    waypoints.push({ lat: geo.finishLine.a.lat, lon: geo.finishLine.a.lon, name: 'Ziel Linie A' }, { lat: geo.finishLine.b.lat, lon: geo.finishLine.b.lon, name: 'Ziel Linie B' });
    route.push({ lat: (geo.finishLine.a.lat + geo.finishLine.b.lat) / 2, lon: (geo.finishLine.a.lon + geo.finishLine.b.lon) / 2, name: 'Ziel' });
  }
  const routes = route.length > 1 ? [{ name: 'Kurs', points: route }] : [];
  // trackers=none: nur der Kurs, keine Logdaten
  const ids = trackers === 'none' ? [] : trackers ? String(trackers).split(',').filter(Boolean) : store.listTrackers().map((x) => x.id);
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
  return { entries, from: f, to: t, name, waypoints, routes };
}

migrateCourses();

module.exports = {
  listCourses, createCourse, exportCourse, importCourse, updateCourse, activateCourse, deleteCourse, courseById, activeCourse,
  exportSelection, computeLive, getLive, getLiveAt, raceView, raceStats, isRunning, runningRaces,
  flush, state, STATUS_CODES, httpError, publicState,
  setCourse, setFinishLine, setLiveCourse, resolveFinishLine, applyGeometry, raceEnd, windowFixes,
  addClass, importClasses, deleteClass, registerBoat, unregisterBoat, setLine,
  getRace, tickAuto, createRace, updateRace, deleteRace, startRace, clearStart, setOverride, setOfficial,
  computeResults, toCsv
};
