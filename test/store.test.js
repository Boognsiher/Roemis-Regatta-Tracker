'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-store-'));
const store = require('../server/store');

test('decimate haelt Anfang/Ende und begrenzt die Anzahl', () => {
  const arr = Array.from({ length: 1000 }, (_, i) => ({ ts: i }));
  const d = store.decimate(arr, 150);
  assert.strictEqual(d.length, 150);
  assert.strictEqual(d[0].ts, 0);
  assert.strictEqual(d[d.length - 1].ts, 999);
  assert.strictEqual(store.decimate(arr.slice(0, 50), 150).length, 50);
});

test('Live-Update ohne Spur ist klein, erstes Laden mit ausgeduennter Spur', () => {
  const t = store.createTracker('T');
  for (let i = 0; i < 1000; i += 1) store.recordPosition(t.id, { lat: 47 + i * 1e-5, lon: 10, ts: 1760000000000 + i * 1000 });
  const lite = store.getPublicTracker(t.id, { trail: false });
  const full = store.getPublicTracker(t.id);
  assert.strictEqual(lite.trail, undefined);
  assert.ok(JSON.stringify(lite).length < 500, 'Update soll klein sein');
  assert.ok(full.trail.length <= 150);
  assert.ok(JSON.stringify(full).length < 25000);
  assert.strictEqual(typeof store.staleMap()[t.id], 'boolean');
});

test('readHistoryCached liest inkrementell und ueberspringt defekte/halbe Zeilen', () => {
  const t = store.createTracker('Inc');
  store.recordPosition(t.id, { lat: 47, lon: 10, ts: 1000 });
  store.recordPosition(t.id, { lat: 47, lon: 10, ts: 2000 });
  assert.strictEqual(store.readHistoryCached(t.id).length, 2);
  const file = path.join(process.env.DATA_DIR, 'history', `${t.id}.jsonl`);
  fs.appendFileSync(file, 'defekt\n{"lat":47,"lon":10,"ts":2500}\n{"lat":47,"lon":10,"ts":30');  // halbe Zeile am Ende
  assert.strictEqual(store.readHistoryCached(t.id).length, 3);   // Zeile 3 ok, halbe noch nicht
  fs.appendFileSync(file, '00}\n');
  assert.strictEqual(store.readHistoryCached(t.id).length, 4);   // jetzt vollstaendig
  const sum = store.historySummary().find((x) => x.trackerId === t.id);
  assert.deepStrictEqual([sum.count, sum.firstTs, sum.lastTs], [4, 1000, 3000]);
  store.deleteTracker(t.id);
  assert.strictEqual(store.readHistoryCached(t.id).length, 0);
});

test('Konfigurations-Ablage pro Tracker: speichern, lesen, mit dem Tracker loeschen', () => {
  const t = store.createTracker('Cfg');
  assert.strictEqual(store.getConfig(t.id), null);
  assert.strictEqual(store.setConfig('gibtsnicht', { a: 1 }), null);
  const saved = store.setConfig(t.id, { waypoints: [1, 2], profile: 'x' });
  assert.deepStrictEqual(store.getConfig(t.id).data, { waypoints: [1, 2], profile: 'x' });
  assert.ok(saved.updatedAt > 0);
  store.flush();
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'configs.json')));
  store.deleteTracker(t.id);
  assert.strictEqual(store.getConfig(t.id), null);
});

test('Lebenszeichen ohne Fix: alte Position bleibt, ohne Position nichts angezeigt, Historie unberuehrt', () => {
  const t = store.createTracker('HB');
  // noch nie eine Position: Status wird gemerkt, aber es gibt keine Position
  store.recordStatus(t.id, { ts: Date.now(), battery: 0.5 });
  let pub = store.getPublicTracker(t.id);
  assert.strictEqual(pub.latest, null);
  assert.strictEqual(pub.status.battery, 0.5);
  assert.strictEqual(pub.noFix, true);
  assert.strictEqual(store.readHistoryCached(t.id).length, 0);
  // mit alter Position: bleibt unveraendert
  store.recordPosition(t.id, { lat: 47, lon: 10, ts: Date.now() - 5 * 60 * 1000, battery: 0.9 });
  store.recordStatus(t.id, { ts: Date.now(), battery: 0.45, rssi: -80 });
  pub = store.getPublicTracker(t.id);
  assert.strictEqual(pub.latest.lat, 47);
  assert.strictEqual(pub.status.battery, 0.45);
  assert.strictEqual(pub.noFix, true);
  assert.strictEqual(pub.online, true);
  assert.strictEqual(store.readHistoryCached(t.id).length, 1);
  // frische Position: kein noFix mehr
  store.recordPosition(t.id, { lat: 47.1, lon: 10, ts: Date.now() });
  assert.strictEqual(store.getPublicTracker(t.id).noFix, false);
  assert.strictEqual(store.recordStatus('gibtsnicht', { ts: 1 }), null);
});
