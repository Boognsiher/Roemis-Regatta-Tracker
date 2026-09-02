'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const store = require('./store');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!ADMIN_TOKEN) {
  console.warn(
    '[WARNUNG] Keine ADMIN_TOKEN Umgebungsvariable gesetzt - das Admin-Panel (neue Tracker anlegen) ist ' +
    'aktuell OHNE Passwort erreichbar. Bitte in .env / docker-compose.yml setzen!'
  );
}

const app = express();
app.use(express.json({ limit: '20kb' }));
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

// ---------- Seiten ----------

app.get('/t/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'tracker.html'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

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
