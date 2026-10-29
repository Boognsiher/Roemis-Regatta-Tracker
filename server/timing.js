'use strict';

/**
 * Zeitmessung und Yardstick-Berechnung (reine Funktionen, keine I/O).
 *
 * Modell: Eine Start-/Ziellinie (Punkte a,b) plus ein Referenzpunkt "mark" (z.B. Luv-Tonne), der
 * die Kursseite festlegt. Gruppenstart: Die gesegelte Zeit ist Zieldurchgang minus Startsignal.
 * Ein Boot "startet" mit dem Durchqueren der Linie von der Vorstartseite auf die Kursseite und
 * "zaehlt eine Runde", wenn es die Linie von der Kursseite zur Vorstartseite durchquert.
 * Nach der letzten Runde ist der Zieldurchgang die Ziel-Zeit.
 *
 * Durchgangszeit = lineare Interpolation zwischen den zwei GPS-Fixes beidseits der Linie.
 * Die ts-Werte sind GPS-Zeit (Geolocation API), also unabhaengig von der Handy-Uhr.
 */

const EARTH_R = 6371000;

/** Projiziert lat/lon in ein lokales ebenes Meter-System um (lat0, lon0). */
function makeProjector(lat0, lon0) {
  const kx = (Math.PI / 180) * EARTH_R * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * EARTH_R;
  return (p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky });
}

/** Gegenstueck zu makeProjector: lokale Meter (x Ost, y Nord) -> lat/lon. */
function makeUnprojector(lat0, lon0) {
  const kx = (Math.PI / 180) * EARTH_R * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * EARTH_R;
  return (q) => ({ lat: lat0 + q.y / ky, lon: lon0 + q.x / kx });
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/**
 * Bereitet die Linie vor. Liefert null, wenn die Linie unvollstaendig ist.
 * courseSign: +1/-1, Vorzeichen der Seite, auf der der "mark" liegt (Kursseite).
 */
function prepareLine(line) {
  if (!line || !line.a || !line.b || !line.mark) return null;
  const proj = makeProjector((line.a.lat + line.b.lat) / 2, (line.a.lon + line.b.lon) / 2);
  const a = proj(line.a);
  const b = proj(line.b);
  const m = proj(line.mark);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const s = cross(dx, dy, m.x - a.x, m.y - a.y);
  if (s === 0) return null;
  const lat0 = (line.a.lat + line.b.lat) / 2;
  const lon0 = (line.a.lon + line.b.lon) / 2;
  return { proj, unproj: makeUnprojector(lat0, lon0), lat0, lon0, a, dx, dy, len, courseSign: Math.sign(s) };
}

/** Vorzeichen der Seite (relativ zur Kursseite): +1 = Kursseite, -1 = Vorstartseite. */
function sideOf(pl, p) {
  const q = pl.proj(p);
  const s = cross(pl.dx, pl.dy, q.x - pl.a.x, q.y - pl.a.y);
  return s === 0 ? 0 : Math.sign(s) * pl.courseSign;
}

/**
 * Findet alle Durchgaenge durch die Linie in einer nach Zeit sortierten Fix-Liste.
 * Rueckgabe: [{ ts, dir: 'start'|'finish', uncertaintyMs }] sortiert nach ts.
 * 'start'  = Vorstartseite -> Kursseite, 'finish' = Kursseite -> Vorstartseite.
 */
/**
 * Findet alle Durchgaenge durch die Linie in einer nach Zeit sortierten Fix-Liste.
 *  - 'finish' (Kursseite -> Vorstartseite) zaehlt nur zwischen den Marken (GPS-Toleranz finishTolM an beiden Enden).
 *  - 'start'  (Vorstartseite -> Kursseite) zaehlt zwischen den Marken und, wenn startExtensionM > 0, auch in der Verlaengerung
 *    der Linie bis zu dieser Entfernung hinter den Marken (markiert mit onExtension; analyzeBoat laesst das nur fuer den
 *    Start der 1. Runde gelten).
 * Durchgaenge, die nicht zaehlen, kommen (falls angegeben) mit dem Abstand zur naechsten Marke in "outside".
 */
function findCrossings(pl, fixes, outside = null, { startExtensionM = 0, finishTolM = 3 } = {}) {
  const out = [];
  let prev = null;
  let prevSide = 0;
  for (const f of fixes) {
    const side = sideOf(pl, f);
    if (prev && side !== 0 && prevSide !== 0 && side !== prevSide) {
      const p0 = pl.proj(prev);
      const p1 = pl.proj(f);
      const d0 = cross(pl.dx, pl.dy, p0.x - pl.a.x, p0.y - pl.a.y);
      const d1 = cross(pl.dx, pl.dy, p1.x - pl.a.x, p1.y - pl.a.y);
      const u = d0 / (d0 - d1); // Anteil der Strecke bis zur (unendlichen) Linie
      const hx = p0.x + u * (p1.x - p0.x) - pl.a.x;
      const hy = p0.y + u * (p1.y - p0.y) - pl.a.y;
      const along = (hx * pl.dx + hy * pl.dy) / (pl.len * pl.len); // 0..1 = zwischen a und b
      const dir = side === 1 ? 'start' : 'finish';
      const missM = along < 0 ? -along * pl.len : (along > 1 ? (along - 1) * pl.len : 0);   // Abstand ausserhalb der Marken
      const ok = missM === 0
        || (dir === 'finish' && missM <= finishTolM)
        || (dir === 'start' && missM <= Math.max(startExtensionM, finishTolM));
      if (ok) {
        out.push({
          ts: prev.ts + u * (f.ts - prev.ts),
          dir,
          uncertaintyMs: f.ts - prev.ts,
          onExtension: missM > finishTolM,
          missM
        });
      } else if (outside) {
        outside.push({ ts: prev.ts + u * (f.ts - prev.ts), meters: missM, dir });
      }
    }
    if (side !== 0) prevSide = side;
    prev = f;
  }
  return out;
}

/** Position interpoliert zum Zeitpunkt ts (null, wenn ts ausserhalb der Fixes liegt). */
function positionAt(fixes, ts) {
  for (let i = 1; i < fixes.length; i += 1) {
    const f0 = fixes[i - 1];
    const f1 = fixes[i];
    if (f0.ts <= ts && ts <= f1.ts) {
      const u = f1.ts === f0.ts ? 0 : (ts - f0.ts) / (f1.ts - f0.ts);
      return { lat: f0.lat + u * (f1.lat - f0.lat), lon: f0.lon + u * (f1.lon - f0.lon) };
    }
  }
  return null;
}

/** Sortiert nach ts und entfernt doppelte Zeitstempel (Nachsenden/Wiederholung). */
function normalizeFixes(fixes) {
  const sorted = fixes
    .filter((f) => Number.isFinite(f.ts) && Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .sort((x, y) => x.ts - y.ts);
  const out = [];
  for (const f of sorted) {
    if (!out.length || out[out.length - 1].ts !== f.ts) out.push(f);
  }
  return out;
}

/**
 * Wertet einen Lauf fuer ein Boot aus.
 * Rueckgabe: { status: 'FIN'|'DNF'|'DNS', laps:[{n,ts,lapSeconds}], finishTs, elapsedSec,
 *              uncertaintyMs, warnings:[] }
 */
/**
 * Auf welcher Runde ist das Boot? Rundkurs: Pro Runde gibt es genau einen Abstieg ausserhalb der Marken ueber die Verlaengerung der
 * Linie (von der Kursseite weg) und danach einen gueltigen Durchgang zwischen den Marken (Ende der Runde / Ziel). Die Reihenfolge
 * muss also abwechseln: Start, Abstieg, Durchgang, Abstieg, Durchgang, ... Folgen zwei Abstiege ohne gueltigen Durchgang dazwischen,
 * fehlt ein Durchgang zwischen den Marken (uncertain); die Runde wird dann aus den Abstiegen abgeleitet.
 */
function lapProgress({ lapMode, outside, laps, totalLaps, startTs, endTs, startCrossingTs, minLapSeconds }) {
  const completed = laps.length;
  if (lapMode !== 'loop') return { current: Math.min(totalLaps, completed + 1), completed, extensionPasses: 0, missingPasses: 0, uncertain: false };
  const gap = Math.max(30, (minLapSeconds || 120) / 2) * 1000;
  const valid = [];
  if (startCrossingTs != null) valid.push({ ts: startCrossingTs, kind: 'V' });
  laps.forEach((l) => valid.push({ ts: l.ts, kind: 'V' }));
  let n = 0;
  let last = -Infinity;
  const descents = [];
  for (const o of outside) {
    if (o.dir !== 'finish' || o.ts < (startCrossingTs ?? startTs) || (endTs != null && o.ts > endTs)) continue;
    if (o.ts - last < gap) continue;                 // Flattern/Kreuzen direkt nach einem Durchgang nicht mehrfach zaehlen
    last = o.ts;
    n += 1;
    descents.push({ ts: o.ts, kind: 'D' });
  }
  let missing = 0;
  if (startCrossingTs != null) {
    let expect = 'D';                                 // nach einem gueltigen Durchgang kommt der naechste Abstieg
    for (const ev of valid.concat(descents).sort((p, q) => p.ts - q.ts)) {
      if (ev.kind === 'V') expect = 'D';
      else if (expect === 'D') expect = 'V';          // erwarteter Abstieg
      else missing += 1;                              // zweiter Abstieg ohne gueltigen Durchgang dazwischen
    }
  }
  return {
    current: Math.min(totalLaps, completed + missing + 1),
    completed,
    extensionPasses: n,
    missingPasses: missing,
    uncertain: missing > 0
  };
}

const START_EXTENSION_MAX_M = 400;   // so weit hinter den Marken darf der Start der 1. Runde in der Verlaengerung der Linie liegen

function analyzeBoat(pl, fixesRaw, { startTs, laps: totalLaps, minLapSeconds, endTs = null, lapMode = 'bounce', startOnExtension = false }) {
  const warnings = [];
  const fixes = normalizeFixes(fixesRaw);
  if (!fixes.length || fixes[fixes.length - 1].ts < startTs) {
    return { status: 'DNS', laps: [], finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: ['Keine GPS-Daten ab dem Start'], lapInfo: { current: 1, completed: 0, extensionPasses: 0, missingPasses: 0, uncertain: false } };
  }

  // Zielschluss: Durchgaenge nach endTs zaehlen nicht (z.B. wenn danach die naechste Wettfahrt gesegelt wurde)
  const outside = [];
  const startExtensionM = startOnExtension ? START_EXTENSION_MAX_M : 0;
  const crossings = findCrossings(pl, fixes, outside, { startExtensionM }).filter((c) => endTs == null || c.ts <= endTs);
  const atGun = positionAt(fixes, startTs);
  const sideAtGun = atGun ? sideOf(pl, atGun) : -1;

  // Auf der Kursseite zum Startsignal = zu frueh gestartet (OCS) oder spaet in Bewegung -> pruefen.
  let started = false;
  let returnedFromOcs = sideAtGun >= 0 ? false : true;
  if (sideAtGun > 0) warnings.push('Beim Startsignal auf der Kursseite (OCS?) - bitte pruefen');

  const laps = [];
  const extWarned = new Set();
  let lastLapTs = null;
  let startCrossingTs = null;
  for (const c of crossings) {
    if (c.ts < startTs) continue;
    if (sideAtGun > 0 && !returnedFromOcs) {
      if (c.dir === 'finish') returnedFromOcs = true;
      continue;
    }
    // Start und Ziel muessen zwischen den Marken durchfahren werden. Nur wenn "Start in der Verlaengerung" eingeschaltet ist,
    // darf der allererste Start-Durchgang (Runde 1) in der Verlaengerung liegen - nie ein weiterer Start oder ein Ziel.
    const warnExt = (text) => {
      const key = `${laps.length}:${text}`;
      if (!extWarned.has(key)) { extWarned.add(key); warnings.push(text); }
    };
    if (lapMode === 'loop') {
      // Rundkurs: die Linie wird in jeder Runde in DIESELBE Richtung gekreuzt (Vorstartseite -> Kursseite).
      // 1. Durchgang = Start, jeder weitere = Ende einer Runde (der letzte = Ziel).
      if (c.dir !== 'start') continue;
      if (!started) { started = true; startCrossingTs = c.ts; continue; }
      if (c.onExtension) {
        warnExt(`Durchgang in der Verlaengerung der Linie (${Math.round(c.missM)} m neben der Marke) zaehlt nicht fuer das Ende der Runde ${laps.length + 1} - er muss zwischen den Marken liegen`);
        continue;
      }
    } else if (c.dir === 'start') {
      if (c.onExtension && laps.length > 0) {
        warnExt(`Start der Runde ${laps.length + 1} in der Verlaengerung der Linie (${Math.round(c.missM)} m neben der Marke) - zaehlt nicht, er muss zwischen den Marken liegen`);
        continue;
      }
      if (!started) startCrossingTs = startCrossingTs ?? c.ts;
      started = true;
      continue;
    } else if (!started) {
      continue;                                    // 'bounce': Ziel-Richtung zaehlt nur nach einem Start-Durchgang
    }
    const refTs = lastLapTs ?? startTs;
    if ((c.ts - refTs) / 1000 < minLapSeconds) {
      // Zu schnell nach dem letzten Durchgang: GPS-Zittern an der Linie, nicht werten.
      if (lapMode !== 'loop') started = false;
      warnings.push(`Durchgang bei ${new Date(c.ts).toISOString()} ignoriert (< ${minLapSeconds}s seit letzter Runde)`);
      continue;
    }
    laps.push({
      n: laps.length + 1,
      ts: c.ts,
      lapSeconds: (c.ts - refTs) / 1000,
      uncertaintyMs: c.uncertaintyMs
    });
    lastLapTs = c.ts;
    if (lapMode !== 'loop') started = false;
    if (laps.length === totalLaps) break;
  }

  // Runden-Anzeiger: Beim Abstieg von der letzten zur ersten Seite faehrt das Boot ausserhalb der Marken ueber die Verlaengerung der Linie
  // (Rundkurs, Richtung weg von der Kursseite). Jeder solche Durchgang gehoert zu einer Runde und zeigt, auf welcher Runde das Boot ist.
  const lapInfo = lapProgress({ lapMode, outside, laps, totalLaps, startTs, endTs, startCrossingTs, minLapSeconds });
  if (lapInfo.uncertain) {
    warnings.push(`Die Durchgaenge ueber die Verlaengerung der Linie zeigen Runde ${lapInfo.current} an, aber ${lapInfo.missingPasses} Durchgang/Durchgaenge zwischen den Marken (Start oder Ende einer Runde) fehlen - bitte pruefen`);
  }

  if (laps.length < totalLaps) {
    const out = outside.filter((o) => o.ts >= startTs && (endTs == null || o.ts <= endTs));
    const extra = [`Nur ${laps.length} von ${totalLaps} Runden erkannt`];
    if (out.length) {
      const nearest = Math.min(...out.map((o) => o.meters));
      const nFinish = out.filter((o) => o.dir === 'finish').length;
      extra.push(`${out.length} Durchgang/Durchgaenge ausserhalb der Linien-Marken (nur ${Math.round(nearest)} m daneben${nFinish ? `, davon ${nFinish} beim Zieldurchgang, der zwischen den Marken liegen muss` : ''}) - Linie zu kurz oder Boot ausserhalb der Marken?`);
    }
    return { status: 'DNF', laps, finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: warnings.concat(extra), lapInfo };
  }

  const fin = laps[laps.length - 1];
  if (fin.uncertaintyMs > 10000) {
    warnings.push(`Zieldurchgang unsicher: Luecke von ${(fin.uncertaintyMs / 1000).toFixed(0)}s zwischen den GPS-Fixes`);
  }
  return {
    status: 'FIN',
    laps,
    finishTs: fin.ts,
    elapsedSec: (fin.ts - startTs) / 1000,
    uncertaintyMs: fin.uncertaintyMs,
    warnings,
    lapInfo: { ...lapInfo, current: totalLaps }
  };
}

/** Berechnete Zeit (Sekunden) = gesegelte Zeit * 100 / Yardstick. */
function correctedSeconds(elapsedSec, yardstick) {
  return (elapsedSec * 100) / yardstick;
}

/**
 * Ranking nach berechneter Zeit (auf ganze Sekunden gerundet, gleiche Zeit = gleicher Rang).
 * Eintraege ohne correctedSec bekommen keinen Rang.
 */
function rankEntries(entries) {
  const ranked = entries
    .filter((e) => e.correctedSec != null)
    .sort((x, y) => Math.round(x.correctedSec) - Math.round(y.correctedSec));
  let rank = 0;
  ranked.forEach((e, i) => {
    if (i === 0 || Math.round(e.correctedSec) !== Math.round(ranked[i - 1].correctedSec)) rank = i + 1;
    e.rank = rank;
  });
  entries.forEach((e) => { if (e.correctedSec == null) e.rank = null; });
  return entries;
}

module.exports = {
  makeProjector, makeUnprojector,   prepareLine, findCrossings, positionAt, normalizeFixes, analyzeBoat, correctedSeconds, rankEntries
};
