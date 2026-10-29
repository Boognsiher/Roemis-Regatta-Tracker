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
function findCrossings(pl, fixes, outside = null) {
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
      if (along >= 0 && along <= 1) {
        out.push({
          ts: prev.ts + u * (f.ts - prev.ts),
          dir: side === 1 ? 'start' : 'finish',
          uncertaintyMs: f.ts - prev.ts
        });
      } else if (outside) {
        outside.push({ ts: prev.ts + u * (f.ts - prev.ts), meters: along < 0 ? -along * pl.len : (along - 1) * pl.len });
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
function analyzeBoat(pl, fixesRaw, { startTs, laps: totalLaps, minLapSeconds, endTs = null, lapMode = 'bounce' }) {
  const warnings = [];
  const fixes = normalizeFixes(fixesRaw);
  if (!fixes.length || fixes[fixes.length - 1].ts < startTs) {
    return { status: 'DNS', laps: [], finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: ['Keine GPS-Daten ab dem Start'] };
  }

  // Zielschluss: Durchgaenge nach endTs zaehlen nicht (z.B. wenn danach die naechste Wettfahrt gesegelt wurde)
  const outside = [];
  const crossings = findCrossings(pl, fixes, outside).filter((c) => endTs == null || c.ts <= endTs);
  const atGun = positionAt(fixes, startTs);
  const sideAtGun = atGun ? sideOf(pl, atGun) : -1;

  // Auf der Kursseite zum Startsignal = zu frueh gestartet (OCS) oder spaet in Bewegung -> pruefen.
  let started = false;
  let returnedFromOcs = sideAtGun >= 0 ? false : true;
  if (sideAtGun > 0) warnings.push('Beim Startsignal auf der Kursseite (OCS?) - bitte pruefen');

  const laps = [];
  let lastLapTs = null;
  let startCrossingTs = null;
  for (const c of crossings) {
    if (c.ts < startTs) continue;
    if (sideAtGun > 0 && !returnedFromOcs) {
      if (c.dir === 'finish') returnedFromOcs = true;
      continue;
    }
    if (lapMode === 'loop') {
      // Rundkurs: die Linie wird jede Runde in DIESELBE Richtung gekreuzt (Vorstartseite -> Kursseite).
      // Erster Durchgang = Start, jeder weitere = Ende einer Runde.
      if (c.dir !== 'start') continue;
      if (!started) { started = true; startCrossingTs = c.ts; continue; }
    } else if (c.dir === 'start') {
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

  if (laps.length < totalLaps) {
    const out = outside.filter((o) => o.ts >= startTs && (endTs == null || o.ts <= endTs));
    const extra = [`Nur ${laps.length} von ${totalLaps} Runden erkannt`];
    if (out.length) {
      const nearest = Math.min(...out.map((o) => o.meters));
      extra.push(`${out.length} Durchgang/Durchgaenge ausserhalb der Linien-Marken (nur ${Math.round(nearest)} m daneben) - Linie zu kurz oder Boot ausserhalb der Marken?`);
    }
    return { status: 'DNF', laps, finishTs: null, elapsedSec: null, uncertaintyMs: null, warnings: warnings.concat(extra) };
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
    warnings
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
