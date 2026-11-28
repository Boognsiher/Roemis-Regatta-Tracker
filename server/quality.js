'use strict';

/**
 * Datenqualitaet je Boot und Wettfahrt (reine Funktionen, keine I/O).
 *
 * Frage: Ist die Spur dieses Boots gut genug fuer eine faire Wertung? Die Zeitmessung selbst (timing.js) rechnet mit dem, was da ist;
 * hier wird nur beurteilt und gewarnt. Es wird NICHTS automatisch gestrichen oder umgerechnet - die Wettfahrtleitung entscheidet
 * (gleiches Prinzip wie bei der Warnung fuer die falsche Bojenseite).
 *
 * Beurteilt wird das Zeitfenster der Wettfahrt (Start-Durchgang bis Ziel bzw. Zielschluss) auf den Positionen NACH den bestehenden
 * Filtern aus timing.normalizeFixes; zusaetzlich, wie viele Punkte diese Filter verworfen haben.
 */

const timing = require('./timing');

/**
 * Grenzwerte an EINER Stelle, damit sie spaeter einstellbar werden koennen (z. B. pro Regatta). Ein Wert zaehlt, wenn er die Grenze
 * UEBERschreitet. Warum diese Zahlen: LoRa-Tracker senden alle 2 s, Handys alle 5 s - beides soll ohne Warnung durchgehen (rateSec 5).
 * Eine Luecke von 10 s an einem Ereignis bedeutet bis zu +-5 s Unsicherheit bei Start/Ziel; das ist bei knappen Abstaenden schon relevant.
 * Median 4-5 m ist der Normalfall aller Quellen; ab 10 m stimmen Bojen-Erkennung und Linien-Durchgaenge nur noch grob.
 */
const QUALITY = {
  warn: { rateSec: 5, maxGapSec: 15, gapAtEventsSec: 10, medianAccuracyM: 10, droppedShare: 0.10 },
  bad: { rateSec: 10, maxGapSec: 30, gapAtEventsSec: 20, medianAccuracyM: 20, droppedShare: 0.30 },
  eventWindowSec: 30,      // Umfeld eines Ereignisses (Start, Ziel, Boje), in dem eine Luecke als "am Ereignis" gilt
  mixedMinShare: 0.05      // ab diesem Anteil der kleineren Quelle heisst die Spur "gemischt" (einzelne Ausreisser nicht)
};

const LEVELS = ['ok', 'warn', 'bad'];
const worse = (a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a);

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Dauer lesbar: unter 2 min in Sekunden, darueber in Minuten bzw. Stunden. */
function fmtDur(sec) {
  const s = Math.round(sec);
  if (s < 120) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const pct = (x) => `${Math.round(x * 100)} %`;

/** "Ziel" -> "am Ziel", "Boje 2" -> "an Boje 2", "Runde 1" -> "am Ende von Runde 1" (fuer lesbare Saetze). */
function atEvent(label) {
  if (/^(Boje|Tor)\b/.test(label)) return `an ${label}`;
  if (/^Runde\b/.test(label)) return `am Ende von ${label}`;
  return `am ${label}`;
}

/**
 * Gleiche Schritte wie timing.normalizeFixes, aber mit Zaehlung je Filter. Ein Test prueft, dass das Ergebnis identisch bleibt -
 * so kann die Aufschluesselung nicht unbemerkt von der echten Filterkette abweichen.
 */
function filterSteps(fixesRaw) {
  const sorted = (fixesRaw || [])
    .filter((f) => Number.isFinite(f.ts) && Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .sort((x, y) => x.ts - y.ts);
  const base = [];
  for (const f of sorted) if (!base.length || base[base.length - 1].ts !== f.ts) base.push(f);   // doppelte Zeitstempel sind kein "Verwerfen"
  const afterAcc = timing.dropBadAccuracy(base);
  const afterShadow = timing.dropShadowSource(afterAcc);
  const clean = timing.dropJitter(afterShadow);
  return { base, afterAcc, afterShadow, clean };
}

const inWin = (from, to) => (f) => f.ts >= from && f.ts <= to;

/**
 * Kennzahlen und Ampel fuer ein Boot.
 * fixesRaw: alle Positionen des Boots um die Wettfahrt (wie sie gespeichert sind); fixesClean: optional schon gefiltert (sonst hier berechnet).
 * from/to: Zeitfenster (ms) = Start-Durchgang bis Ziel bzw. Zielschluss (bei laufender Wettfahrt bis jetzt).
 * events: [{ label, ts }] die zaehlenden Ereignisse (Start, Ziel, Bojen, Rundenenden).
 * Rueckgabe: { level: 'ok'|'warn'|'bad', reasons: [Saetze], metrics, source: 'tracker'|'handy'|'gemischt'|null }
 */
function boatQuality({ fixesRaw = [], fixesClean = null, from, to, events = [] } = {}) {
  const steps = filterSteps(fixesRaw);
  const clean = fixesClean ? fixesClean.slice().sort((x, y) => x.ts - y.ts) : steps.clean;
  const metrics = {
    from: from ?? null, to: to ?? null, points: 0, pointsRaw: 0,
    rateSec: null, maxGapSec: null, gapAtEventsSec: null, gapAtEventLabel: null, medianAccuracyM: null,
    droppedShare: null, dropped: { accuracy: 0, jitter: 0, shadow: 0 }
  };
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { level: 'bad', reasons: ['Kein auswertbares Zeitfenster (Start oder Ziel fehlt)'], metrics, source: null };
  }

  const w = inWin(from, to);
  const cleanIn = clean.filter(w);
  const baseIn = steps.base.filter(w);
  metrics.points = cleanIn.length;
  metrics.pointsRaw = baseIn.length;
  if (!baseIn.length) {
    return { level: 'bad', reasons: ['Keine Positionen im Zeitfenster der Wettfahrt'], metrics, source: null };
  }

  // --- Verworfene Punkte je Filter (nur im Zeitfenster) ---
  const countIn = (list) => list.filter(w).length;
  metrics.dropped = {
    accuracy: baseIn.length - countIn(steps.afterAcc),
    shadow: countIn(steps.afterAcc) - countIn(steps.afterShadow),
    jitter: countIn(steps.afterShadow) - countIn(steps.clean)
  };
  metrics.droppedShare = (baseIn.length - countIn(steps.clean)) / baseIn.length;
  // Fuer die Ampel zaehlen nur Genauigkeit und Rauschen. Die Zweitquelle (Handy-Punkte neben dichten Gateway-Punkten, siehe
  // timing.dropShadowSource) ist Redundanz, kein Datenmangel: der Master haette sonst immer ~17 % "verworfen" und waere dauernd gelb.
  const droppedEval = (metrics.dropped.accuracy + metrics.dropped.jitter) / baseIn.length;

  // --- Takt, Luecken, Genauigkeit (auf den gefilterten Punkten) ---
  if (cleanIn.length >= 2) metrics.rateSec = (cleanIn[cleanIn.length - 1].ts - cleanIn[0].ts) / 1000 / (cleanIn.length - 1);

  // Luecken: Paare aufeinanderfolgender Punkte, die ins Fenster ragen (inkl. je eines Nachbarn ausserhalb). Eine echte Luecke zaehlt voll,
  // auch wenn sie ueber den Fensterrand reicht - das Fenster endet genau am Ziel, eine Luecke um den Zieldurchgang waere sonst halbiert.
  // Gibt es vor/nach dem Fenster gar keinen Punkt, zaehlt der leere Rand bis zur Fenstergrenze (z. B. Tracker ausgefallen vor dem Zielschluss).
  const before = clean.filter((f) => f.ts < from).pop();
  const after = clean.find((f) => f.ts > to);
  const seq = [before || { ts: from, edge: 'start' }, ...cleanIn, after || { ts: to, edge: 'end' }];
  let maxGap = 0;
  let maxGapAt = null;
  for (let i = 1; i < seq.length; i += 1) {
    const g = (seq[i].ts - seq[i - 1].ts) / 1000;
    if (g > maxGap) { maxGap = g; maxGapAt = seq[i - 1].edge === 'start' ? 'start' : seq[i].edge === 'end' ? 'end' : 'mid'; }
  }
  metrics.maxGapSec = maxGap;

  // Luecke an den Ereignissen: groesste Luecke zwischen zwei Punkten im Umfeld +-eventWindowSec (schliesst das einschliessende Paar ein).
  const ew = QUALITY.eventWindowSec * 1000;
  for (const ev of events) {
    if (!ev || !Number.isFinite(ev.ts)) continue;
    let g = 0;
    for (let i = 1; i < clean.length; i += 1) {
      if (clean[i].ts < ev.ts - ew) continue;
      if (clean[i - 1].ts > ev.ts + ew) break;
      g = Math.max(g, (clean[i].ts - clean[i - 1].ts) / 1000);
    }
    if (metrics.gapAtEventsSec == null || g > metrics.gapAtEventsSec) { metrics.gapAtEventsSec = g; metrics.gapAtEventLabel = ev.label; }
  }

  metrics.medianAccuracyM = median(cleanIn.map((f) => f.accuracy).filter(Number.isFinite));

  // --- Quelle ---
  // Gewichtet nach abgedeckter Zeit, nicht nach Punktzahl: ein T-Beam mit 1 Hz liefert 5x so viele Punkte wie ein Handy mit 5 s;
  // 3 Minuten Handy in einer T-Beam-Luecke waeren nach Punkten unter 5 %, nach Zeit aber ein echter Teil der Spur.
  let source = null;
  if (cleanIn.length) {
    const t = { own: 0, gw: 0 };
    cleanIn.forEach((f, i) => {
      const next = cleanIn[i + 1];
      t[timing.sourceOf(f)] += next ? Math.min(next.ts - f.ts, 10000) : 1000;   // Luecken > 10 s zaehlen fuer keine Quelle voll
    });
    const share = t.own / (t.own + t.gw);
    source = Math.min(share, 1 - share) >= QUALITY.mixedMinShare ? 'gemischt' : share >= 0.5 ? 'handy' : 'tracker';
  }

  // --- Ampel: der schlechteste Einzelwert zaehlt ---
  let level = 'ok';
  const reasons = [];
  const judge = (value, key, text) => {
    if (value == null) return;
    const l = value > QUALITY.bad[key] ? 'bad' : value > QUALITY.warn[key] ? 'warn' : 'ok';
    if (l === 'ok') return;
    level = worse(level, l);
    if (text) reasons.push(text);
  };
  if (cleanIn.length < 2) {
    level = 'bad';
    reasons.push(`Nur ${cleanIn.length} brauchbare Position im Zeitfenster`);
  }
  judge(metrics.rateSec, 'rateSec', `Im Mittel nur alle ${Math.round(metrics.rateSec)} s eine Position`);
  // Ist die groesste Luecke dieselbe wie die am Ereignis, nur einmal nennen (mit dem Ereignis, das ist die aussagekraeftigere Angabe).
  const sameGap = maxGapAt === 'mid' && metrics.gapAtEventsSec != null && metrics.gapAtEventsSec >= maxGap;
  judge(metrics.maxGapSec, 'maxGapSec', sameGap ? null : maxGapAt === 'end'
    ? `Keine Positionen in den letzten ${fmtDur(maxGap)} vor ${events.some((e) => e.label === 'Ziel') ? 'dem Ziel' : 'dem Zielschluss'}`
    : maxGapAt === 'start' ? `Keine Positionen in den ersten ${fmtDur(maxGap)} nach dem Start` : `Größte Lücke in der Spur: ${fmtDur(maxGap)}`);
  judge(metrics.gapAtEventsSec, 'gapAtEventsSec', `Lücke von ${fmtDur(metrics.gapAtEventsSec || 0)} ${atEvent(metrics.gapAtEventLabel || 'Ereignis')}`);
  judge(metrics.medianAccuracyM, 'medianAccuracyM', `Genauigkeit im Mittel ${Math.round(metrics.medianAccuracyM)} m`);
  const why = [['accuracy', 'schlechte Genauigkeit'], ['jitter', 'GPS-Rauschen im Stillstand']]
    .filter(([k]) => metrics.dropped[k] > 0).map(([, t]) => t).join(', ');
  judge(droppedEval, 'droppedShare', `${pct(droppedEval)} der Punkte verworfen (${why})`);

  return { level, reasons, metrics, source };
}

/** Kurzer Satz fuer entry.warnings (nur gelb/rot). */
function qualityWarning(q) {
  if (!q || q.level === 'ok') return null;
  return `Datenqualität ${q.level === 'bad' ? 'rot' : 'gelb'}: ${q.reasons.join('; ')} - bitte prüfen`;
}

module.exports = { QUALITY, boatQuality, qualityWarning, filterSteps };
