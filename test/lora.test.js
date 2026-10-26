'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/js/lora-packet.js');

test('Paket Encode/Decode Rundlauf', () => {
  const src = { id: 7, ts: 1760000123450, lat: 47.123456, lon: 8.654321, speed: 3.21, heading: 215.4, battery: 0.82, hdop: 1.3 };
  const d = P.decode(P.encode(src));
  assert.strictEqual(d.id, 7);
  assert.strictEqual(d.ts, 1760000123450);
  assert.ok(Math.abs(d.lat - src.lat) < 1e-6 && Math.abs(d.lon - src.lon) < 1e-6);
  assert.ok(Math.abs(d.speed - 3.21) < 0.01);
  assert.ok(Math.abs(d.heading - 215.4) < 0.1);
  assert.ok(Math.abs(d.battery - 0.82) < 0.01);
  assert.ok(Math.abs(d.hdop - 1.3) < 0.1);
});

test('Unbekannte Werte, falsche Magic, RSSI-Anhang', () => {
  const e = P.encode({ id: 1, ts: 1000, lat: -33.9, lon: 151.2 });
  const d = P.decode(e);
  assert.strictEqual(d.heading, null);
  assert.strictEqual(d.battery, null);
  assert.strictEqual(P.decode(new Uint8Array(21)), null);
  const withMeta = new Uint8Array(24);
  withMeta.set(e);
  new DataView(withMeta.buffer).setInt16(21, -97, true);
  new DataView(withMeta.buffer).setInt8(23, -20);
  const m = P.decode(withMeta);
  assert.strictEqual(m.rssi, -97);
  assert.strictEqual(m.snr, -5);
});
