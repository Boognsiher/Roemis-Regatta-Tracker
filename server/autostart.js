'use strict';

/**
 * Automatische Start-Erkennung (reine Funktionen, keine I/O).
 *
 * Ohne externes Startsignal wird der Start einer Klasse aus den Bootsbewegungen abgeleitet:
 *  1. Pro Boot: alle Durchgaenge Vorstartseite -> Kursseite durch die Startlinie ("Start-Kandidaten"). Ein Durchgang, auf den innerhalb von
 *     minLapSeconds die Rueckkehr auf die Vorstartseite folgt, war ein abgebrochener Start (Boot ist zurueckgefahren) und zaehlt nicht.
 *  2. Pro Klasse: das Zeitfenster (windowSec) mit den meisten verschiedenen Booten ist der Start-Pulk; bei Gleichstand das fruehere.
 *     Startzeit der Klasse = fruehester Durchgang im Pulk (das Boot ganz vorn hat "perfekt" gestartet, alle anderen verlieren die Zeit
 *     bis zu ihrer eigenen Querung). Durchgaenge vor dem Pulk (Probe-Querungen, Fruehstart) werden nicht als Start gewertet.
 *  3. Der Start gilt als endgueltig ("final"), wenn seit dem Pulk windowSec + settleSec vergangen sind (oder die Daten vollstaendig sind).
 *     Bis dahin kann sich die Startzeit noch aendern (weitere Boote queren).
 * Grenzen: Ein einzelnes Boot einer Klasse wird auf seinen ersten gueltigen Durchgang gestellt; ohne Startsignal kann ein Fruehstart
 * (OCS) der gesamten Klasse nicht erkannt werden.
 */

const timing = require('./timing');

const DEFAULTS = { windowSec: 120, settleSec: 60, minLapSeconds: 120, startExtensionM: 0 };

/** Start-Kandidaten (ts in ms, aufsteigend) eines Boots. */
function boatStartCandidates(pl, fixesRaw, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const fixes = timing.normalizeFixes(fixesRaw);
  if (fixes.length < 2) return [];
  const crossings = timing.findCrossings(pl, fixes, null, { startExtensionM: o.startExtensionM });
  const out = [];
  crossings.forEach((c, i) => {
    if (c.dir !== 'start') return;
    const back = crossings.slice(i + 1).find((n) => n.dir === 'finish');
    if (back && (back.ts - c.ts) / 1000 < o.minLapSeconds) return;       // sofort zurueckgefahren: kein Start
    out.push(c.ts);
  });
  return out;
}

/**
 * Startzeit einer Klasse aus den Kandidaten aller Boote: { boatId: [ts...] }.
 * upTo: bis wann Daten vorliegen (ms); complete: Daten sind vollstaendig (nachtraegliche Auswertung) -> sofort final.
 * Rueckgabe: { ts, final, boats: [boatId im Pulk], early: [{ id, ts }] } (ts null = noch kein Start erkennbar).
 */
function detectClassStart(candidates, upTo, { complete = false, ...options } = {}) {
  const o = { ...DEFAULTS, ...options };
  const all = [];
  for (const [id, list] of Object.entries(candidates)) list.forEach((ts) => all.push({ id, ts }));
  if (!all.length) return { ts: null, final: false, boats: [], early: [] };
  all.sort((a, b) => a.ts - b.ts);
  const w = o.windowSec * 1000;
  let best = null;
  for (const c of all) {
    const inWin = all.filter((x) => x.ts >= c.ts && x.ts <= c.ts + w);
    const ids = new Set(inWin.map((x) => x.id));
    if (!best || ids.size > best.ids.size) best = { start: c.ts, ids, inWin };
  }
  const first = new Map();
  best.inWin.forEach((x) => { if (!first.has(x.id)) first.set(x.id, x.ts); });
  const early = [];
  for (const [id, list] of Object.entries(candidates)) {
    if (first.has(id)) continue;
    const t = list.find((ts) => ts < best.start);
    if (t != null) early.push({ id, ts: t });
  }
  const final = complete || upTo >= best.start + (o.windowSec + o.settleSec) * 1000;
  return { ts: best.start, final, boats: [...first.keys()], early };
}

module.exports = { DEFAULTS, boatStartCandidates, detectClassStart };
