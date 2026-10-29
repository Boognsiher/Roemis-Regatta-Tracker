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

  const r1 = regatta.createRace({ name: 'Lauf 1', laps: 2, startTs: gun1, cutoffMinutes: 30 });
  const r2 = regatta.createRace({ name: 'Lauf 2', laps: 2, startTs: gun2, cutoffMinutes: 30 });
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
  const r3 = regatta.createRace({ name: 'Lauf 1 kurz', laps: 4, startTs: gun1, cutoffMinutes: 30 });
  const e3 = regatta.computeResults(r3).entries[0];
  assert.strictEqual(e3.status, 'DNF');
  assert.strictEqual(e3.laps.length, 2);               // nur die 2 Runden von Lauf 1, nicht die aus Lauf 2
  const r4 = regatta.createRace({ name: 'Lauf 1 lang', laps: 4, startTs: gun1, cutoffMinutes: 120 });
  assert.strictEqual(regatta.computeResults(r4).entries[0].laps.length, 4);  // ohne engen Zielschluss zaehlt Lauf 2 mit

  // Zielschluss nachtraeglich aendern
  regatta.updateRace(r4.id, { cutoffMinutes: 30 });
  assert.strictEqual(regatta.computeResults(r4).entries[0].laps.length, 2);
});

test('Wettfahrt ohne Linie kann nicht mit Startzeit angelegt werden; Geometrie uebernehmen', () => {
  const savedLine = regatta.state.line;
  regatta.state.line = null;
  assert.throws(() => regatta.createRace({ name: 'x', startTs: 1000 }), /linie/i);
  regatta.state.line = savedLine;
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
