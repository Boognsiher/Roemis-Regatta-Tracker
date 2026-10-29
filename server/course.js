'use strict';

/**
 * Kurs (Bojen) und Live-Rangliste - reine Funktionen ohne I/O.
 *
 * Der Kurs ist eine grobe, von Hand gezeichnete Strecke fuer EINE Runde (Bojen in Fahrtreihenfolge, ohne Start/Ziel-Linie).
 * Die genauen Bojenpositionen werden aus den Aufzeichnungen der Boote bestimmt: In der Naehe jedes gezeichneten Punkts
 * suchen wir pro Boot den Punkt mit der staerksten Kursaenderung (Rundung); der Median ueber alle Boote und Runden ist die
 * Bojenposition. Die gezeichneten Strecken dienen nur dazu, die Bojen zu finden (keine Wendewinkel).
 *
 * Fortschritt eines Boots = zurueckgelegte Strecke entlang  Linie -> Boje 1 -> ... -> Boje n -> Linie (je Runde).
 * Rangliste = geschaetzte berechnete Zielzeit: (verstrichene Zeit * Gesamtstrecke / Fortschritt) * 100 / Yardstick.
 * Referenz fuer den Abstand ist das vorderste Boot (groesster Fortschritt) und das Boot mit der besten berechneten Zeit.
 */

const timing = require('./timing');

const DEFAULTS = {
  radiusM: 250,         // Suchradius um die gezeichneten Punkte
  refineRadiusM: 120,   // Suchradius um die verfeinerten Bojen (2. Durchgang)
  minTurnDeg: 25,       // ab dieser Kursaenderung gilt ein Punkt als Rundung, sonst nur als Vorbeifahrt
  turnWindowS: 20,      // Zeitfenster vor/nach dem Punkt zur Kursbestimmung
  outlierM: 80,         // Wendepunkte weiter als das von der Mitte weg werden verworfen
  minProgressFrac: 0.03, // Prognose erst ab diesem Anteil der Gesamtstrecke ...
  minElapsedS: 60       // ... und nach dieser Zeit
};

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const bearing = (p, q) => ((Math.atan2(q.x - p.x, q.y - p.y) * 180) / Math.PI + 360) % 360;
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function toXY(pl, fixes) {
  return fixes.map((f) => { const q = pl.proj(f); return { t: f.ts, x: q.x, y: q.y }; });
}

/** Punkt der staerksten Kursaenderung (Rundung) innerhalb eines Besuchs [i0..i1] um die Boje m. */
function findApex(pts, i0, i1, m, o) {
  const W = o.turnWindowS * 1000;
  let best = null;
  let closest = null;
  for (let j = i0; j <= i1; j += 1) {
    let a = j;
    while (a > 0 && pts[j].t - pts[a].t < W) a -= 1;
    if (pts[j].t - pts[a].t < W) continue;                  // zu wenig Vorlauf
    let b = j;
    while (b < pts.length - 1 && pts[b].t - pts[j].t < W) b += 1;
    if (pts[b].t - pts[j].t < W) continue;                  // noch zu wenig Nachlauf (Boot gerade erst an der Boje)
    const turn = dist(pts[a], pts[j]) < 8 || dist(pts[j], pts[b]) < 8 ? 0 : angDiff(bearing(pts[a], pts[j]), bearing(pts[j], pts[b]));
    const dm = dist(pts[j], m);
    if (!best || turn > best.turn) best = { j, turn, dm };
    if (!closest || dm < closest.dm) closest = { j, turn, dm };
  }
  if (!best) return null;
  const pick = best.turn >= o.minTurnDeg ? best : closest;
  const p = pts[pick.j];
  return { t: p.t, x: p.x, y: p.y, turn: pick.turn, passOnly: best.turn < o.minTurnDeg };
}

/** Rundungen der Reihe nach (Boje 1, 2, ...) im Zeitfenster [tFrom, tTo]. */
function detectRoundings(pts, marks, tFrom, tTo, radiusM, o) {
  const events = [];
  let i = 0;
  while (i < pts.length && pts[i].t < tFrom) i += 1;
  for (let k = 0; k < marks.length && i < pts.length; k += 1) {
    const m = marks[k];
    while (i < pts.length && pts[i].t <= tTo && dist(pts[i], m) > radiusM) i += 1;
    if (i >= pts.length || pts[i].t > tTo) break;
    const i0 = i;
    while (i < pts.length && pts[i].t <= tTo && dist(pts[i], m) <= radiusM) i += 1;
    const apex = findApex(pts, i0, i - 1, m, o);
    if (!apex) break;                                       // Rundung noch nicht abgeschlossen
    events.push({ k, ...apex });
  }
  return events;
}

/** Auswertung eines Boots gegen die Bojen: Runden (Linie) und Rundungen je Runde. */
function analyzeBoatCourse({ pl, fixes, race, marksXY, radiusM, o }) {
  const norm = timing.normalizeFixes(fixes);
  const analysis = timing.analyzeBoat(pl, norm, { startTs: race.startTs, laps: race.laps, minLapSeconds: race.minLapSeconds, endTs: race.endTs ?? null });
  const pts = toXY(pl, norm);
  const lastT = pts.length ? pts[pts.length - 1].t : race.startTs;
  const lapStarts = [race.startTs].concat(analysis.laps.map((l) => l.ts));
  const touched = Math.min(race.laps, analysis.laps.length + 1);
  const roundings = [];
  for (let l = 0; l < touched; l += 1) {
    const tTo = l < analysis.laps.length ? analysis.laps[l].ts : Math.min(lastT, race.endTs ?? Infinity);
    roundings.push(detectRoundings(pts, marksXY, lapStarts[l], tTo, radiusM, o));
  }
  return { analysis, pts, roundings };
}

/** Median der Rundungspunkte je Boje (mit Ausreisser-Filter). */
function refineMarks(marksXY, perBoat, o) {
  return marksXY.map((m, k) => {
    let pts = [];
    for (const b of perBoat) for (const lap of b.roundings) for (const e of lap) if (e.k === k) pts.push(e);
    const turning = pts.filter((e) => !e.passOnly);
    if (turning.length >= 2 || (turning.length === 1 && pts.length === 1)) pts = turning;
    if (!pts.length) return { x: m.x, y: m.y, n: 0 };
    let c = { x: median(pts.map((e) => e.x)), y: median(pts.map((e) => e.y)) };
    const keep = pts.filter((e) => dist(e, c) <= o.outlierM);
    if (keep.length) c = { x: median(keep.map((e) => e.x)), y: median(keep.map((e) => e.y)) };
    return { x: c.x, y: c.y, n: keep.length };
  });
}

function minSpacing(nodes) {
  let m = Infinity;
  for (let i = 1; i < nodes.length; i += 1) m = Math.min(m, dist(nodes[i - 1], nodes[i]));
  return m;
}

/** Bojen erkennen: 1. Durchgang mit gezeichneten Punkten, 2. Durchgang mit den gefundenen Positionen. */
function detectCourse({ pl, race, boatsFixes, approxMarks, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const mid = { x: pl.a.x + pl.dx / 2, y: pl.a.y + pl.dy / 2 };
  const marks0 = approxMarks.map((m) => pl.proj(m));
  const r1 = Math.min(o.radiusM, 0.4 * minSpacing([mid, ...marks0, mid]));
  const run = (marks, radiusM) => boatsFixes.map((fixes) => analyzeBoatCourse({ pl, fixes, race, marksXY: marks, radiusM, o }));

  const pass1 = run(marks0, r1);
  const marks1 = refineMarks(marks0, pass1, o);
  const m1 = marks1.map((m) => ({ x: m.x, y: m.y }));
  const r2 = Math.min(o.refineRadiusM, 0.4 * minSpacing([mid, ...m1, mid]));
  const pass2 = run(m1, r2);
  const marks2 = refineMarks(m1, pass2, o);
  const finalMarks = marks2.map((m, k) => (m.n > 0 ? m : { ...marks1[k], n: marks1[k].n }));
  const finalXY = finalMarks.map((m) => ({ x: m.x, y: m.y }));
  // Falls sich durch die Verfeinerung Positionen verschoben haben, mit den endgueltigen Bojen neu auswerten
  const moved = finalXY.some((m, k) => dist(m, m1[k]) > 5);
  const per = moved ? run(finalXY, r2) : pass2;

  return {
    marks: finalMarks.map((m, k) => ({ ...pl.unproj(m), n: m.n, approx: m.n === 0, drawn: approxMarks[k] })),
    marksXY: finalXY,
    mid,
    perBoat: per
  };
}

/** Geometrie einer Runde: Linienmitte -> Bojen -> Linienmitte. */
function courseGeometry(mid, marksXY, laps) {
  const nodes = [mid, ...marksXY, mid];
  const legLen = [];
  const cum = [0];
  for (let i = 1; i < nodes.length; i += 1) {
    const l = dist(nodes[i - 1], nodes[i]);
    legLen.push(l);
    cum.push(cum[cum.length - 1] + l);
  }
  const lapLen = cum[cum.length - 1];
  return { nodes, legLen, cum, lapLen, totalLen: lapLen * laps, laps };
}

/** Fortschritt (m) entlang des Kurses fuer Runde lap (0-basiert), marksDone Bojen gerundet, aktuelle Position pos. */
function progressMeters(geo, lap, marksDone, pos) {
  const k = clamp(marksDone, 0, geo.legLen.length - 1);
  const A = geo.nodes[k];
  const B = geo.nodes[k + 1];
  const L = geo.legLen[k];
  const f = L > 0 ? clamp(((pos.x - A.x) * (B.x - A.x) + (pos.y - A.y) * (B.y - A.y)) / (L * L), 0, 1) : 0;
  return lap * geo.lapLen + geo.cum[k] + f * L;
}

function speedKn(pts) {
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  let i = pts.length - 2;
  while (i > 0 && last.t - pts[i].t < 10000) i -= 1;
  const dt = (last.t - pts[i].t) / 1000;
  return dt > 0 ? (dist(pts[i], last) / dt) * 1.9438445 : null;
}

/**
 * Live-Rangliste.
 * boats: [{ trackerId, name, sailNo, helm, className, yardstick, fixes }], race: { startTs, laps, minLapSeconds, endTs },
 * approxMarks: gezeichnete Bojenpunkte [{lat, lon}], now: Zeitpunkt (ms).
 */
function liveRanking({ line, race, approxMarks, boats, now, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const out = { updatedAt: now, elapsedSec: race.startTs == null ? null : Math.max(0, (now - race.startTs) / 1000), needsCourse: false, marks: [], lapLenM: null, totalM: null, entries: [], leaderId: null, foremostId: null };
  const pl = timing.prepareLine(line);
  if (!pl || race.startTs == null) return out;
  if (!approxMarks || !approxMarks.length) {
    out.needsCourse = true;
    return out;
  }

  const det = detectCourse({ pl, race, boatsFixes: boats.map((b) => b.fixes), approxMarks, options: o });
  const geo = courseGeometry(det.mid, det.marksXY, race.laps);
  out.marks = det.marks;
  out.lapLenM = geo.lapLen;
  out.totalM = geo.totalLen;

  const entries = boats.map((b, idx) => {
    const { analysis, pts, roundings } = det.perBoat[idx];
    const e = {
      trackerId: b.trackerId, name: b.name, sailNo: b.sailNo, helm: b.helm, className: b.className, yardstick: b.yardstick,
      status: 'NODATA', lapsDone: analysis.laps.length, marksDone: 0, progressM: 0, progressPct: 0, elapsedSec: null,
      correctedSec: null, projectedCorrectedSec: null, rank: null, gapCorrectedSec: null, gapM: null, speedKn: null, lastFixAgeSec: null
    };
    if (!pts.length) return e;
    const last = pts[pts.length - 1];
    e.lastFixAgeSec = Math.max(0, (now - last.t) / 1000);
    e.speedKn = speedKn(pts);
    if (analysis.status === 'FIN') {
      e.status = 'FIN';
      e.lapsDone = race.laps;
      e.progressM = geo.totalLen;
      e.elapsedSec = analysis.elapsedSec;
      e.correctedSec = timing.correctedSeconds(analysis.elapsedSec, b.yardstick);
    } else if (last.t < race.startTs) {
      e.status = 'PRESTART';
    } else {
      e.status = 'RACING';
      const lap = Math.min(analysis.laps.length, race.laps - 1);
      const done = (roundings[lap] || []).length;
      e.marksDone = done;
      e.progressM = progressMeters(geo, lap, done, last);
      e.elapsedSec = (last.t - race.startTs) / 1000;
      const frac = geo.totalLen > 0 ? e.progressM / geo.totalLen : 0;
      if (frac >= o.minProgressFrac && e.elapsedSec >= o.minElapsedS) {
        e.projectedCorrectedSec = timing.correctedSeconds((e.elapsedSec * geo.totalLen) / e.progressM, b.yardstick);
      }
    }
    e.progressPct = geo.totalLen > 0 ? Math.min(100, (100 * e.progressM) / geo.totalLen) : 0;
    return e;
  });

  // Rang nach (End- oder prognostizierter) berechneter Zeit
  const time = (e) => (e.status === 'FIN' ? e.correctedSec : e.projectedCorrectedSec);
  const ranked = entries.filter((e) => time(e) != null).sort((a, b) => time(a) - time(b));
  ranked.forEach((e, i) => { e.rank = i + 1; });
  if (ranked.length) {
    out.leaderId = ranked[0].trackerId;
    const t0 = time(ranked[0]);
    ranked.forEach((e) => { e.gapCorrectedSec = time(e) - t0; });
  }
  const withData = entries.filter((e) => e.status === 'RACING' || e.status === 'FIN');
  if (withData.length) {
    const front = withData.reduce((a, b) => (b.progressM > a.progressM ? b : a));
    out.foremostId = front.trackerId;
    withData.forEach((e) => { e.gapM = front.progressM - e.progressM; });
  }
  entries.sort((a, b) => (a.rank ?? 1e6) - (b.rank ?? 1e6) || b.progressM - a.progressM || a.name.localeCompare(b.name, 'de'));
  out.entries = entries;
  return out;
}

module.exports = {
  DEFAULTS, detectRoundings, findApex, refineMarks, detectCourse, courseGeometry, progressMeters, liveRanking, analyzeBoatCourse
};
