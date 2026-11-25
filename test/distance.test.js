'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-distance-'));
const store = require('../server/store');
const regatta = require('../server/regatta');
const timing = require('../server/timing');
const course = require('../server/course');

// Koordinaten in Metern (x Ost, y Nord) um 46.84N/10.52E
const lat0 = 46.84, lon0 = 10.52;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon });

// Langstrecke: Start-Linie bei y=0 (100 m breit, Kursseite Norden), Boje 1 bei (0, 3000), Boje 2 bei (3000, 3000),
// Ziellinie bei (3000, 500) quer (100 m breit), Kursseite Norden (Boote kommen von Boje 2 aus Norden und fahren nach Sueden durch).
const START = { a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) };
const FINISH = { a: pt(2950, 500), b: pt(3050, 500) };            // ohne Referenz: Kursseite = letzte Boje (Norden)
const MARKS = [pt(0, 3000), pt(3000, 3000)];

/** Fixes entlang eines Wegs (Punkte in m) mit konstantem Tempo, 1 Fix pro Sekunde ab t0. */
function drive(path, t0, speed = 4, withNoise = false) {
  const out = [];
  let t = t0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const [x0, y0] = path[i];
    const [x1, y1] = path[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / speed));
    for (let k = 0; k < n; k += 1) {
      const u = k / n;
      out.push({ ...pt(x0 + (x1 - x0) * u + (withNoise ? Math.sin(t) * 1.5 : 0), y0 + (y1 - y0) * u), ts: t, speed });
      t += 1000;
    }
  }
  const [xl, yl] = path[path.length - 1];
  out.push({ ...pt(xl, yl), ts: t, speed });
  return out;
}

const GUN = Date.UTC(2026, 6, 4, 9, 0, 0);
// Start 60 s nach dem Signal von Sueden nach Norden, Boje 1, Boje 2, dann nach Sueden durch die Ziellinie und weiter bis y=300
const FULL_PATH = [[0, -200], [0, 3000], [3000, 3000], [3000, 300]];

test('Langstrecke mit eigener Ziellinie: Start, Ziel, genau eine "Runde", Zeit ab Startsignal', () => {
  const pl = timing.prepareLine(START);
  const finishLine = { ...FINISH, mark: pt(3000, 3000) };
  const fpl = timing.prepareLine(finishLine);
  const fixes = drive(FULL_PATH, GUN + 60000);
  const a = timing.analyzeBoat(pl, fixes, { startTs: GUN, laps: 1, minLapSeconds: 120, lapMode: 'distance', finishPl: fpl });
  assert.strictEqual(a.status, 'FIN');
  assert.strictEqual(a.laps.length, 1);
  // Weg: 200 m (50 s) bis Start-Linie bei y=0 -> Startdurchgang 10 s nach Fahrtbeginn... Ziel nach 3000 + 3000 + 2500 m Gesamtfahrt ab Start-Linie
  const startPass = GUN + 60000 + 50000;
  assert.ok(Math.abs(a.startPassTs - startPass) < 2000, `Start ${a.startPassTs - GUN}`);
  const expectedFinish = startPass + ((3000 + 3000 + 2500) / 4) * 1000;
  assert.ok(Math.abs(a.finishTs - expectedFinish) < 3000, `Ziel ${(a.finishTs - expectedFinish) / 1000}`);
  assert.ok(Math.abs(a.elapsedSec - (a.finishTs - GUN) / 1000) < 1e-6);      // Zeit ab Startsignal
});

test('Langstrecke ohne eigene Ziellinie: Ziel = Rueckkehr durch die Start-Linie', () => {
  const pl = timing.prepareLine(START);
  const fixes = drive([[0, -200], [0, 3000], [3000, 3000], [3000, 300], [0, 300], [0, -200]], GUN + 30000);
  const a = timing.analyzeBoat(pl, fixes, { startTs: GUN, laps: 1, minLapSeconds: 120, lapMode: 'distance', finishPl: null });
  assert.strictEqual(a.status, 'FIN');
  assert.ok(a.finishTs > a.startPassTs + 1000 * 1000);
  // Ohne Rueckkehr: kein Ziel
  const half = drive([[0, -200], [0, 3000], [3000, 3000]], GUN + 30000);
  const b = timing.analyzeBoat(pl, half, { startTs: GUN, laps: 1, minLapSeconds: 120, lapMode: 'distance', finishPl: null });
  assert.strictEqual(b.status, 'DNF');
  assert.ok(b.warnings.some((w) => /Kein Ziel/.test(w)));
});

test('Langstrecke: kein Start-Durchgang -> DNS; Ziel neben der Ziellinie zaehlt nicht', () => {
  const pl = timing.prepareLine(START);
  const fpl = timing.prepareLine({ ...FINISH, mark: pt(3000, 3000) });
  const noStart = drive([[500, -200], [500, 3000]], GUN + 30000);                   // 450 m neben der Start-Linie
  const a = timing.analyzeBoat(pl, noStart, { startTs: GUN, laps: 1, minLapSeconds: 120, lapMode: 'distance', finishPl: fpl });
  assert.strictEqual(a.status, 'DNS');
  assert.ok(a.warnings.some((w) => /Kein Start/.test(w)));
  const missFinish = drive([[0, -200], [0, 3000], [3000, 3000], [3300, 3000], [3300, 300]], GUN + 30000);   // 300 m neben der Ziellinie
  const b = timing.analyzeBoat(pl, missFinish, { startTs: GUN, laps: 1, minLapSeconds: 120, lapMode: 'distance', finishPl: fpl });
  assert.strictEqual(b.status, 'DNF');
});

test('checkMarks: Bojen der Reihe nach mit Zeit; ausgelassene Boje fehlt', () => {
  const pl = timing.prepareLine(START);
  const fixes = drive(FULL_PATH, GUN + 60000);
  const r = course.checkMarks({ pl, fixes, approxMarks: MARKS, startPassTs: GUN + 110000, endTs: null, options: { radiusM: 250 } });
  assert.strictEqual(r.length, 2);
  assert.ok(r[0].t != null && r[1].t != null && r[0].t < r[1].t);
  // Boje 1 wird ausgelassen (der Weg biegt bei y=1500 nach Osten ab), Boje 2 normal umfahren
  const cut = drive([[0, -200], [0, 1500], [1500, 1500], [1500, 3000], [3000, 3000], [3000, 300]], GUN + 60000);
  const r2 = course.checkMarks({ pl, fixes: cut, approxMarks: MARKS, startPassTs: GUN + 110000, endTs: null, options: { radiusM: 250 } });
  assert.strictEqual(r2[0].t, null);
});

test('Langstrecke komplett: Kurs/Rennen anlegen, Ziellinie, Ergebnis mit Bojen, fehlende Boje als Warnung', () => {
  const cls = regatta.addClass('YS100', 100);
  const t1 = store.createTracker('Lang1');
  const t2 = store.createTracker('Lang2');
  regatta.registerBoat(t1.id, { sailNo: 'L 1', helm: 'A', classId: cls.id });
  regatta.registerBoat(t2.id, { sailNo: 'L 2', helm: 'B', classId: cls.id });

  const c = regatta.createCourse({ kind: 'distance' });
  assert.strictEqual(c.lapMode, 'distance');
  assert.strictEqual(c.laps, 1);
  regatta.setLine(START);
  regatta.setCourse(MARKS, 250, true);
  regatta.setFinishLine(FINISH);                                           // ohne Referenz
  assert.throws(() => regatta.setFinishLine({ a: pt(0, 0), b: pt(0, 0) }), /kurz/);
  assert.strictEqual(regatta.activeCourse().finishLine.a.lat, FINISH.a.lat);

  // Boot 1 segelt alles, Boot 2 laesst Boje 1 aus
  for (const f of drive(FULL_PATH, GUN + 60000)) store.recordPosition(t1.id, f);
  for (const f of drive([[0, -200], [0, 1500], [1500, 1500], [1500, 3000], [3000, 3000], [3000, 300]], GUN + 80000)) store.recordPosition(t2.id, f);

  const race = regatta.createRace({ name: 'Langstrecke 1', startTs: GUN, cutoffMinutes: 240 });
  assert.strictEqual(race.lapMode, 'distance');
  assert.strictEqual(race.laps, 1);
  assert.ok(race.finishLine);
  assert.ok(regatta.publicState().races.find((r) => r.id === race.id).hasFinishLine);
  const res = regatta.computeResults(race);
  const e1 = res.entries.find((e) => e.trackerId === t1.id);
  const e2 = res.entries.find((e) => e.trackerId === t2.id);
  assert.strictEqual(e1.status, 'FIN');
  assert.strictEqual(e2.status, 'FIN');
  assert.strictEqual(e1.marks.length, 2);
  assert.ok(e1.marks.every((m) => m.ts != null));
  assert.ok(e2.marks[0].ts == null && e2.marks[1].ts != null);
  assert.ok(e2.warnings.some((w) => /Boje 1 nicht/.test(w)));
  assert.ok(!e1.warnings.some((w) => /Boje/.test(w)));
  assert.strictEqual(e1.rank, 1);                                          // Boot 1 hat 20 s Vorsprung beim Start und die kuerzere Strecke ... Rang nach Zeit ab Signal
  // Live-Rangliste laeuft mit Ziellinie durch (Fortschritt bis zur Ziellinie)
  const live = regatta.computeLive(race, GUN + 3600e3 * 2);
  assert.ok(live.entries.length === 2);
  assert.ok(live.entries.every((e) => e.status === 'FIN'));
  assert.ok(live.totalM > 8000 && live.totalM < 9000, `Gesamtstrecke ${live.totalM}`);   // 3000 + 3000 + 2500
  // Ziellinie entfernen = Kurs ohne eigene Ziellinie
  regatta.setFinishLine(null);
  assert.strictEqual(regatta.activeCourse().finishLine, null);
  // Modus eines bestehenden Rennens umstellen: laps wird 1
  const r2 = regatta.createRace({ name: 'Rund', lapMode: 'loop', laps: 3 });
  assert.strictEqual(r2.laps, 3);
  assert.strictEqual(regatta.updateRace(r2.id, { lapMode: 'distance' }).laps, 1);
});

test('Umrundungsrichtung: Backbord/Steuerbord aus der Drehrichtung bzw. der Seite bei der Vorbeifahrt', () => {
  const pl = timing.prepareLine(START);
  const M1 = pt(0, 3000);
  const run = (path, rounding) => course.checkMarks({ pl, fixes: drive(path, GUN + 60000), approxMarks: [rounding ? { ...M1, rounding } : M1], startPassTs: GUN + 100000, options: { radiusM: 250 } })[0];
  // Nach Norden, Boje links liegen lassen? Pfad A: noerdlich um die Boje herum nach Osten abbiegen, Boje liegt danach rechts (Steuerbord, im Uhrzeigersinn)
  const a = run([[0, -200], [-30, 3030], [3000, 3030]], 'starboard');
  assert.strictEqual(a.side, 'starboard');
  assert.strictEqual(a.wrongSide, false);
  assert.strictEqual(run([[0, -200], [-30, 3030], [3000, 3030]], 'port').wrongSide, true);   // verlangt Backbord -> falsche Seite
  // Pfad B: oestlich vorbei, nach Westen abbiegen, Boje liegt links (Backbord, gegen den Uhrzeigersinn)
  const b = run([[0, -200], [30, 3030], [-3000, 3030]], 'port');
  assert.strictEqual(b.side, 'port');
  assert.strictEqual(b.wrongSide, false);
  assert.strictEqual(run([[0, -200], [30, 3030], [-3000, 3030]], 'starboard').wrongSide, true);
  // Blosse Vorbeifahrt (gerade, 24 m oestlich): Boje liegt links = Backbord
  const c = run([[0, -200], [48, 6000]], 'port');
  assert.strictEqual(c.passOnly, true);
  assert.strictEqual(c.side, 'port');
  // ohne Vorgabe: keine Beanstandung; durch die Boje selbst (Seite nicht bestimmbar): nie "falsche Seite"
  const d = run([[0, -200], [0, 3000], [3000, 3000]], undefined);
  assert.strictEqual(d.wrongSide, false);
  assert.strictEqual(d.rounding, null);
  assert.strictEqual(run([[0, -200], [0, 3000], [3000, 3000]], 'port').wrongSide, false);
});

test('Umrundungsrichtung im Kurs speichern und in der Wertung melden', () => {
  const cls = regatta.addClass('YS110', 110);
  const tr = store.createTracker('Richtung');
  regatta.registerBoat(tr.id, { sailNo: 'R 1', helm: 'C', classId: cls.id });
  regatta.createCourse({ kind: 'distance' });
  regatta.setLine(START);
  const stored = regatta.setCourse([{ ...MARKS[0], rounding: 'port' }, { ...MARKS[1], rounding: 'quatsch' }], 250, true);
  assert.strictEqual(stored.marks[0].rounding, 'port');
  assert.strictEqual(stored.marks[1].rounding, undefined);                                   // ungueltige Werte werden verworfen
  regatta.setFinishLine({ a: pt(2950, 500), b: pt(3050, 500) });
  // Boot laesst Boje 1 an Steuerbord (Pfad ueber (-30, 3030)), verlangt ist Backbord
  for (const f of drive([[0, -200], [-30, 3030], [3000, 3030], [3000, 300]], GUN + 60000)) store.recordPosition(tr.id, f);
  const race = regatta.createRace({ name: 'Richtung', startTs: GUN, cutoffMinutes: 240 });
  assert.strictEqual(race.course.marks[0].rounding, 'port');
  const e = regatta.computeResults(race).entries.find((x) => x.trackerId === tr.id);
  assert.ok(e.warnings.some((w) => /Boje 1 an Steuerbord gelassen, verlangt ist an Backbord/.test(w)), e.warnings.join(' | '));
  assert.strictEqual(e.marks[0].wrongSide, true);
  assert.strictEqual(e.status, 'FIN');                                                        // nur Warnung, Wertung bleibt
});
