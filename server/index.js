'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const store = require('./store');
const regatta = require('./regatta');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!ADMIN_TOKEN) {
  console.warn(
    '[WARNUNG] Keine ADMIN_TOKEN Umgebungsvariable gesetzt - das Admin-Panel (neue Tracker anlegen) ist ' +
    'aktuell OHNE Passwort erreichbar. Bitte in .env / docker-compose.yml setzen!'
  );
}

const app = express();
app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Hilfsfunktionen ----------

function requireAdmin(req, res, next) {
  const supplied = req.get('x-admin-token') || req.query.adminToken || '';
  if (!ADMIN_TOKEN || supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Ungueltiges oder fehlendes Admin-Token' });
  }
  next();
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// ---------- Oeffentliche API (Dashboard) ----------

// Alle Tracker inkl. letzter Position + Spur - fuer das Live-Dashboard.
app.get('/api/trackers', (req, res) => {
  res.json({ trackers: store.listPublicTrackers(), staleAfterMs: store.STALE_AFTER_MS });
});

// ---------- Tracker-API (vom Handy / DIY-Geraet aufgerufen) ----------

// Position eines einzelnen Trackers melden. Auth per Bearer-Token (pro Tracker einzigartig).
app.post('/api/trackers/:id/position', (req, res) => {
  const { id } = req.params;
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.body.token;

  if (!store.getTracker(id)) return res.status(404).json({ error: 'Tracker unbekannt' });
  if (!store.verifyToken(id, token)) return res.status(401).json({ error: 'Ungueltiges Token' });

  const { lat, lon, accuracy, speed, heading, battery, ts } = req.body || {};
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat/lon fehlen oder sind ungueltig' });
  }

  const entry = store.recordPosition(id, {
    lat,
    lon,
    accuracy: isFiniteNumber(accuracy) ? accuracy : null,
    speed: isFiniteNumber(speed) ? speed : null,
    heading: isFiniteNumber(heading) ? heading : null,
    battery: isFiniteNumber(battery) ? battery : null,
    ts: isFiniteNumber(ts) ? ts : Date.now()
  });

  broadcast({ type: 'position', tracker: store.getPublicTracker(id) });
  res.json({ ok: true, entry });
});

// Mehrere (ggf. nachgesendete) Positionen auf einmal - der Handy-Client puffert bei Funkloch.
app.post('/api/trackers/:id/positions', (req, res) => {
  const { id } = req.params;
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.body.token;
  if (!store.getTracker(id)) return res.status(404).json({ error: 'Tracker unbekannt' });
  if (!store.verifyToken(id, token)) return res.status(401).json({ error: 'Ungueltiges Token' });

  const list = Array.isArray(req.body && req.body.positions) ? req.body.positions.slice(0, 1000) : [];
  let accepted = 0;
  for (const p of list) {
    if (!p || !isFiniteNumber(p.lat) || !isFiniteNumber(p.lon) || !isFiniteNumber(p.ts)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    store.recordPosition(id, {
      lat: p.lat,
      lon: p.lon,
      accuracy: isFiniteNumber(p.accuracy) ? p.accuracy : null,
      speed: isFiniteNumber(p.speed) ? p.speed : null,
      heading: isFiniteNumber(p.heading) ? p.heading : null,
      battery: isFiniteNumber(p.battery) ? p.battery : null,
      ts: p.ts
    });
    accepted += 1;
  }
  if (accepted) broadcast({ type: 'position', tracker: store.getPublicTracker(id) });
  res.json({ ok: true, accepted });
});

// Bootsregistrierung durch den Skipper selbst (Segelnummer, Steuermann, Yardstick-Klasse).
app.put('/api/trackers/:id/registration', (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!store.getTracker(req.params.id)) return res.status(404).json({ error: 'Tracker unbekannt' });
  if (!store.verifyToken(req.params.id, token)) return res.status(401).json({ error: 'Ungueltiges Token' });
  res.json({ boat: regatta.registerBoat(req.params.id, req.body || {}) });
});

// Oeffentlich: Klassen, Registrierungen, Linie, Wettfahrten.
app.get('/api/regatta', (req, res) => res.json(regatta.publicState()));
app.get('/api/races/:id/results', (req, res) => res.json(regatta.computeResults(regatta.getRace(req.params.id))));
app.get('/api/races/:id/results.csv', (req, res) => {
  const race = regatta.getRace(req.params.id);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="ergebnis-${race.name.replace(/[^\w-]+/g, '_')}.csv"`);
  res.send(regatta.toCsv(regatta.computeResults(race)));
});

// Metadaten eines Trackers oeffentlich abrufbar (z.B. fuer die Tracker-Seite selbst: Name/Farbe anzeigen).
app.get('/api/trackers/:id', (req, res) => {
  const t = store.getPublicTracker(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tracker unbekannt' });
  res.json(t);
});

// ---------- Admin-API (Tracker anlegen/verwalten) ----------

app.get('/api/admin/trackers', requireAdmin, (req, res) => {
  res.json({ trackers: store.listTrackers() });
});

app.post('/api/admin/trackers', requireAdmin, (req, res) => {
  const tracker = store.createTracker((req.body && req.body.name) || '');
  broadcast({ type: 'tracker-created', tracker: store.getPublicTracker(tracker.id) });
  res.status(201).json({ tracker });
});

app.patch('/api/admin/trackers/:id', requireAdmin, (req, res) => {
  const t = store.renameTracker(req.params.id, req.body && req.body.name);
  if (!t) return res.status(404).json({ error: 'Tracker unbekannt' });
  broadcast({ type: 'tracker-updated', tracker: store.getPublicTracker(t.id) });
  res.json({ tracker: t });
});

app.delete('/api/admin/trackers/:id', requireAdmin, (req, res) => {
  const ok = store.deleteTracker(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Tracker unbekannt' });
  broadcast({ type: 'tracker-deleted', id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/admin/trackers/:id/reset-trail', requireAdmin, (req, res) => {
  const ok = store.clearTrail(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Tracker unbekannt' });
  broadcast({ type: 'tracker-updated', tracker: store.getPublicTracker(req.params.id) });
  res.json({ ok: true });
});

// QR-Code (PNG) mit dem Link zur Tracker-Seite - zum Scannen mit dem Handy des Skippers.
app.get('/api/admin/trackers/:id/qrcode.png', requireAdmin, async (req, res) => {
  const tracker = store.getTracker(req.params.id);
  if (!tracker) return res.status(404).json({ error: 'Tracker unbekannt' });
  const base = `${req.protocol}://${req.get('host')}`;
  const url = `${base}/t/${tracker.id}?token=${tracker.token}`;
  try {
    const png = await QRCode.toBuffer(url, { width: 320, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR-Code konnte nicht erzeugt werden' });
  }
});

// ---------- Admin-API Regatta (Wettfahrtleitung) ----------

app.post('/api/admin/classes', requireAdmin, (req, res) => {
  res.status(201).json({ class: regatta.addClass(req.body.name, req.body.yardstick) });
});
app.post('/api/admin/classes/import', requireAdmin, (req, res) => {
  res.json(regatta.importClasses(req.body.text, !!req.body.replace));
});
app.delete('/api/admin/classes/:id', requireAdmin, (req, res) => {
  regatta.deleteClass(req.params.id);
  res.json({ ok: true });
});
app.put('/api/admin/trackers/:id/registration', requireAdmin, (req, res) => {
  res.json({ boat: regatta.registerBoat(req.params.id, req.body || {}) });
});
app.delete('/api/admin/trackers/:id/registration', requireAdmin, (req, res) => {
  regatta.unregisterBoat(req.params.id);
  res.json({ ok: true });
});
app.put('/api/admin/line', requireAdmin, (req, res) => {
  res.json({ line: regatta.setLine(req.body) });
});
app.post('/api/admin/races', requireAdmin, (req, res) => {
  res.status(201).json({ race: regatta.createRace(req.body || {}) });
});
app.patch('/api/admin/races/:id', requireAdmin, (req, res) => {
  res.json({ race: regatta.updateRace(req.params.id, req.body || {}) });
});
app.delete('/api/admin/races/:id', requireAdmin, (req, res) => {
  regatta.deleteRace(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/races/:id/start', requireAdmin, (req, res) => {
  res.json({ race: regatta.startRace(req.params.id, req.body && req.body.ts) });
});
app.post('/api/admin/races/:id/clear-start', requireAdmin, (req, res) => {
  res.json({ race: regatta.clearStart(req.params.id) });
});
app.put('/api/admin/races/:id/override/:trackerId', requireAdmin, (req, res) => {
  res.json({ race: regatta.setOverride(req.params.id, req.params.trackerId, req.body || {}) });
});
app.post('/api/admin/races/:id/official', requireAdmin, (req, res) => {
  res.json({ race: regatta.setOfficial(req.params.id, !!(req.body && req.body.official)) });
});

// ---------- Seiten ----------

app.get('/t/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'tracker.html'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));


// Fehler aus der Regatta-Logik (mit .status) als JSON zurueckgeben.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 500).json({ error: err.message || 'Serverfehler' });
});

// ---------- HTTP + WebSocket Server ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', trackers: store.listPublicTrackers() }));
});

// Periodisch pruefen, ob Tracker "stale" (offline) geworden sind, damit die Karte das auch
// ohne neues Positions-Update aktualisiert (z.B. Handy hat Netz verloren).
setInterval(() => {
  broadcast({ type: 'snapshot', trackers: store.listPublicTrackers() });
}, 15000);

server.listen(PORT, () => {
  console.log(`Roemis Regatta Tracker laeuft auf http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Admin:     http://localhost:${PORT}/admin.html`);
});
