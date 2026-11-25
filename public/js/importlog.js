/**
 * Import getrackter Logs (Browser und Node, getestet in test/importlog.test.js).
 *   ImportLog.parse(text, dateiname) -> { format, groups: [{ key, label, loraId, points: [{ts, lat, lon, speed, heading, battery, accuracy}] }], skipped, notes }
 *
 * Erkannte Formate (Trennzeichen "," oder ";" wird erkannt):
 *  - Server-Export "positionen-*.csv":   Boot;...;LoRa-Nr;Tracker-ID;Zeit_UTC;ts_ms;lat;lon;Speed_m/s;...        (Gruppen je Boot)
 *  - Flash-Log eines Trackers ('d'):     ts_ms,lat,lon,speed_ms,heading_deg                                     (eine Gruppe)
 *  - Segeluhr-App "trackerlog_*.csv":    ts_iso,ts_epoch_ms,source,tracker_id,pkt_ts_ms,lat,lon,speed_ms,...    (Gruppen je Tracker / eigenes Boot)
 *  - Segeluhr-App Diagnose-Log:          ts_iso,ts_epoch_ms,lat,lon,sog_kn,cog_deg,gps_valid,...                 (eine Gruppe)
 *  - GPX (trkpt mit time):               Gruppen je Strecke (trk)
 * Zeilen ohne Position (z.B. Lebenszeichen ohne Fix) oder ohne gueltigen Fix werden uebersprungen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImportLog = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KN_TO_MS = 0.514444;

  function normTs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);   // Sekunden -> Millisekunden
  }

  function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function validPos(lat, lon) {
    return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
  }

  function splitLine(line, delim) {
    // einfache CSV-Zerlegung mit Anfuehrungszeichen
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; }
      else if (c === delim && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseCsv(text) {
    const clean = text.replace(/^﻿/, '');
    const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) return { header: [], rows: [] };
    const first = lines[0];
    const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    const header = splitLine(first, delim).map((h) => h.trim());
    const rows = lines.slice(1).map((l) => {
      const cells = splitLine(l, delim);
      const o = {};
      header.forEach((h, i) => { o[h] = (cells[i] ?? '').trim(); });
      return o;
    });
    return { header, rows };
  }

  function addPoint(groups, key, label, extra, p) {
    let g = groups.get(key);
    if (!g) { g = { key, label, loraId: null, points: [], ...extra }; groups.set(key, g); }
    g.points.push(p);
  }

  function parseCsvLog(text, name) {
    const { header, rows } = parseCsv(text);
    const has = (...cols) => cols.every((c) => header.includes(c));
    const groups = new Map();
    let skipped = 0;
    let format = null;
    const notes = [];

    if (has('Zeit_UTC', 'ts_ms', 'lat', 'lon') && header.includes('Boot')) {
      format = 'Server-Export (positionen-*.csv)';
      for (const r of rows) {
        const ts = normTs(r.ts_ms) ?? (r.Zeit_UTC ? Date.parse(r.Zeit_UTC) : null);
        const lat = num(r.lat); const lon = num(r.lon);
        if (!ts || !validPos(lat, lon)) { skipped += 1; continue; }
        const lora = r['LoRa-Nr'] ? parseInt(r['LoRa-Nr'], 10) : null;
        addPoint(groups, `${r.Boot}|${lora}`, `${r.Boot || 'Boot'}${lora ? ` (LoRa-Nr ${lora})` : ''}`, { loraId: Number.isFinite(lora) ? lora : null, boatName: r.Boot || '' }, {
          ts, lat, lon, speed: num(r['Speed_m/s']), heading: num(r.Kurs_Grad), battery: num(r['Akku_%']) !== null ? num(r['Akku_%']) / 100 : null, accuracy: num(r.Genauigkeit_m)
        });
      }
    } else if (has('ts_epoch_ms', 'source', 'tracker_id', 'lat', 'lon')) {
      format = 'Segeluhr-App Tracker-Log (trackerlog_*.csv)';
      for (const r of rows) {
        if (r.source !== 'TRACKER' && r.source !== 'EIGEN') continue;       // Ereignis-Zeilen (Marker) uebergehen
        const ts = normTs(r.pkt_ts_ms) ?? normTs(r.ts_epoch_ms);
        const lat = num(r.lat); const lon = num(r.lon);
        if (!ts || !validPos(lat, lon) || r.gps_fix === '0') { skipped += 1; continue; }
        const own = r.source === 'EIGEN';
        const lora = own ? null : parseInt(r.tracker_id, 10);
        addPoint(groups, own ? 'EIGEN' : `T${r.tracker_id}`, own ? 'Eigenes Boot (Handy-GPS)' : `Tracker (LoRa-Nr ${r.tracker_id})`, { loraId: Number.isFinite(lora) ? lora : null, own }, {
          ts, lat, lon, speed: num(r.speed_ms), heading: num(r.heading_deg), battery: num(r.battery_pct) !== null ? num(r.battery_pct) / 100 : null, accuracy: num(r.accuracy_m) ?? (num(r.hdop) !== null ? num(r.hdop) * 5 : null)
        });
      }
      if (groups.has('EIGEN')) notes.push('Der Eintrag "Eigenes Boot" ist das Handy-GPS; ihn dem Tracker deines Boots zuordnen.');
    } else if (has('ts_epoch_ms', 'lat', 'lon', 'sog_kn')) {
      format = 'Segeluhr-App Diagnose-Log (diagnose_*.csv)';
      for (const r of rows) {
        const ts = normTs(r.ts_epoch_ms);
        const lat = num(r.lat); const lon = num(r.lon);
        if (!ts || !validPos(lat, lon) || r.gps_valid === 'false') { skipped += 1; continue; }
        const kn = num(r.sog_kn);
        addPoint(groups, 'diag', 'Diagnose-Log (Handy-GPS)', {}, { ts, lat, lon, speed: kn !== null ? kn * KN_TO_MS : null, heading: num(r.cog_deg), battery: null, accuracy: num(r.gps_accuracy_m) });
      }
    } else if (has('ts_ms', 'lat', 'lon')) {
      format = 'Flash-Log eines Trackers (d-Befehl)';
      for (const r of rows) {
        const ts = normTs(r.ts_ms);
        const lat = num(r.lat); const lon = num(r.lon);
        if (!ts || !validPos(lat, lon)) { skipped += 1; continue; }
        addPoint(groups, 'log', name ? name.replace(/\.[^.]+$/, '') : 'Tracker-Log', {}, { ts, lat, lon, speed: num(r.speed_ms), heading: num(r.heading_deg), battery: null, accuracy: null });
      }
    }
    return { format, groups: [...groups.values()], skipped, notes };
  }

  function parseGpx(text, name) {
    const groups = [];
    const trkRe = /<trk\b[^>]*>([\s\S]*?)<\/trk>/gi;
    const blocks = [];
    let m;
    while ((m = trkRe.exec(text))) blocks.push(m[1]);
    if (!blocks.length) blocks.push(text);                       // Dateien ohne <trk> (nur trkpt/rtept)
    let skipped = 0;
    blocks.forEach((b, i) => {
      const label = ((b.match(/<name>([\s\S]*?)<\/name>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const points = [];
      const ptRe = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
      let p;
      while ((p = ptRe.exec(b))) {
        const attrs = p[1];
        const lat = num((attrs.match(/lat="([^"]+)"/i) || [])[1]);
        const lon = num((attrs.match(/lon="([^"]+)"/i) || [])[1]);
        const t = ((p[2] || '').match(/<time>([^<]+)<\/time>/i) || [])[1];
        const ts = t ? Date.parse(t) : NaN;
        if (!validPos(lat, lon) || !Number.isFinite(ts)) { skipped += 1; continue; }
        const speed = num(((p[2] || '').match(/<speed>([^<]+)<\/speed>/i) || [])[1]);
        const course = num(((p[2] || '').match(/<course>([^<]+)<\/course>/i) || [])[1]);
        points.push({ ts, lat, lon, speed, heading: course, battery: null, accuracy: null });
      }
      if (points.length) groups.push({ key: `gpx${i}`, label: label || (name ? name.replace(/\.[^.]+$/, '') : `Strecke ${i + 1}`), loraId: null, points });
    });
    return { format: 'GPX', groups, skipped, notes: groups.length ? [] : ['Keine Trackpunkte mit Zeit gefunden (trkpt mit <time>).'] };
  }

  function parse(text, name = '') {
    const t = String(text || '');
    const out = /<gpx\b/i.test(t) ? parseGpx(t, name) : parseCsvLog(t, name);
    if (!out.format) return { format: null, groups: [], skipped: 0, notes: ['Format nicht erkannt. Erwartet: Server-Export, Tracker-Flash-Log, Segeluhr-Log (CSV) oder GPX.'] };
    out.groups.forEach((g) => g.points.sort((a, b) => a.ts - b.ts));
    return out;
  }

  return { parse, normTs };
}));
