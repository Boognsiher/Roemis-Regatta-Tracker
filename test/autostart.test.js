'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-auto-'));
const store = require('../server/store');
const regatta = require('../server/regatta');
const timing = require('../server/timing');
const autostart = require('../server/autostart');

const lat0 = 46.84, lon0 = 10.52;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon });
const START = { a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) };
const GUN = Date.UTC(2026, 6, 4, 9, 0, 0);

function drive(wp, t0, speed = 4) {
  const out = [];
  let t = t0;
  for (let i = 0; i < wp.length - 1; i += 1) {
    const [x0, y0] = wp[i]; const [x1, y1] = wp[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / speed));
    for (let k = 0; k < n; k += 1) { out.push({ ...pt(x0 + (x1 - x0) * (k / n), y0 + (y1 - y0) * (k / n)), ts: t, speed }); t += 1000; }
  }
  const [xl, yl] = wp[wp.length - 1];
  out.push({ ...pt(xl, yl), ts: t, speed });
  return out;
}
const RACE_PATH = [[0, -200], [0, 800], [0, -200]];      // von Sueden ueber die Linie, Boje, zurueck ueber die Linie (= Ziel)

test('Start-Kandidaten: abgebrochener Start (sofort zurueck) zaehlt nicht, echter Start schon', () => {
  const pl = timing.prepareLine(START);
  const fixes = [
    ...drive([[0, -100], [0, 40], [0, -100]], GUN - 300000),     // Probe-Querung, sofort zurueck
    ...drive(RACE_PATH, GUN)
  ];
  const c = autostart.boatStartCandidates(pl, fixes, { minLapSeconds: 120 });
  assert.strictEqual(c.length, 1);
  assert.ok(Math.abs(c[0] - (GUN + 50000)) < 2000);
});

test('Klassenstart: dichtester Pulk gewinnt, Nachzuegler und Fruehquerung werden einzeln behandelt, final erst nach Wartezeit', () => {
  const cands = { a: [GUN - 400000, GUN], b: [GUN + 5000], c: [GUN + 8000], d: [GUN + 900000] };
  const early = autostart.detectClassStart(cands, GUN + 60000);
  assert.strictEqual(early.ts, GUN);
  assert.strictEqual(early.final, false);
  assert.deepStrictEqual(early.boats.sort(), ['a', 'b', 'c']);
  const fin = autostart.detectClassStart(cands, GUN + 400000);
  assert.strictEqual(fin.final, true);
  assert.strictEqual(autostart.detectClassStart({ a: [] }, GUN).ts, null);
  assert.strictEqual(autostart.detectClassStart({ a: [GUN] }, GUN, { complete: true }).final, true);
});

test('Wettfahrt automatisch: Klassen starten versetzt, Zeit je Klasse ab eigenem Start, Ende bei letztem Boot im Ziel', () => {
  const A = regatta.addClass('KlasseA', 100);
  const B = regatta.addClass('KlasseB', 100);
  const t1 = store.createTracker('A1'); const t2 = store.createTracker('A2'); const t3 = store.createTracker('B1');
  regatta.registerBoat(t1.id, { sailNo: '1', helm: 'a', classId: A.id });
  regatta.registerBoat(t2.id, { sailNo: '2', helm: 'b', classId: A.id });
  regatta.registerBoat(t3.id, { sailNo: '3', helm: 'c', classId: B.id });
  regatta.createCourse({ kind: 'windward' });
  regatta.setLine(START);
  regatta.setCourse([pt(0, 800)], 250, true);

  const GUN_B = GUN + 600000;
  for (const f of drive(RACE_PATH, GUN)) store.recordPosition(t1.id, f);
  for (const f of drive(RACE_PATH, GUN + 6000)) store.recordPosition(t2.id, f);
  for (const f of [...drive([[0, -100], [0, 40], [0, -100]], GUN_B - 240000), ...drive(RACE_PATH, GUN_B)]) store.recordPosition(t3.id, f);

  const race = regatta.createRace({ name: 'Auto', laps: 1, lapMode: 'bounce', auto: true, autoFrom: GUN - 900000, cutoffMinutes: 120 });
  assert.strictEqual(race.auto, true);
  assert.strictEqual(race.startTs, null);

  // Vor dem Start: nichts erkannt
  let res = regatta.computeResults(race, GUN - 60000);
  assert.strictEqual(race.startTs, null);
  assert.ok(res.race.classes.every((c) => c.phase === 'WAIT'));

  // Kurz nach dem Pulk der Klasse A: Start erkannt, aber noch nicht endgueltig
  const gunA = GUN + 50000;                                                  // Querung der Linie bei y=0 nach 200 m
  res = regatta.computeResults(race, gunA + 70000);
  let ca = res.race.classes.find((c) => c.name === 'KlasseA');
  assert.strictEqual(ca.phase, 'STARTING');
  assert.ok(Math.abs(ca.startTs - gunA) < 2000);
  assert.strictEqual(res.race.classes.find((c) => c.name === 'KlasseB').phase, 'WAIT');

  // Spaeter: A endgueltig und im Ziel -> Klasse A beendet ("alle im Ziel"), B noch nicht gestartet
  res = regatta.computeResults(race, GUN + 1200000 - 400000);
  ca = res.race.classes.find((c) => c.name === 'KlasseA');
  assert.strictEqual(ca.startFinal, true);
  assert.strictEqual(ca.phase, 'DONE');
  assert.strictEqual(ca.endReason, 'alle im Ziel');

  // Ganz am Ende: B wurde einzeln gestartet (Probe-Querung zaehlt nicht), eigene Startzeit
  res = regatta.computeResults(race, GUN_B + 3600000);
  const cb = res.race.classes.find((c) => c.name === 'KlasseB');
  assert.ok(Math.abs(cb.startTs - (GUN_B + 50000)) < 2000, `Start B ${cb.startTs - GUN_B}`);
  assert.strictEqual(cb.phase, 'DONE');
  const e3 = res.entries.find((e) => e.trackerId === t3.id);
  const e1 = res.entries.find((e) => e.trackerId === t1.id);
  const e2 = res.entries.find((e) => e.trackerId === t2.id);
  assert.strictEqual(e3.status, 'FIN');
  assert.strictEqual(e1.status, 'FIN');
  // Gleicher Weg, gleiche Fahrzeit: Zeit ab Klassenstart, nicht ab Wettfahrtstart
  assert.ok(Math.abs(e3.elapsedSec - e1.elapsedSec) < 3, `${e3.elapsedSec} vs ${e1.elapsedSec}`);
  assert.ok(e2.elapsedSec > e1.elapsedSec);                                // 6 s spaeter gequert
  assert.strictEqual(regatta.isRunning(race, GUN_B + 3600000), false);

  // Live: pro Klasse eigene Startzeit, Rang ueber alle
  const live = regatta.getLive(race.id, GUN_B + 120000);
  assert.ok(live.entries.length === 3);
  assert.strictEqual(live.race.auto, true);
});

test('Manueller Start schaltet die automatische Erkennung ab', () => {
  const r = regatta.createRace({ name: 'Auto2', laps: 1, auto: true });
  const s = regatta.startRace(r.id, GUN);
  assert.strictEqual(s.auto, false);
  assert.strictEqual(s.startTs, GUN);
});
