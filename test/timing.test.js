'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../server/timing');

// Linie 100 m lang in Ost-West-Richtung bei lat 47, Kursseite = Norden.
const lat0 = 47;
const lon0 = 8;
const mPerDegLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mPerDegLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mPerDegLat, lon: lon0 + x / mPerDegLon });
const line = { a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 500) };
const pl = T.prepareLine(line);
const fix = (ts, x, y) => ({ ts, ...pt(x, y) });

// Boot segelt nach Norden, wendet, kommt zurueck (Runde = 200 s), 2 Runden.
function boatTrack(offsetMs = 0) {
  const fixes = [];
  // Start bei t=0 (Startsignal), Boot 20 m vor der Linie (y=-20), 2 m/s Nord.
  const gun = 100000;
  for (let t = -30; t <= 500; t += 2) {
    const ts = gun + offsetMs + t * 1000;
    const phase = ((t + 10) % 200 + 200) % 200; // 0..200 pro Runde, y=-20 bei Rundenstart
    let y;
    if (t < -10) y = -20 - (-10 - t) * 0; // wartet vor der Linie
    else if (phase < 100) y = -20 + phase * 2;
    else y = -20 + (200 - phase) * 2;
    fixes.push(fix(ts, 0, y));
  }
  return { gun, fixes };
}

test('Interpolation der Durchgangszeit', () => {
  const c = T.findCrossings(pl, [fix(0, 0, -5), fix(5000, 0, 5), fix(10000, 0, -5)]);
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].dir, 'start');
  assert.ok(Math.abs(c[0].ts - 2500) < 5);
  assert.strictEqual(c[1].dir, 'finish');
  assert.ok(Math.abs(c[1].ts - 7500) < 5);
});

test('Durchgang ausserhalb der Linie zaehlt nicht', () => {
  const c = T.findCrossings(pl, [fix(0, 80, -5), fix(5000, 80, 5)]);
  assert.strictEqual(c.length, 0);
});

test('Zwei Runden: Zielzeit und Yardstick', () => {
  const { gun, fixes } = boatTrack();
  const r = T.analyzeBoat(pl, fixes, { startTs: gun, laps: 2, minLapSeconds: 60 });
  assert.strictEqual(r.status, 'FIN');
  assert.strictEqual(r.laps.length, 2);
  // Rundenstart bei t=-10 -> Linie bei phase 10 (y=0) = t=0 ... Zieldurchgang bei phase 190.. = t=180 bzw. 380
  assert.ok(Math.abs(r.laps[1].ts - (gun + 380000)) < 1000, String(r.laps[1].ts - gun));
  assert.ok(Math.abs(T.correctedSeconds(380, 95) - 400) < 0.01);
});

test('DNF bei nur einer Runde, DNS ohne Daten', () => {
  const { gun, fixes } = boatTrack();
  const part = fixes.filter((f) => f.ts < gun + 300000);
  assert.strictEqual(T.analyzeBoat(pl, part, { startTs: gun, laps: 2, minLapSeconds: 60 }).status, 'DNF');
  assert.strictEqual(T.analyzeBoat(pl, [], { startTs: gun, laps: 2, minLapSeconds: 60 }).status, 'DNS');
});

test('GPS-Zittern am Ziel erzeugt keine zusaetzliche Runde', () => {
  const { gun, fixes } = boatTrack();
  // Nach Ende von Runde 1 (t~180) hin- und herzittern um die Linie
  const jitter = [fix(gun + 181000, 0, -1), fix(gun + 182000, 0, 1), fix(gun + 183000, 0, -1)];
  const all = fixes.concat(jitter);
  const r = T.analyzeBoat(pl, all, { startTs: gun, laps: 2, minLapSeconds: 60 });
  assert.ok(r.laps.length <= 2);
  assert.ok(Math.abs(r.laps[0].ts - (gun + 180000)) < 3000);
});

test('Ranking nach berechneter Zeit, Gleichstand', () => {
  const e = [{ correctedSec: 400.2 }, { correctedSec: 399.6 }, { correctedSec: 400 }, { correctedSec: null }];
  T.rankEntries(e);
  assert.deepStrictEqual(e.map((x) => x.rank), [1, 1, 1, null]);
});
