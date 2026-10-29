'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tracksCsv, tracksGpx } = require('../server/export');

const entries = [{
  tracker: { id: 'abc', name: 'Boot "A"; Test', loraId: 3 },
  boat: { sailNo: 'SUI 1', helm: 'Mueller & Co', className: 'Laser' },
  fixes: [
    { ts: 1760000002000, lat: 46.8451, lon: 10.5123, speed: 2.5, heading: 90, accuracy: 4, battery: 0.8 },
    { ts: 1760000001000, lat: 46.8450, lon: 10.5120, speed: null },
    { ts: 1760000001000, lat: 46.8450, lon: 10.5120, speed: null },   // Duplikat
    { ts: 1760000009000, lat: 46.8460, lon: 10.5130 }
  ]
}];

test('CSV: sortiert, ohne Duplikate, mit Zeitfenster, korrekt maskiert', () => {
  const csv = tracksCsv(entries, { to: 1760000005000 });
  const lines = csv.replace('\ufeff', '').trim().split('\r\n');
  assert.strictEqual(lines.length, 3); // Kopf + 2 Positionen
  assert.ok(lines[0].startsWith('Boot;Segelnr'));
  assert.ok(lines[1].startsWith('"Boot ""A""; Test";SUI 1;Mueller & Co;Laser;3;abc;2025-'));
  assert.ok(lines[1].includes(';46.845000;10.512000;;;;;'));      // erste Position ohne Speed/Kurs
  assert.ok(lines[2].includes(';2.50;4.86;90;4.0;80'));            // 2.5 m/s = 4.86 kn
  assert.ok(csv.startsWith('\ufeff'));
});

test('GPX: gueltige Struktur, Zeit in ISO, XML maskiert, Wegpunkte', () => {
  const gpx = tracksGpx(entries, { name: 'Lauf <1>', waypoints: [{ lat: 46.84, lon: 10.51, name: 'Boje & 1' }] });
  assert.ok(gpx.includes('<gpx version="1.1"'));
  assert.ok(gpx.includes('<name>Lauf &lt;1&gt;</name>'));
  assert.ok(gpx.includes('<wpt lat="46.840000" lon="10.510000"><name>Boje &amp; 1</name></wpt>'));
  assert.ok(gpx.includes('<name>SUI 1 Boot &quot;A&quot;; Test</name>'));
  assert.strictEqual((gpx.match(/<trkpt /g) || []).length, 3);
  assert.ok(/<time>2025-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z<\/time>/.test(gpx));
  assert.ok(gpx.includes('<extensions><speed>2.50</speed></extensions>'));
  assert.strictEqual(tracksGpx([{ tracker: { id: 'x', name: 'leer' }, fixes: [] }]).includes('<trk>'), false);
});
