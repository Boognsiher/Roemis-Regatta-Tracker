'use strict';
const test = require('node:test');
const assert = require('node:assert');
const course = require('../server/course');
const timing = require('../server/timing');

const lat0 = 46.84, lon0 = 10.52;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon });
const back = (p) => ({ x: (p.lon - lon0) * mLon, y: (p.lat - lat0) * mLat });

// deterministische Zufallszahlen (Gauss) fuer GPS-Rauschen
function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 1) / 4294967297; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const A = { x: 0, y: 600 };     // Luv-Boje
const B = { x: 300, y: 300 };   // Wing-Boje
const S = { x: 0, y: -25 };     // hinter der Linie
const line = { a: pt(-50, 0), b: pt(50, 0), mark: pt(A.x, A.y) };
const gun = Date.UTC(2025, 5, 14, 9, 0, 0);

// Boot faehrt S -> A -> B -> S (je Runde) mit konstanter Geschwindigkeit, 1 Fix/s, GPS-Rauschen sigma m
function simulate({ v, laps, startDelay = 3, until, seed, sigma = 3, idleAfter = 90 }) {
  const noise = rng(seed);
  const path = [S];
  for (let l = 0; l < laps; l += 1) path.push(A, B, S);
  const seg = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) { const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y); seg.push(d); total += d; }
  const fixes = [];
  const t0 = startDelay;
  const tEnd = Math.min(until, t0 + total / v + idleAfter);
  for (let t = -60; t <= tEnd; t += 1) {
    let dd = t < t0 ? 0 : Math.min(total, (t - t0) * v);
    let i = 0;
    while (i < seg.length - 1 && dd > seg[i]) { dd -= seg[i]; i += 1; }
    const f = seg[i] > 0 ? Math.min(1, dd / seg[i]) : 0;
    const x = path[i].x + (path[i + 1].x - path[i].x) * f + noise() * sigma;
    const y = path[i].y + (path[i + 1].y - path[i].y) * f + noise() * sigma;
    fixes.push({ ...pt(x, y), ts: gun + t * 1000 });
  }
  return fixes;
}

const race = { startTs: gun, laps: 2, minLapSeconds: 120, endTs: gun + 3 * 3600e3 };
// gezeichnete (grobe) Bojenpunkte sind absichtlich um 40-60 m daneben
const drawn = [pt(A.x + 40, A.y - 30), pt(B.x - 50, B.y + 30)];

function boatsAt(until) {
  return [
    { trackerId: 'A', name: 'Alpha', yardstick: 100, v: 4.0, seed: 1 },
    { trackerId: 'B', name: 'Bravo', yardstick: 90, v: 3.6, seed: 2 },
    { trackerId: 'C', name: 'Charlie', yardstick: 120, v: 3.0, seed: 3 }
  ].map((b) => ({ ...b, fixes: simulate({ v: b.v, laps: 2, until, seed: b.seed }) }));
}

test('Bojen werden aus den Logs auf wenige Meter genau gefunden', () => {
  const boats = boatsAt(2000);
  const pl = timing.prepareLine(line);
  const det = course.detectCourse({ pl, race, boatsFixes: boats.map((b) => b.fixes), approxMarks: drawn });
  const m0 = back(det.marks[0]);
  const m1 = back(det.marks[1]);
  assert.ok(Math.hypot(m0.x - A.x, m0.y - A.y) < 15, `Boje 1: ${JSON.stringify(m0)}`);
  assert.ok(Math.hypot(m1.x - B.x, m1.y - B.y) < 15, `Boje 2: ${JSON.stringify(m1)}`);
  assert.ok(det.marks[0].n >= 4 && !det.marks[0].approx);   // 3 Boote x 2 Runden
});

test('ohne Rundungen bleibt die gezeichnete Position (approx)', () => {
  const pl = timing.prepareLine(line);
  const det = course.detectCourse({ pl, race, boatsFixes: [[]], approxMarks: drawn });
  assert.ok(det.marks.every((m) => m.approx));
  const m = back(det.marks[0]);
  assert.ok(Math.hypot(m.x - (A.x + 40), m.y - (A.y - 30)) < 1);
});

test('Live-Rangliste mitten im Rennen: Yardstick ordnet um, vorderstes Boot ist Referenz fuer den Abstand', () => {
  const now = gun + 600 * 1000;
  const boats = boatsAt(600).map((b) => ({ ...b, fixes: b.fixes.filter((f) => f.ts <= now) }));
  const r = course.liveRanking({ line, race, approxMarks: drawn, boats, now });
  assert.strictEqual(r.needsCourse, false);
  assert.ok(Math.abs(r.lapLenM - 1448.6) < 30, `Rundenlaenge ${r.lapLenM}`);
  const byId = Object.fromEntries(r.entries.map((e) => [e.trackerId, e]));
  assert.deepStrictEqual(r.entries.map((e) => e.trackerId), ['A', 'C', 'B']);   // berechnet: A 746 s, C 829 s, B 921 s
  assert.strictEqual(r.leaderId, 'A');
  assert.strictEqual(r.foremostId, 'A');                                          // physisch vorne: A (schnellstes Boot)
  assert.strictEqual(byId.A.gapM, 0);
  assert.ok(byId.B.gapM > 0 && byId.B.gapM < byId.C.gapM);                        // B ist physisch vor C
  assert.ok(byId.A.progressM > byId.B.progressM && byId.B.progressM > byId.C.progressM);
  assert.ok(Math.abs(byId.A.projectedCorrectedSec - 746) < 25, `Prognose A ${byId.A.projectedCorrectedSec}`);
  assert.ok(Math.abs(byId.C.projectedCorrectedSec - 829) < 30, `Prognose C ${byId.C.projectedCorrectedSec}`);
  assert.ok(Math.abs(byId.B.projectedCorrectedSec - 921) < 35, `Prognose B ${byId.B.projectedCorrectedSec}`);
  assert.ok(byId.A.gapCorrectedSec === 0 && byId.C.gapCorrectedSec > 50 && byId.B.gapCorrectedSec > byId.C.gapCorrectedSec);
  assert.ok(byId.A.status === 'RACING' && byId.A.marksDone >= 0);
});

test('Nach dem Ziel: Live-Rangliste stimmt mit der Endwertung ueberein', () => {
  const now = gun + 1500 * 1000;
  const boats = boatsAt(1500);
  const r = course.liveRanking({ line, race, approxMarks: drawn, boats, now });
  assert.ok(r.entries.every((e) => e.status === 'FIN'), JSON.stringify(r.entries.map((e) => e.status)));
  assert.deepStrictEqual(r.entries.map((e) => e.trackerId), ['A', 'C', 'B']);
  const pl = timing.prepareLine(line);
  for (const b of boats) {
    const a = timing.analyzeBoat(pl, b.fixes, race);
    const e = r.entries.find((x) => x.trackerId === b.trackerId);
    assert.ok(Math.abs(e.correctedSec - timing.correctedSeconds(a.elapsedSec, b.yardstick)) < 0.01);
    assert.strictEqual(e.progressPct, 100);
  }
});

test('Fortschritt waechst monoton ueber das Rennen; Vorstart, kein Kurs, keine Daten', () => {
  let prev = -1;
  for (const sec of [30, 120, 240, 360, 480, 600]) {
    const now = gun + sec * 1000;
    const b = { trackerId: 'A', name: 'A', yardstick: 100, fixes: simulate({ v: 4, laps: 2, until: sec, seed: 1 }) };
    const e = course.liveRanking({ line, race, approxMarks: drawn, boats: [b], now }).entries[0];
    assert.ok(e.progressM >= prev - 15, `t=${sec}: ${e.progressM} < ${prev}`);   // Rauschen erlaubt kleine Rueckschritte
    prev = e.progressM;
  }
  const pre = course.liveRanking({ line, race, approxMarks: drawn, now: gun - 10000,
    boats: [{ trackerId: 'P', name: 'P', yardstick: 100, fixes: simulate({ v: 4, laps: 2, until: -5, seed: 4 }).filter((f) => f.ts <= gun - 10000) }] });
  assert.strictEqual(pre.entries[0].status, 'PRESTART');
  assert.strictEqual(course.liveRanking({ line, race, approxMarks: [], boats: [], now: gun + 1000 }).needsCourse, true);
  const none = course.liveRanking({ line, race, approxMarks: drawn, now: gun + 1000, boats: [{ trackerId: 'N', name: 'N', yardstick: 100, fixes: [] }] });
  assert.strictEqual(none.entries[0].status, 'NODATA');
});

// Regression: GPS-Rauschen an der Kreisgrenze darf den "Besuch" nicht abbrechen (sonst wird die echte Wende uebersehen)
test('Rundung wird auch gefunden, wenn das Boot den Suchkreis mit Rauschen an der Grenze betritt', () => {
  const noise = rng(5);
  const pts = [];
  // 1 Hz: anfahren (2 m/s) von (-400,0) bis zur Boje (0,0), dann 90 Grad nach Norden weiter bis (0,400)
  for (let t = 0; t <= 400; t += 1) {
    const s = t * 2;
    const x = s <= 400 ? -400 + s : 0;
    const y = s <= 400 ? 0 : s - 400;
    pts.push({ t: t * 1000, x: x + noise() * 6, y: y + noise() * 6 });
  }
  const marks = [{ x: 0, y: 0 }];
  const ev = course.detectRoundings(pts, marks, 0, Infinity, 250, course.DEFAULTS);
  assert.strictEqual(ev.length, 1);
  assert.ok(Math.hypot(ev[0].x, ev[0].y) < 40, `Rundung bei (${Math.round(ev[0].x)}, ${Math.round(ev[0].y)})`);
  assert.ok(ev[0].turn > 60 && !ev[0].passOnly, `Kursaenderung ${ev[0].turn}`);
});

test('reine Vorbeifahrt weit weg von der Boje zaehlt nicht als Rundung', () => {
  const pts = [];
  for (let t = 0; t <= 300; t += 1) pts.push({ t: t * 1000, x: -300 + t * 2, y: 240 });   // geradeaus in 240 m Abstand
  const ev = course.detectRoundings(pts, [{ x: 0, y: 0 }], 0, Infinity, 250, course.DEFAULTS);
  assert.strictEqual(ev.length, 0);
});

test('exakte Bojenpositionen werden nicht aus den Logs veraendert', () => {
  const boats = boatsAt(900);
  const exactMarks = [pt(A.x + 5, A.y), pt(B.x, B.y - 5)];          // eingegebene Koordinaten (leicht neben der Boje: bleiben stehen)
  const pl = timing.prepareLine(line);
  const det = course.detectCourse({ pl, race, boatsFixes: boats.map((b) => b.fixes), approxMarks: exactMarks, options: { exact: true } });
  assert.ok(det.marks.every((m) => m.exact && !m.approx));
  const m0 = back(det.marks[0]);
  assert.ok(Math.abs(m0.x - (A.x + 5)) < 0.01 && Math.abs(m0.y - A.y) < 0.01);        // unveraendert
  // Die Live-Rangliste funktioniert mit exakten Marken (Rundungen werden trotzdem je Boot erkannt)
  const now = gun + 600 * 1000;
  const live = course.liveRanking({ line, race, approxMarks: exactMarks, boats: boats.map((b) => ({ ...b, fixes: b.fixes.filter((f) => f.ts <= now) })), now, options: { exact: true } });
  assert.deepStrictEqual(live.entries.map((e) => e.trackerId), ['A', 'C', 'B']);
  assert.ok(live.marks.every((m) => m.exact));
});

// ---- Tor (zwei Marken, Durchfahrt zaehlt) ----
const G_MID = { x: 150, y: 137 };                       // Mitte der Strecke B -> S
const G_PERP = { x: 0.735, y: -0.678 };                 // senkrecht dazu
const gateLL = (halfWidth) => ({
  a: pt(G_MID.x - G_PERP.x * halfWidth, G_MID.y - G_PERP.y * halfWidth),
  b: pt(G_MID.x + G_PERP.x * halfWidth, G_MID.y + G_PERP.y * halfWidth)
});

test('gateCrossing: richtige Richtung, zwischen den Marken, mit Toleranz', () => {
  const gate = { ax: -40, ay: 0, bx: 40, by: 0 };
  const approach = { x: 0, y: -100 };                    // Anfahrt von Sued
  const run = (xs, ys) => xs.map((x, i) => ({ t: i * 1000, x, y: ys[i] }));
  const north = run([0, 0, 0, 0], [-30, -10, 10, 30]);  // von Sued nach Nord durch die Mitte
  assert.ok(course.gateCrossing(north, gate, 0, 0, Infinity, approach));
  const south = run([0, 0, 0, 0], [30, 10, -10, -30]);  // falsche Richtung
  assert.strictEqual(course.gateCrossing(south, gate, 0, 0, Infinity, approach), null);
  const outside = run([-90, -90, -90, -90], [-30, -10, 10, 30]);   // links ausserhalb des Tores
  assert.strictEqual(course.gateCrossing(outside, gate, 0, 0, Infinity, approach), null);
  const edge = run([-48, -48, -48, -48], [-30, -10, 10, 30]);      // 8 m ausserhalb: innerhalb der GPS-Toleranz
  assert.ok(course.gateCrossing(edge, gate, 0, 0, Infinity, approach));
  const g = course.gateCrossing(north, gate, 0, 0, Infinity, approach);
  assert.ok(Math.abs(g.t - 1500) < 1 && Math.abs(g.y) < 0.01);     // interpolierte Zeit, auf der Linie
});

test('Kurs mit Boje UND Tor: zwei Runden, Rundungen/Tor-Durchfahrten erkannt, Ergebnis wie ohne Bojen', () => {
  const gate = gateLL(40);
  const approxMarks = [pt(A.x + 30, A.y - 30), gate];
  const boats = boatsAt(2000);
  const pl = timing.prepareLine(line);
  const det = course.detectCourse({ pl, race, boatsFixes: boats.map((b) => b.fixes), approxMarks });
  assert.ok(det.marks[1].gate && det.marks[1].exact);               // Tor bleibt unveraendert
  assert.ok(Math.hypot(back(det.marks[0]).x - A.x, back(det.marks[0]).y - A.y) < 15);   // einzelne Boje wird verfeinert
  // pro Boot und Runde je 2 Ereignisse (Boje, Tor)
  det.perBoat.forEach((b) => b.roundings.forEach((lap) => assert.strictEqual(lap.length, 2, JSON.stringify(lap.map((e) => e.k)))));
  const live = course.liveRanking({ line, race, approxMarks, boats, now: gun + 1500 * 1000 });
  assert.ok(live.entries.every((e) => e.status === 'FIN'));
  assert.deepStrictEqual(live.entries.map((e) => e.trackerId), ['A', 'C', 'B']);
  // Mitten im Rennen: Fortschritt nimmt ueber Boje und Tor hinweg weiter zu
  let prev = -1;
  for (const sec of [60, 150, 250, 350, 450, 550]) {
    const now = gun + sec * 1000;
    const b = { trackerId: 'A', name: 'A', yardstick: 100, fixes: simulate({ v: 4, laps: 2, until: sec, seed: 1 }) };
    const e = course.liveRanking({ line, race, approxMarks, boats: [b], now }).entries[0];
    assert.ok(e.progressM >= prev - 15, `t=${sec}: ${e.progressM} < ${prev}`);
    prev = e.progressM;
  }
});

test('Boot faehrt AUSSEN am Tor vorbei: Tor wird nicht gezaehlt, aber die Runden (Linie) zaehlen trotzdem', () => {
  const narrow = gateLL(8);                                         // sehr enges Tor, Boot faehrt mittig vorbei?  -> breite Verschiebung unten
  const shifted = { a: pt(G_MID.x + 120 - G_PERP.x * 8, G_MID.y - 120 * 0 - G_PERP.y * 8), b: pt(G_MID.x + 120 + G_PERP.x * 8, G_MID.y + G_PERP.y * 8) };
  const boats = boatsAt(1500);
  const pl = timing.prepareLine(line);
  const det = course.detectCourse({ pl, race, boatsFixes: boats.map((b) => b.fixes), approxMarks: [pt(A.x, A.y), shifted] });
  assert.ok(det.perBoat.every((b) => b.roundings.every((lap) => lap.length === 1)));   // nur die Boje, Tor verfehlt
  assert.ok(det.perBoat.every((b) => b.analysis.status === 'FIN'));                    // Wertung haengt nicht von den Marken ab
  void narrow;
});

// ---- Kurs wie in der Skizze der Wettfahrtleitung: Linie in der Mitte, Boje 1 oben, Boje 2 unten ----
// Runde: durch die Linie nach Norden (zwischen den Marken) -> Boje 1 -> ausserhalb der Linie nach Sueden (Verlaengerung) -> Boje 2 -> zurueck zur Linie
const SK_B1 = { x: 0, y: 500 };
const SK_B2 = { x: 100, y: -450 };
const SK_LAP = [[0, -150], [SK_B1.x, SK_B1.y], [260, 250], [260, -250], [SK_B2.x, SK_B2.y], [0, -150]];   // Abstieg bei x = 260 (210 m neben der Linie)
function skPath(laps) {
  const p = [[0, -150]];
  for (let l = 0; l < laps; l += 1) SK_LAP.slice(1).forEach((q) => p.push(q));
  p.push([0, 200]);                                            // nach dem Ziel noch ein Stueck weiter
  return p;
}
function skSim(v, seed, until, sigma = 3) {
  const noise = rng(seed);
  const path = skPath(2);
  const seg = []; let total = 0;
  for (let i = 1; i < path.length; i += 1) { const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); seg.push(d); total += d; }
  const out = [];
  for (let t = -60; t <= until; t += 1) {
    let dd = Math.max(0, Math.min(total, t * v)); let i = 0;
    while (i < seg.length - 1 && dd > seg[i]) { dd -= seg[i]; i += 1; }
    const f = seg[i] ? dd / seg[i] : 0;
    out.push({ ...pt(path[i][0] + (path[i + 1][0] - path[i][0]) * f + noise() * sigma, path[i][1] + (path[i + 1][1] - path[i][1]) * f + noise() * sigma), ts: gun + t * 1000 });
  }
  return out;
}
const skLine = { a: pt(-50, 0), b: pt(50, 0), mark: pt(SK_B1.x, SK_B1.y) };
const skRace = { startTs: gun, laps: 2, minLapSeconds: 120, endTs: gun + 3 * 3600e3, lapMode: 'loop' };
const skMarks = [pt(SK_B1.x + 40, SK_B1.y - 30), pt(SK_B2.x - 50, SK_B2.y + 40)];   // grob gezeichnet
const skBoats = (until) => [
  { trackerId: 'A', name: 'Alpha', yardstick: 100, v: 4.0, seed: 1 },
  { trackerId: 'B', name: 'Bravo', yardstick: 90, v: 3.6, seed: 2 },
  { trackerId: 'C', name: 'Charlie', yardstick: 120, v: 3.0, seed: 3 }
].map((b) => ({ ...b, fixes: skSim(b.v, b.seed, until) }));

test('Skizzen-Kurs: 3 Durchgaenge in dieselbe Richtung, Abstieg ausserhalb der Linie, Bojen 1 und 2 pro Runde erkannt', () => {
  const boats = skBoats(2400);
  const pl = timing.prepareLine(skLine);
  const det = course.detectCourse({ pl, race: skRace, boatsFixes: boats.map((b) => b.fixes), approxMarks: skMarks });
  const m1 = back(det.marks[0]); const m2 = back(det.marks[1]);
  assert.ok(Math.hypot(m1.x - SK_B1.x, m1.y - SK_B1.y) < 20, JSON.stringify(m1));
  assert.ok(Math.hypot(m2.x - SK_B2.x, m2.y - SK_B2.y) < 20, JSON.stringify(m2));
  det.perBoat.forEach((b) => {
    assert.strictEqual(b.analysis.status, 'FIN');
    assert.strictEqual(b.analysis.laps.length, 2);
    assert.deepStrictEqual([b.analysis.lapInfo.extensionPasses, b.analysis.lapInfo.missingPasses, b.analysis.lapInfo.uncertain], [2, 0, false]);
    b.roundings.forEach((lap) => assert.strictEqual(lap.length, 2));       // je Runde beide Bojen
  });
});

test('Skizzen-Kurs: Live-Rangliste folgt Runde und Yardstick (A, C, B), Runde 2 erst nach dem Durchgang zwischen den Marken', () => {
  const final = course.liveRanking({ line: skLine, race: skRace, approxMarks: skMarks, boats: skBoats(2400), now: gun + 2400 * 1000 });
  assert.ok(final.entries.every((e) => e.status === 'FIN'));
  assert.deepStrictEqual(final.entries.map((e) => e.trackerId), ['A', 'C', 'B']);
  // Boot A: Rundenlaenge ca. 2575 m bei 4 m/s -> Durchgang Ende Runde 1 bei ca. 650 s; Abstieg ueber die Verlaengerung davor
  const at = (sec) => course.liveRanking({ line: skLine, race: skRace, approxMarks: skMarks,
    boats: [{ ...skBoats(sec)[0], fixes: skSim(4, 1, sec) }], now: gun + sec * 1000 }).entries[0];
  const early = at(120);
  assert.deepStrictEqual([early.lapNow, early.status], [1, 'RACING']);
  const afterDescent = at(300);                      // nach dem Abstieg in Runde 1, vor dem Durchgang zwischen den Marken
  assert.strictEqual(afterDescent.lapNow, 1);
  const lap2 = at(700);                              // nach dem Ende der Runde 1
  assert.strictEqual(lap2.lapNow, 2);
  assert.strictEqual(lap2.lapUncertain, false);
  assert.ok(lap2.progressM > afterDescent.progressM);
});
