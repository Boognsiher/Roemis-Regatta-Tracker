'use strict';

/**
 * Export der aufgezeichneten Positionen als CSV (Excel, ';' getrennt) und GPX (Karten-Apps, z.B. GPX Viewer, QGIS).
 * Reine Funktionen: bekommen Eintraege [{ tracker, boat, fixes }] und liefern Text.
 */

const KN = 1.9438445;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function sortedFixes(fixes, from, to) {
  const seen = new Set();
  return fixes
    .filter((f) => Number.isFinite(f.ts) && Number.isFinite(f.lat) && Number.isFinite(f.lon)
      && (from == null || f.ts >= from) && (to == null || f.ts <= to))
    .sort((a, b) => a.ts - b.ts)
    .filter((f) => (seen.has(f.ts) ? false : (seen.add(f.ts), true)));
}

/** Alle Positionen als CSV (mit BOM, damit Excel die Umlaute richtig liest). */
function tracksCsv(entries, { from = null, to = null } = {}) {
  const head = ['Boot', 'Segelnr', 'Steuermann', 'Klasse', 'LoRa-Nr', 'Tracker-ID', 'Zeit_UTC', 'ts_ms', 'lat', 'lon',
    'Speed_m/s', 'Speed_kn', 'Kurs_Grad', 'Genauigkeit_m', 'Akku_%'];
  const rows = [head];
  for (const e of entries) {
    const boat = e.boat || {};
    for (const f of sortedFixes(e.fixes, from, to)) {
      rows.push([
        e.tracker.name, boat.sailNo ?? '', boat.helm ?? '', boat.className ?? '', e.tracker.loraId ?? '', e.tracker.id,
        new Date(f.ts).toISOString(), f.ts, f.lat.toFixed(6), f.lon.toFixed(6),
        f.speed == null ? '' : f.speed.toFixed(2), f.speed == null ? '' : (f.speed * KN).toFixed(2),
        f.heading == null ? '' : f.heading.toFixed(0), f.accuracy == null ? '' : f.accuracy.toFixed(1),
        f.battery == null ? '' : Math.round(f.battery * 100)
      ]);
    }
  }
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** GPX 1.1: je Boot ein Track, optional Wegpunkte (Linie, Bojen). */
function tracksGpx(entries, { from = null, to = null, name = 'Regatta', waypoints = [] } = {}) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gpx version="1.1" creator="Regatta-Tracker" xmlns="http://www.topografix.com/GPX/1/1">');
  out.push(`<metadata><name>${xmlEscape(name)}</name><time>${new Date().toISOString()}</time></metadata>`);
  for (const w of waypoints) {
    out.push(`<wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${xmlEscape(w.name)}</name></wpt>`);
  }
  for (const e of entries) {
    const fixes = sortedFixes(e.fixes, from, to);
    if (!fixes.length) continue;
    const boat = e.boat || {};
    const label = [boat.sailNo, e.tracker.name].filter(Boolean).join(' ');
    out.push(`<trk><name>${xmlEscape(label)}</name>${boat.className ? `<desc>${xmlEscape(boat.className)}</desc>` : ''}<trkseg>`);
    for (const f of fixes) {
      const ext = f.speed == null ? '' : `<extensions><speed>${f.speed.toFixed(2)}</speed></extensions>`;
      out.push(`<trkpt lat="${f.lat.toFixed(6)}" lon="${f.lon.toFixed(6)}"><time>${new Date(f.ts).toISOString()}</time>${ext}</trkpt>`);
    }
    out.push('</trkseg></trk>');
  }
  out.push('</gpx>');
  return out.join('\n') + '\n';
}

module.exports = { tracksCsv, tracksGpx, sortedFixes, xmlEscape };
