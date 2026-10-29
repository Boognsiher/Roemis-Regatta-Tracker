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

// ---- Rundkurs: Linie wird jede Runde in DIESELBE Richtung gekreuzt ----
function pathFixes(path, v, gunTs, until, jitter = []) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) { const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); seg.push(d); total += d; }
  const out = [];
  for (let t = -30; t <= until; t += 1) {
    let dd = Math.max(0, Math.min(total, t * v));
    let i = 0;
    while (i < seg.length - 1 && dd > seg[i]) { dd -= seg[i]; i += 1; }
    const f = seg[i] ? dd / seg[i] : 0;
    out.push({ ...pt(path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f), ts: gunTs + t * 1000 });
  }
  return out.concat(jitter);
}
const LOOP = [[0, -100], [0, 600], [300, 600], [300, -100], [0, -100], [0, 600], [300, 600], [300, -100], [0, -100], [0, 300]];

test('Rundkurs (loop): Start = 1. Durchgang, Runde 1 = 2., Ziel nach Runde 2 = 3. Durchgang; Rueckweg ausserhalb der Linie stoert nicht', () => {
  const fixes = pathFixes(LOOP, 4, 100000, 1200);
  const r = T.analyzeBoat(pl, fixes, { startTs: 100000, laps: 2, minLapSeconds: 60, lapMode: 'loop' });
  assert.strictEqual(r.status, 'FIN');
  assert.strictEqual(r.laps.length, 2);
  // Rechteck 700 + 300 + 700 + 300 = 2000 m je Runde bei 4 m/s = 500 s; Start-Durchgang bei y=0 -> t=25 s
  assert.ok(Math.abs(r.laps[0].ts - (100000 + 525000)) < 2000, String(r.laps[0].ts - 100000));
  assert.ok(Math.abs(r.laps[1].ts - (100000 + 1025000)) < 2000, String(r.laps[1].ts - 100000));
  assert.ok(Math.abs(r.elapsedSec - 1025) < 3);
});

test('Rundkurs-Daten im Modus "bounce": keine Runden, aber verstaendliche Warnung zu Durchgaengen ausserhalb der Marken', () => {
  const fixes = pathFixes(LOOP, 4, 100000, 1200);
  const r = T.analyzeBoat(pl, fixes, { startTs: 100000, laps: 2, minLapSeconds: 60 });
  assert.strictEqual(r.status, 'DNF');
  assert.strictEqual(r.laps.length, 0);
  assert.ok(r.warnings.some((w) => /ausserhalb der Linien-Marken/.test(w)), r.warnings.join(' | '));
});

test('Rundkurs: GPS-Zittern direkt nach einem Durchgang erzeugt keine zusaetzliche Runde', () => {
  const dither = [];
  // kurz nach dem Durchgang von Runde 1 (t = 525 s) zittert das Boot noch dreimal ueber die Linie
  for (const [dt, y] of [[527, -3], [529, 3], [531, -3], [533, 3], [535, 20]]) dither.push({ ...pt(0, y), ts: 100000 + dt * 1000 });
  const base = pathFixes(LOOP, 4, 100000, 1200).filter((f) => f.ts < 100000 + 526000 || f.ts > 100000 + 536000);
  const r = T.analyzeBoat(pl, base.concat(dither), { startTs: 100000, laps: 2, minLapSeconds: 60, lapMode: 'loop' });
  assert.strictEqual(r.status, 'FIN');
  assert.strictEqual(r.laps.length, 2);
  assert.ok(Math.abs(r.laps[1].ts - (100000 + 1025000)) < 3000);
});

test('Zu kurze Linie: Boot kreuzt knapp ausserhalb der Marken -> Warnung nennt den Abstand', () => {
  // Linie nur 20 m lang (x -10..10), Boot faehrt bei x = 30 hin und her
  const shortLine = T.prepareLine({ a: pt(-10, 0), b: pt(10, 0), mark: pt(0, 400) });
  const path = [[30, -100], [30, 300], [30, -100]];
  const fixes = pathFixes(path, 4, 100000, 220);
  const r = T.analyzeBoat(shortLine, fixes, { startTs: 100000, laps: 1, minLapSeconds: 30 });
  assert.strictEqual(r.status, 'DNF');
  assert.ok(r.warnings.some((w) => /nur 20 m daneben/.test(w)), r.warnings.join(' | '));
});

// ---- Linienregeln: Start der 1. Runde darf in der Verlaengerung liegen, alles andere nur zwischen den Marken ----
// Pfad (2 Runden): Start Runde 1 bei x = s1, Rueckweg (Ziel Runde 1) bei x = f, Start Runde 2 bei x = s2, Ziel Runde 2 bei x = f
function twoLapPath(s1, s2, f) {
  return [[s1, -100], [s1, 300], [f, 300], [f, -100], [s2, -100], [s2, 300], [f, 300], [f, -100]];
}
const bounceOpts = { startTs: 100000, laps: 2, minLapSeconds: 60 };
const run = (path, opts = {}, until = 1000) => T.analyzeBoat(pl, pathFixes(path, 4, 100000, until), { ...bounceOpts, ...opts });

test('Standard: auch der Start muss zwischen den Marken liegen (Verlaengerung zaehlt nicht)', () => {
  const r = run(twoLapPath(80, 0, 0));
  assert.strictEqual(r.status, 'DNF');
  assert.strictEqual(r.laps.length, 1);          // Start Runde 1 ungueltig -> erst der 2. Aufstieg gilt als Start, nur 1 Runde bis zum Ende
});

test('Optional: Start der 1. Runde in der Verlaengerung (30 m hinter dem Ende) zaehlt; Start Runde 2 und beide Ziele zwischen den Marken -> 2 Runden', () => {
  const r = run(twoLapPath(80, 0, 0), { startOnExtension: true });
  assert.strictEqual(r.status, 'FIN');
  assert.strictEqual(r.laps.length, 2);
  assert.ok(r.laps[0].lapSeconds > 100 && r.laps[1].lapSeconds > 100);
  assert.deepStrictEqual(r.warnings, []);
});

test('Start der 2. Runde in der Verlaengerung zaehlt NICHT (auch wenn die Verlaengerung erlaubt ist): Warnung nennt die Runde', () => {
  const r = run(twoLapPath(80, 80, 0), { startOnExtension: true });
  assert.strictEqual(r.status, 'DNF');
  assert.strictEqual(r.laps.length, 1);                              // Runde 1 ist gueltig
  assert.ok(r.warnings.some((w) => /Start der Runde 2 in der Verlaengerung/.test(w) && /30 m/.test(w)), r.warnings.join(' | '));
});

test('Ziel (Ende der Runde) ausserhalb der Marken zaehlt NICHT, mit Warnung', () => {
  const r = run(twoLapPath(0, 0, 80));
  assert.strictEqual(r.status, 'DNF');
  assert.strictEqual(r.laps.length, 0);
  assert.ok(r.warnings.some((w) => /beim Zieldurchgang/.test(w) && /30 m daneben/.test(w)), r.warnings.join(' | '));
});

test('Verlaengerung nur bis 400 m und nur, wenn die Wettfahrt es erlaubt', () => {
  assert.strictEqual(run(twoLapPath(600, 0, 0), { startOnExtension: true }, 1300).status, 'DNF');   // zu weit weg
  assert.strictEqual(run(twoLapPath(80, 0, 0), { startOnExtension: false }).status, 'DNF'); // abgeschaltet (Standard)
  assert.strictEqual(run(twoLapPath(80, 0, 0), { startOnExtension: true }).status, 'FIN');
});

test('Kleine GPS-Toleranz (3 m) an den Marken, nicht mehr', () => {
  assert.strictEqual(run(twoLapPath(0, 0, 52)).status, 'FIN');      // Ziel 2 m ausserhalb
  assert.strictEqual(run(twoLapPath(0, 0, 55)).status, 'DNF');      // Ziel 5 m ausserhalb
  assert.strictEqual(run(twoLapPath(52, 52, 0)).status, 'FIN');     // Starts 2 m ausserhalb zaehlen noch als "zwischen den Marken"
});

test('Rundkurs-Modus nutzt die Verlaengerung NICHT (jeder Durchgang muss zwischen den Marken liegen)', () => {
  const fixes = pathFixes([[80, -100], [80, 300], [300, 300], [300, -100], [80, -100], [80, 300]], 4, 100000, 600);
  const r = T.analyzeBoat(pl, fixes, { ...bounceOpts, lapMode: 'loop' });
  assert.strictEqual(r.status, 'DNF');
  assert.strictEqual(r.laps.length, 0);
});


// ---- Rundkurs: Verlaengerungs-Durchgaenge als Runden-Anzeiger ----
// LOOP: Aufstieg bei x = 0 (zwischen den Marken), Abstieg bei x = 300 (250 m neben dem Ende: Verlaengerung der Linie)
const loopOpts = { startTs: 100000, laps: 2, minLapSeconds: 60, lapMode: 'loop' };

test('Rundkurs: jeder Abstieg ueber die Verlaengerung wird gezaehlt, Runde stimmt mit den Durchgaengen ueberein', () => {
  const full = T.analyzeBoat(pl, pathFixes(LOOP, 4, 100000, 1200), loopOpts);
  assert.strictEqual(full.status, 'FIN');
  assert.deepStrictEqual([full.lapInfo.completed, full.lapInfo.extensionPasses, full.lapInfo.missingPasses, full.lapInfo.uncertain, full.lapInfo.current], [2, 2, 0, false, 2]);
  // mitten in Runde 1, nach dem Abstieg bei x = 300 (t ca. 25 + 700/4 + 300/4 + 700/4 = ~450 s): Runde 1, ein Verlaengerungs-Durchgang
  const mid = T.analyzeBoat(pl, pathFixes(LOOP, 4, 100000, 460), loopOpts);
  assert.strictEqual(mid.lapInfo.extensionPasses, 1);
  assert.strictEqual(mid.lapInfo.current, 1);
  assert.strictEqual(mid.lapInfo.uncertain, false);
  // kurz nach dem Ende der Runde 1 (Durchgang zwischen den Marken bei ca. 525 s): Runde 2
  const lap2 = T.analyzeBoat(pl, pathFixes(LOOP, 4, 100000, 540), loopOpts);
  assert.strictEqual(lap2.lapInfo.completed, 1);
  assert.strictEqual(lap2.lapInfo.current, 2);
});

test('Rundkurs: fehlt ein Durchgang zwischen den Marken, zeigt die Verlaengerung die Runde an und es gibt eine Warnung', () => {
  // 2. Aufstieg bei x = 80 (30 m neben dem Ende) statt zwischen den Marken -> Ende der Runde 1 zaehlt nicht
  const path = [[0, -100], [0, 600], [300, 600], [300, -100], [80, -100], [80, 600], [300, 600], [300, -100], [0, -100], [0, 300]];
  const r = T.analyzeBoat(pl, pathFixes(path, 4, 100000, 1200), loopOpts);
  assert.strictEqual(r.status, 'DNF');
  assert.strictEqual(r.laps.length, 1);                      // nur der Durchgang am Schluss (x = 0) zaehlt als Ende der Runde 1
  assert.strictEqual(r.lapInfo.extensionPasses, 2);
  assert.strictEqual(r.lapInfo.missingPasses, 1);            // zwei Abstiege ohne gueltigen Durchgang dazwischen
  assert.strictEqual(r.lapInfo.uncertain, true);
  assert.strictEqual(r.lapInfo.current, 2);                  // 1 gezaehlt + 1 fehlend + 1, begrenzt auf 2 Runden
  assert.ok(r.warnings.some((w) => /zeigen Runde 2 an/.test(w) && /fehlen/.test(w)), r.warnings.join(' | '));
});

test('Rundkurs mit erlaubtem Start in der Verlaengerung: nur der erste Durchgang, spaetere zaehlen nicht als Rundenende', () => {
  const path = [[80, -100], [80, 600], [300, 600], [300, -100], [80, -100], [80, 600], [300, 600], [300, -100], [0, -100], [0, 300]];
  const r = T.analyzeBoat(pl, pathFixes(path, 4, 100000, 1200), { ...loopOpts, startOnExtension: true });
  assert.strictEqual(r.status, 'DNF');                       // 2. Durchgang bei x = 80 zaehlt nicht
  assert.ok(r.warnings.some((w) => /zaehlt nicht fuer das Ende der Runde 1/.test(w)), r.warnings.join(' | '));
});
