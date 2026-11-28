'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-details-'));
const store = require('../server/store');
const regatta = require('../server/regatta');

const lat0 = 46.84, lon0 = 10.52;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon });
const GUN = Date.UTC(2026, 6, 4, 9, 0, 0);

/** Von (0,-200) mit 4 m/s nach Norden, ab t0, bis y = yEnd. */
function north(t0, yEnd) {
  const out = [];
  for (let t = 0; ; t += 1) {
    const y = -200 + 4 * t;
    if (y > yEnd) break;
    out.push({ ...pt(0, y), ts: t0 + t * 1000, speed: 4 });
  }
  return out;
}

test('Live-Details: naechste Boje, Distanz, VMG, Boot davor/dahinter', () => {
  const cls = regatta.addClass('YS100', 100);
  const a = store.createTracker('Vorn');
  const b = store.createTracker('Hinten');
  regatta.registerBoat(a.id, { sailNo: '1', helm: 'a', classId: cls.id });
  regatta.registerBoat(b.id, { sailNo: '2', helm: 'b', classId: cls.id });
  regatta.createCourse({ kind: 'bounce' });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });
  regatta.setCourse([pt(0, 800)], 250, true);
  // A faehrt bei GUN los (bei y=600 nach 200 s), B 30 s spaeter (dann bei y=480)
  for (const f of north(GUN, 600)) store.recordPosition(a.id, f);
  for (const f of north(GUN + 30000, 480)) store.recordPosition(b.id, f);
  const race = regatta.createRace({ name: 'D', laps: 1, lapMode: 'bounce', startTs: GUN });
  const live = regatta.computeLive(race, GUN + 200000);
  const ea = live.entries.find((e) => e.trackerId === a.id);
  const eb = live.entries.find((e) => e.trackerId === b.id);
  assert.strictEqual(ea.status, 'RACING');
  assert.strictEqual(ea.nextMark.label, 'Boje 1');
  assert.ok(Math.abs(ea.nextMark.distM - 200) < 15, `Distanz ${ea.nextMark.distM}`);
  assert.ok(ea.nextMark.bearingDeg <= 2 || ea.nextMark.bearingDeg >= 358);
  assert.ok(ea.headingDeg <= 2 || ea.headingDeg >= 358);
  assert.ok(ea.vmgKn > 6 && ea.vmgKn < 9, `VMG ${ea.vmgKn}`);          // 4 m/s = 7,8 kn direkt auf die Boje zu
  assert.strictEqual(ea.ahead, null);
  assert.ok(ea.behind && Math.abs(ea.behind.courseM - 120) < 15 && Math.abs(ea.behind.directM - 120) < 15, JSON.stringify(ea.behind));
  assert.ok(eb.ahead && eb.ahead.name.includes('Vorn') && Math.abs(eb.ahead.courseM - 120) < 15);
  assert.strictEqual(eb.behind, null);
  assert.ok(ea.pos && Math.abs(ea.pos.lat - pt(0, 600).lat) < 1e-4);
  assert.strictEqual(eb.rankAhead.name.includes('Vorn'), true);
  assert.strictEqual(ea.rankBehind.name.includes('Hinten'), true);
});

test('Wettfahrt-Ansicht: Kurs-Stand, Spuren im Zeitfenster, Rangliste zu einem fruehen Zeitpunkt', () => {
  const race = regatta.getRace(regatta.publicState().races[0].id);
  const view = regatta.raceView(race.id, { max: 50, now: GUN + 400000 });
  assert.strictEqual(view.race.id, race.id);
  assert.ok(view.course.line && view.course.line.a);
  assert.strictEqual(view.course.marks.length, 1);
  assert.strictEqual(view.boats.length, 2);
  assert.ok(view.boats.every((b) => b.points.length > 1 && b.points.length <= 51));
  assert.ok(view.window.from < GUN && view.window.to <= GUN + 400000);
  assert.ok(view.boats.every((b) => b.points.every((p) => p.ts >= view.window.from && p.ts <= view.window.to)));
  const early = regatta.getLiveAt(race.id, GUN + 100000);        // A ist noch vor der Linie, B startet erst spaeter
  assert.ok(early.entries.length === 2);
  const mid = regatta.getLiveAt(race.id, GUN + 200000);
  const ea = mid.entries.find((e) => e.name === 'Vorn');
  assert.strictEqual(ea.nextMark.label, 'Boje 1');
  assert.deepStrictEqual(regatta.getLiveAt(race.id, GUN - 1000).entries, []);   // vor dem Start: leer
  assert.throws(() => regatta.getLiveAt(race.id, NaN), /ungueltig/);
});

test('Best-of einer Wettfahrt: Boote im Ziel, schnellstes Boot, Strecke', () => {
  const cls2 = regatta.addClass('YS90', 90);
  const c = store.createTracker('Schnell');
  const d = store.createTracker('Langsam');
  regatta.registerBoat(c.id, { sailNo: '7', helm: 'c', classId: cls2.id });
  regatta.registerBoat(d.id, { sailNo: '8', helm: 'd', classId: cls2.id });
  const T1 = GUN + 5 * 3600000;
  regatta.createCourse({ kind: 'bounce' });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });
  regatta.setCourse([pt(0, 800)], 250, true);
  const loop = (t0, speed, extra) => {
    const out = [];
    let t = t0;
    const wp = [[0, -200], [0, 800 + extra], [0, -200]];
    for (let i = 0; i < wp.length - 1; i += 1) {
      const [x0, y0] = wp[i]; const [x1, y1] = wp[i + 1];
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / speed));
      for (let k = 0; k < n; k += 1) { out.push({ ...pt(x0 + (x1 - x0) * (k / n), y0 + (y1 - y0) * (k / n)), ts: t }); t += 1000; }
    }
    out.push({ ...pt(0, -200), ts: t });
    return out;
  };
  for (const f of loop(T1, 6, 0)) store.recordPosition(c.id, f);            // schnell, direkte Route
  for (const f of loop(T1, 3, 100)) store.recordPosition(d.id, f);          // langsam, Umweg
  const race2 = regatta.createRace({ name: 'Best', laps: 1, lapMode: 'bounce', startTs: T1, cutoffMinutes: 180 });
  const stats = regatta.raceStats(race2.id, T1 + 3 * 3600000);
  const titles = stats.awards.map((a) => a.title);
  assert.ok(titles.includes('Schnellstes Boot (gesegelte Zeit)'));
  const fastest = stats.awards.find((a) => a.title === 'Schnellstes Boot (gesegelte Zeit)');
  assert.ok(fastest.boat.includes('Schnell'));
  const maxs = stats.awards.find((a) => a.title === 'Hoechstgeschwindigkeit');
  assert.ok(maxs.value > 10 && maxs.value < 13, `max ${maxs.value}`);                 // 6 m/s = 11,7 kn
  const shortest = stats.awards.find((a) => a.title === 'Kuerzeste Strecke');
  assert.ok(shortest.boat.includes('Schnell') && shortest.value > 1500 && shortest.value < 1700, JSON.stringify(shortest));   // 2 x 800 m zwischen Start- und Zieldurchgang
});

test('Ergebnis: entry.quality je Boot; Luecke am Ziel gibt Warnung, Rangfolge bleibt nach der Zeit', () => {
  const cls3 = regatta.addClass('YS100b', 100);
  const e = store.createTracker('Luecke');
  const f = store.createTracker('Sauber');
  regatta.registerBoat(e.id, { sailNo: '11', helm: 'e', classId: cls3.id });
  regatta.registerBoat(f.id, { sailNo: '12', helm: 'f', classId: cls3.id });
  const T2 = GUN + 10 * 3600000;
  regatta.createCourse({ kind: 'bounce' });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });
  regatta.setCourse([pt(0, 800)], 250, true);
  // Hin zur Boje und zurueck durch die Linie, 1 Punkt pro Sekunde, Genauigkeit 4 m
  const leg = (t0, speed) => {
    const out = [];
    let t = t0;
    for (const [y0, y1] of [[-200, 800], [800, -200]]) {
      const n = Math.round(Math.abs(y1 - y0) / speed);
      for (let k = 0; k < n; k += 1) { out.push({ ...pt(0, y0 + (y1 - y0) * (k / n)), ts: t, accuracy: 4, back: y1 < y0 }); t += 1000; }
    }
    out.push({ ...pt(0, -200), ts: t, accuracy: 4, back: true });
    return out;
  };
  // "Luecke" ist schneller (6 m/s), hat aber auf dem Rueckweg keine Punkte zwischen y = -84 und +84 m: 28 s Luecke um den Zieldurchgang
  for (const p of leg(T2, 6)) {
    const y = (p.lat - lat0) * mLat;
    if (p.back && Math.abs(y) < 84) continue;
    const { back, ...fix } = p;
    store.recordPosition(e.id, fix);
  }
  for (const p of leg(T2, 4)) { const { back, ...fix } = p; store.recordPosition(f.id, fix); }
  const race3 = regatta.createRace({ name: 'Qualitaet', laps: 1, lapMode: 'bounce', startTs: T2, cutoffMinutes: 60 });
  const res = regatta.computeResults(race3, T2 + 2 * 3600000);
  const ee = res.entries.find((x) => x.trackerId === e.id);
  const ef = res.entries.find((x) => x.trackerId === f.id);

  // Wertung unveraendert: beide im Ziel, das schnellere Boot vorn - trotz roter Datenqualitaet
  assert.strictEqual(ee.status, 'FIN');
  assert.strictEqual(ef.status, 'FIN');
  assert.ok(ee.elapsedSec < ef.elapsedSec);
  assert.strictEqual(ee.rank, 1);
  assert.strictEqual(ef.rank, 2);

  assert.ok(ee.quality && ef.quality, 'jeder Eintrag hat quality');
  assert.strictEqual(ef.quality.level, 'ok', ef.quality.reasons.join('; '));
  assert.ok(!ef.warnings.some((w) => /Datenqualität/.test(w)));
  assert.strictEqual(ee.quality.level, 'bad');
  assert.ok(ee.quality.metrics.gapAtEventsSec >= 27, `Luecke ${ee.quality.metrics.gapAtEventsSec}`);
  assert.ok(ee.warnings.some((w) => /^Datenqualität rot: .*am Ziel.* - bitte prüfen$/.test(w)), ee.warnings.join(' | '));
  assert.ok(ee.warnings.some((w) => /Zieldurchgang unsicher/.test(w)), 'bestehende Warnung bleibt');

  // Boote anderer Klassen/Tests ohne Daten in diesem Zeitfenster: quality vorhanden, aber keine zusaetzliche Warnung
  const silent = res.entries.filter((x) => x.quality && x.quality.metrics.pointsRaw === 0);
  assert.ok(silent.every((x) => !x.warnings.some((w) => /Datenqualität/.test(w))));

  // Live-Karte: Qualitaet aller Boote kommt mit dem Best-of
  const stats = regatta.raceStats(race3.id, T2 + 2 * 3600000);
  assert.strictEqual(stats.quality[e.id].level, 'bad');
  assert.strictEqual(stats.quality[f.id].level, 'ok');
});
