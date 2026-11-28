'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

/** Startet den Server mit eigener Konfiguration auf einem freien Port und liefert { base, stop }. */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 3200 + Math.floor(Math.random() * 600);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-analysis-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let done = false;
    const onData = (buf) => {
      if (!done && /laeuft auf/.test(String(buf))) { done = true; resolve({ base: `http://127.0.0.1:${port}`, stop: () => child.kill() }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    child.on('error', reject);
    setTimeout(() => { if (!done) { child.kill(); reject(new Error('Server startet nicht')); } }, 8000);
  });
}

const TOKEN = 'a'.repeat(32);

test('Analyse-Zugang: nur Lesen auf freigegebenen Pfaden, alles andere gesperrt', async () => {
  const s = await startServer({ ADMIN_TOKEN: 'admin-token-fuer-den-test-1234', ANALYSIS_TOKEN: TOKEN, VIEWER_PASSWORD: 'zuschauer' });
  try {
    const get = (p, h) => fetch(s.base + p, { headers: h });
    const A = { 'x-analysis-token': TOKEN };
    // ohne Token: Viewer-Daten und Admin-Exporte gesperrt (Zuschauer-Passwort ist gesetzt)
    assert.strictEqual((await get('/api/regatta')).status, 401);
    assert.strictEqual((await get('/api/admin/export/tracks.csv')).status, 401);
    // mit Analyse-Token: Lesen erlaubt
    assert.strictEqual((await get('/api/regatta', A)).status, 200);
    assert.strictEqual((await get('/api/trackers', A)).status, 200);
    const csv = await get('/api/admin/export/tracks.csv', A);
    assert.strictEqual(csv.status, 200);
    assert.strictEqual((await get('/api/admin/history/summary', A)).status, 200);
    // nicht freigegebene Lese-Pfade (Admin-Verwaltung, enthaelt Tracker-Tokens) und jedes Schreiben: 403
    assert.strictEqual((await get('/api/admin/trackers', A)).status, 403);
    const post = await fetch(`${s.base}/api/admin/classes`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', yardstick: 100 }) });
    assert.strictEqual(post.status, 403);
    const del = await fetch(`${s.base}/api/admin/races/abc`, { method: 'DELETE', headers: A });
    assert.strictEqual(del.status, 403);
    // falscher Token: 401
    assert.strictEqual((await get('/api/regatta', { 'x-analysis-token': 'b'.repeat(32) })).status, 401);
  } finally { s.stop(); }
});

test('Analyse-Zugang ist aus, wenn kein Token gesetzt oder er zu kurz ist', async () => {
  const s = await startServer({ ADMIN_TOKEN: 'admin-token-fuer-den-test-1234', ANALYSIS_TOKEN: 'kurz', VIEWER_PASSWORD: 'zuschauer' });
  try {
    const r = await fetch(`${s.base}/api/regatta`, { headers: { 'x-analysis-token': 'kurz' } });
    assert.strictEqual(r.status, 401);
  } finally { s.stop(); }
});
