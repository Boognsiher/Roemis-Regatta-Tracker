'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-retro-'));
const store = require('../server/store');
const regatta = require('../server/regatta');

// Linie 100 m Ost-West bei 46.84N/10.52E, Kursseite Norden
const lat0 = 46.84, lon0 = 10.52;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon });

// Boot segelt 2 Runden (je 200 s) ab Startzeit gunTs, 1 Fix pro Sekunde (Hin 100 s Nord, Rueck 100 s Ssued, mit 2 m/s)
function recordRace(trackerId, gunTs) {
  for (let t = -30; t <= 420; t += 1) {
    const ph = ((t + 10) % 200 + 200) % 200;
    let y = t < -10 ? -20 : (ph < 100 ? -20 + ph * 2 : -20 + (200 - ph) * 2);
    store.recordPosition(trackerId, { ...pt(0, y), ts: gunTs + t * 1000, speed: 2 });
  }
}

test('nachtraegliche Wettfahrten aus Aufzeichnungen, Zielschluss trennt zwei Laeufe', () => {
  const cls = regatta.addClass('Test', 100);
  const tr = store.createTracker('Retro');
  regatta.registerBoat(tr.id, { sailNo: 'T 1', helm: 'X', classId: cls.id });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });

  const day = Date.UTC(2025, 5, 14, 9, 0, 0);
  const gun1 = day;
  const gun2 = day + 3600e3;      // zweiter Lauf eine Stunde spaeter, gleiche Aufzeichnung
  recordRace(tr.id, gun1);
  recordRace(tr.id, gun2);

  const r1 = regatta.createRace({ name: 'Lauf 1', laps: 2, startTs: gun1, cutoffMinutes: 30, lapMode: 'bounce' });
  const r2 = regatta.createRace({ name: 'Lauf 2', laps: 2, startTs: gun2, cutoffMinutes: 30, lapMode: 'bounce' });
  assert.strictEqual(r1.startTs, gun1);
  assert.strictEqual(regatta.raceEnd(r1), gun1 + 30 * 60000);

  for (const r of [r1, r2]) {
    const e = regatta.computeResults(r).entries[0];
    assert.strictEqual(e.status, 'FIN');
    assert.strictEqual(e.laps.length, 2);
    assert.ok(Math.abs(e.elapsedSec - 380) < 3, `elapsed ${e.elapsedSec}`);
    assert.ok(Math.abs(e.correctedSec - 380) < 3);   // YS 100
  }

  // Zielschluss: Lauf 1 darf nicht die Runden aus Lauf 2 zaehlen, wenn Lauf 1 nur 1 Runde segelt
  const r3 = regatta.createRace({ name: 'Lauf 1 kurz', laps: 4, startTs: gun1, cutoffMinutes: 30, lapMode: 'bounce' });
  const e3 = regatta.computeResults(r3).entries[0];
  assert.strictEqual(e3.status, 'DNF');
  assert.strictEqual(e3.laps.length, 2);               // nur die 2 Runden von Lauf 1, nicht die aus Lauf 2
  const r4 = regatta.createRace({ name: 'Lauf 1 lang', laps: 4, startTs: gun1, cutoffMinutes: 120, lapMode: 'bounce' });
  assert.strictEqual(regatta.computeResults(r4).entries[0].laps.length, 4);  // ohne engen Zielschluss zaehlt Lauf 2 mit

  // Zielschluss nachtraeglich aendern
  regatta.updateRace(r4.id, { cutoffMinutes: 30 });
  assert.strictEqual(regatta.computeResults(r4).entries[0].laps.length, 2);
});

test('Wettfahrt ohne Linie kann nicht mit Startzeit angelegt werden; Geometrie uebernehmen', () => {
  const ac = regatta.activeCourse();
  const savedLine = ac.line;
  ac.line = null;
  assert.throws(() => regatta.createRace({ name: 'x', startTs: 1000 }), /linie/i);
  ac.line = savedLine;
  const r = regatta.createRace({ name: 'ohne Start' });
  assert.strictEqual(r.startTs, null);
  regatta.setCourse([{ lat: lat0 + 0.004, lon: lon0 }], 200);
  const r2 = regatta.applyGeometry(r.id);
  assert.strictEqual(r2.course.marks.length, 1);
  assert.throws(() => regatta.setCourse([], 100), /Kurs/);
  assert.throws(() => regatta.setCourse([{ lat: 99, lon: 0 }], 100), /Kurs/);
});

test('Export-Auswahl: Wettfahrt-Zeitfenster und Wegpunkte', () => {
  const r = regatta.state.races.find((x) => x.name === 'Lauf 2');
  const sel = regatta.exportSelection({ race: r.id });
  assert.strictEqual(sel.name, 'Lauf 2');
  assert.strictEqual(sel.from, r.startTs - 600000);
  assert.ok(sel.waypoints.length >= 2);
  const csv = require('../server/export').tracksCsv(sel.entries, sel);
  const rows = csv.trim().split('\r\n').length - 1;
  assert.ok(rows > 400 && rows < 500, `Zeilen ${rows}`);   // nur Lauf 2 (451 Fixes), nicht Lauf 1
  assert.throws(() => regatta.exportSelection({ from: 'kein-datum' }), /Zeit ungueltig/);
});

test('Live-Berechnung ueber das Regatta-Modul (Historie -> Rangliste), Zwischenspeicher', () => {
  const race = regatta.state.races.find((x) => x.name === 'Lauf 1');
  regatta.setCourse([pt(0, 180)], 150);
  regatta.applyGeometry(race.id);
  const mid = regatta.computeLive(race, race.startTs + 150 * 1000);
  assert.strictEqual(mid.needsCourse, false);
  assert.strictEqual(mid.entries[0].status, 'RACING');
  assert.ok(mid.entries[0].progressM > 50);
  const end = regatta.computeLive(race, race.startTs + 500 * 1000);
  assert.strictEqual(end.entries[0].status, 'FIN');
  assert.strictEqual(end.entries[0].rank, 1);
  assert.strictEqual(regatta.isRunning(race, race.startTs + 100), true);
  assert.strictEqual(regatta.isRunning(race, regatta.raceEnd(race) + 1), false);
  const a = regatta.getLive(race.id, race.startTs + 200 * 1000);
  const b = regatta.getLive(race.id, race.startTs + 201 * 1000);   // innerhalb der 3 s: gleiche Daten
  assert.strictEqual(a, b);
});

test('Kurs mit exact-Flag wird gespeichert und in neue Wettfahrten uebernommen', () => {
  const c = regatta.setCourse([pt(0, 150), pt(100, 300)], 200, true);
  assert.strictEqual(c.exact, true);
  const r = regatta.createRace({ name: 'exakt' });
  assert.strictEqual(r.course.exact, true);
  assert.strictEqual(regatta.setCourse([pt(0, 150)], 200).exact, false);
});

test('Kurs mit Tor wird gespeichert, ungueltige Formen werden abgelehnt', () => {
  const c = regatta.setCourse([pt(0, 150), { a: pt(-30, 80), b: pt(30, 80) }], 200, true);
  assert.strictEqual(c.marks.length, 2);
  assert.ok(c.marks[1].a && c.marks[1].b);
  assert.throws(() => regatta.setCourse([{ a: pt(0, 0) }], 200), /Kurs/);          // Tor ohne b
  assert.throws(() => regatta.setCourse([{ a: { lat: 99, lon: 0 }, b: pt(0, 0) }], 200), /Kurs/);
  const r = regatta.createRace({ name: 'Tor' });
  assert.ok(r.course.marks[1].a);
  const sel = regatta.exportSelection({});
  assert.ok(sel.waypoints.some((w) => w.name === 'Tor 2 A') && sel.waypoints.some((w) => w.name === 'Tor 2 B'));
  regatta.setCourse([pt(0, 150)], 200, false);
});


// ---- Kurse (Vorlagen mit Geometrie + Regeln) ----
test('Standardkurs existiert, Linie/Kurs-Aenderungen schreiben in den aktiven Kurs durch', () => {
  const courses = regatta.listCourses();
  assert.ok(courses.length >= 1);
  const a = regatta.activeCourse();
  assert.strictEqual(a.lapMode, 'loop');
  assert.strictEqual(a.startOnExtension, false);
  assert.strictEqual(a.laps, 2);
  assert.ok(/Boje 1 oben/.test(a.name));
  regatta.setLine({ a: pt(-60, 0), b: pt(60, 0), mark: pt(0, 400) });
  assert.strictEqual(Math.round((regatta.activeCourse().line.b.lon - regatta.activeCourse().line.a.lon) * 1e6) > 0, true);
  regatta.setCourse([pt(0, 400), pt(100, -300)], 200, true);
  assert.strictEqual(regatta.activeCourse().course.marks.length, 2);
});

test('Neue Kurse nach Typ und als Kopie, aktivieren laedt die Geometrie, Wettfahrten behalten ihre Kopie', () => {
  const base = regatta.activeCourse();
  const copy = regatta.createCourse({ name: 'Kopie davon', copyFrom: base.id });
  assert.strictEqual(regatta.activeCourse().id, copy.id);
  assert.strictEqual(copy.course.marks.length, 2);                         // Geometrie mitkopiert
  assert.notStrictEqual(copy.course, base.course);                          // eigene Kopie
  const hz = regatta.createCourse({ kind: 'bounce' });                      // leerer Kurs vom Typ "hin und zurueck"
  assert.strictEqual(hz.lapMode, 'bounce');
  assert.strictEqual(hz.course, null);
  assert.strictEqual(regatta.state.course, null);                           // Arbeitskopie = aktiver (leerer) Kurs

  // Wettfahrt aus dem Standardkurs: Geometrie und Regeln kopiert, spaetere Aenderungen am Kurs aendern sie nicht
  const race = regatta.createRace({ name: 'Aus Kurs', courseId: base.id });
  assert.strictEqual(race.courseId, base.id);
  assert.strictEqual(race.courseName, base.name);
  assert.strictEqual(race.lapMode, 'loop');
  assert.strictEqual(race.course.marks.length, 2);
  regatta.updateCourse(base.id, { lapMode: 'bounce', laps: 3, name: 'Umbenannt' });
  assert.strictEqual(race.lapMode, 'loop');
  assert.strictEqual(race.laps, 2);
  // Beim Start gilt die aktuelle Fassung des Kurses der Wettfahrt (Geometrie), nicht der gerade aktive Kurs
  regatta.activateCourse(hz.id);
  regatta.activateCourse(base.id);
  regatta.setCourse([pt(10, 450)], 150, true);
  regatta.activateCourse(hz.id);                                            // anderer Kurs aktiv, Wettfahrt gehoert zu base
  const started = regatta.startRace(race.id, 1000);
  assert.strictEqual(started.course.marks.length, 1);                       // geaenderte Fassung von base
  assert.strictEqual(started.courseId, base.id);
  // explizite Werte ueberschreiben die Kursregeln
  const r2 = regatta.createRace({ name: 'Ueberschrieben', courseId: base.id, laps: 4, lapMode: 'loop', startOnExtension: true });
  assert.deepStrictEqual([r2.laps, r2.lapMode, r2.startOnExtension], [4, 'loop', true]);
});

test('Kurse loeschen: der letzte bleibt, aktiver Kurs wird ersetzt; unbekannte Ids werden abgelehnt', () => {
  const all = regatta.listCourses().slice();
  assert.ok(all.length >= 3);
  const active = regatta.activeCourse();
  regatta.deleteCourse(active.id);
  assert.ok(regatta.activeCourse().id !== active.id);                       // anderer Kurs ist nun aktiv
  assert.strictEqual(regatta.state.line === null || typeof regatta.state.line === 'object', true);
  assert.throws(() => regatta.deleteCourse('gibtsnicht'), /unbekannt/);
  assert.throws(() => regatta.createRace({ name: 'x', courseId: 'gibtsnicht' }), /unbekannt/);
  while (regatta.listCourses().length > 1) regatta.deleteCourse(regatta.listCourses()[0].id);
  assert.throws(() => regatta.deleteCourse(regatta.listCourses()[0].id), /letzte Kurs/);
});
