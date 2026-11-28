'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boatQuality, qualityWarning, filterSteps, QUALITY } = require('../server/quality');
const timing = require('../server/timing');

const lat0 = 47.23, lon0 = 8.75;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const T0 = Date.UTC(2026, 10, 28, 10, 0, 0);

/** Simulierte Spur: Boot faehrt mit 3 m/s nach Norden, alle stepSec ein Punkt. extra(i, f) darf den Punkt aendern (null = weglassen). */
function track({ durSec = 1200, stepSec = 2, acc = 4, src = 'gw', speed = null, extra = null } = {}) {
  const out = [];
  for (let i = 0, t = 0; t <= durSec; i += 1, t += stepSec) {
    let f = { ts: T0 + t * 1000, lat: lat0 + (3 * t) / mLat, lon: lon0, accuracy: acc, speed, src };
    if (extra) f = extra(i, f);
    if (f) out.push(f);
  }
  return out;
}
const FROM = T0 + 60000;
const TO = T0 + 1140000;
const EVENTS = [{ label: 'Start', ts: FROM }, { label: 'Boje 1', ts: T0 + 600000 }, { label: 'Ziel', ts: TO }];

test('Datenqualitaet: gute Spur (2-s-Takt, 4 m) ist gruen', () => {
  const q = boatQuality({ fixesRaw: track(), from: FROM, to: TO, events: EVENTS });
  assert.strictEqual(q.level, 'ok', q.reasons.join('; '));
  assert.deepStrictEqual(q.reasons, []);
  assert.ok(Math.abs(q.metrics.rateSec - 2) < 0.01);
  assert.strictEqual(q.metrics.maxGapSec, 2);
  assert.strictEqual(q.metrics.gapAtEventsSec, 2);
  assert.strictEqual(q.metrics.medianAccuracyM, 4);
  assert.strictEqual(q.metrics.droppedShare, 0);
  assert.strictEqual(q.source, 'tracker');
  assert.strictEqual(qualityWarning(q), null);
});

test('Datenqualitaet: Luecke von 28 s am Ziel ist rot und nennt das Ziel', () => {
  // Punkte zwischen Ziel - 14 s und Ziel + 14 s fehlen -> 28 s Luecke um den Zieldurchgang
  const fixes = track({ extra: (i, f) => (f.ts > TO - 14000 && f.ts < TO + 14000 ? null : f) });
  const q = boatQuality({ fixesRaw: fixes, from: FROM, to: TO, events: EVENTS });
  assert.strictEqual(q.level, 'bad');
  assert.strictEqual(q.metrics.gapAtEventsSec, 28);
  assert.strictEqual(q.metrics.gapAtEventLabel, 'Ziel');
  assert.ok(q.reasons.includes('Lücke von 28 s am Ziel'), q.reasons.join('; '));
  assert.match(qualityWarning(q), /^Datenqualität rot: .*Lücke von 28 s am Ziel.* - bitte prüfen$/);
});

test('Datenqualitaet: Handy-Spur mit vielen Positionen > 50 m -> hoher Verwurf, gelb oder rot', () => {
  // Handy (5 s, mit Tempo), jede 3. Position springt auf 300 m Genauigkeit -> ~33 % verworfen
  const fixes = track({ stepSec: 5, speed: 3, src: 'own', acc: 5, extra: (i, f) => (i % 3 === 0 ? { ...f, accuracy: 300 } : f) });
  const q = boatQuality({ fixesRaw: fixes, from: FROM, to: TO, events: EVENTS });
  assert.ok(['warn', 'bad'].includes(q.level), q.level);
  assert.ok(q.metrics.droppedShare > 0.3, `droppedShare ${q.metrics.droppedShare}`);
  assert.ok(q.metrics.dropped.accuracy > 0);
  assert.strictEqual(q.source, 'handy');
  assert.ok(q.reasons.some((r) => /der Punkte verworfen \(schlechte Genauigkeit\)/.test(r)), q.reasons.join('; '));
});

test('Datenqualitaet: Gateway-Spur mit Handy in einer Luecke -> Quelle "gemischt"; Zweitquelle allein macht nicht gelb', () => {
  // T-Beam (gw) jede Sekunde, Handy (own) alle 5 s darueber; in Minute 8-11 faellt der T-Beam aus, dort bleibt nur das Handy
  const gw = track({ stepSec: 1, src: 'gw', extra: (i, f) => (f.ts >= T0 + 480000 && f.ts < T0 + 660000 ? null : f) });
  const own = track({ stepSec: 5, src: 'own', speed: 3 }).map((f) => ({ ...f, ts: f.ts + 300 }));
  const q = boatQuality({ fixesRaw: gw.concat(own), from: FROM, to: TO, events: EVENTS });
  assert.strictEqual(q.source, 'gemischt');
  assert.ok(q.metrics.dropped.shadow > 0, 'Handy-Punkte neben dem T-Beam werden als Zweitquelle verworfen');
  assert.ok(q.metrics.droppedShare > QUALITY.warn.droppedShare, 'droppedShare enthaelt die Zweitquelle');
  assert.strictEqual(q.level, 'ok', q.reasons.join('; '));   // die Zweitquelle ist Redundanz, kein Datenmangel
});

test('Datenqualitaet: leere oder zu kurze Spur liefert ein Ergebnis ohne Absturz', () => {
  const empty = boatQuality({ fixesRaw: [], from: FROM, to: TO, events: EVENTS });
  assert.strictEqual(empty.level, 'bad');
  assert.deepStrictEqual(empty.reasons, ['Keine Positionen im Zeitfenster der Wettfahrt']);
  assert.strictEqual(empty.source, null);

  const one = boatQuality({ fixesRaw: [{ ts: FROM + 1000, lat: lat0, lon: lon0, accuracy: 4 }], from: FROM, to: TO, events: [] });
  assert.strictEqual(one.level, 'bad');
  assert.strictEqual(one.metrics.rateSec, null);
  assert.ok(one.reasons.some((r) => /Nur 1 brauchbare Position/.test(r)));

  const noWindow = boatQuality({ fixesRaw: track(), from: null, to: TO });
  assert.strictEqual(noWindow.level, 'bad');
  assert.doesNotThrow(() => boatQuality());
});

test('Datenqualitaet: Tracker faellt vor dem Zielschluss aus -> Rand-Luecke wird gemeldet', () => {
  const fixes = track({ durSec: 600 });        // Daten nur bis Minute 10, Zeitfenster bis Minute 19
  const q = boatQuality({ fixesRaw: fixes, from: FROM, to: TO, events: [{ label: 'Start', ts: FROM }] });
  assert.strictEqual(q.level, 'bad');
  assert.ok(q.reasons.some((r) => /Keine Positionen in den letzten 9 min vor dem Zielschluss/.test(r)), q.reasons.join('; '));
});

test('Datenqualitaet: Filter-Aufschluesselung entspricht genau timing.normalizeFixes', () => {
  const gw = track({ stepSec: 1, src: 'gw', extra: (i, f) => (i % 7 === 0 ? { ...f, accuracy: 120 } : f) });
  const own = track({ stepSec: 5, src: 'own', speed: 0.1 }).map((f) => ({ ...f, ts: f.ts + 300 }));
  const raw = gw.concat(own, own.slice(0, 5));          // inkl. doppelter Zeitstempel
  assert.deepStrictEqual(filterSteps(raw).clean, timing.normalizeFixes(raw));
});
