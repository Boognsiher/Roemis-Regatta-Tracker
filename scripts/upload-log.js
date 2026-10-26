#!/usr/bin/env node
'use strict';
/*
 * Spielt ein Flash-Log eines Funk-Trackers (CSV aus dem seriellen Befehl 'd') nachtraeglich auf den Server.
 * Nuetzlich, wenn per LoRa Pakete verloren gingen: das Log hat jede Sekunde eine Position.
 *
 *   node scripts/upload-log.js <server-url> <gateway-oder-admin-token> <lora-nr> <log.csv>
 *   z.B.  node scripts/upload-log.js https://regatta.example.org geheim 7 boot7.csv
 *
 * Doppelte Zeitstempel sind unkritisch - die Auswertung entfernt sie.
 */
const fs = require('fs');

const [url, token, loraId, file] = process.argv.slice(2);
if (!url || !token || !loraId || !file) {
  console.error('Aufruf: node scripts/upload-log.js <server-url> <token> <lora-nr> <log.csv>');
  process.exit(1);
}

const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
  const [ts, lat, lon, speed, heading] = line.split(',');
  return { id: Number(loraId), ts: Number(ts), lat: Number(lat), lon: Number(lon), speed: Number(speed), heading: heading === '' ? null : Number(heading) };
}).filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.lat) && Number.isFinite(r.lon));

(async () => {
  let accepted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/gateway/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gateway-token': token, 'x-admin-token': token },
      body: JSON.stringify({ positions: rows.slice(i, i + 1000) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('Fehler:', data.error || res.status); process.exit(1); }
    accepted += data.accepted;
    if (data.unknown && data.unknown.length) console.warn('Unbekannte LoRa-Nr:', data.unknown.join(', '));
  }
  console.log(`${accepted} von ${rows.length} Positionen uebernommen.`);
})();
