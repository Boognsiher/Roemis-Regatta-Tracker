'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const store = require('./store');
const regatta = require('./regatta');
const crypto = require('crypto');
const { createAuthGuard } = require('./authguard');
const { createSessions } = require('./session');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Optional: eigenes Token nur fuer das Gateway-Handy (darf nur Positionen melden, nichts verwalten).
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
// Optional: Zuschauer-Passwort. Gesetzt -> Live-Karte und Ergebnisse nur nach Login (/login.html); leer -> oeffentlich.
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || '';
const sessions = createSessions({ adminToken: ADMIN_TOKEN, viewerPassword: VIEWER_PASSWORD, secret: process.env.SESSION_SECRET || '' });

if (!ADMIN_TOKEN) {
  console.warn(
    '[WARNUNG] Keine ADMIN_TOKEN Umgebungsvariable gesetzt - das Admin-Panel (neue Tracker anlegen) ist ' +
    'aktuell OHNE Passwort erreichbar. Bitte in .env / docker-compose.yml setzen!'
  );
}

const app = express();
app.disable('x-powered-by');
// Einfache Sicherheits-Header (keine Einbettung in fremde Seiten, kein Content-Sniffing).
// Referrer: nur die Herkunft (ohne Pfad) an fremde Server - die OSM-Kartenserver verlangen einen Referer und sperren sonst (403).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '500kb' }));

// Sperre nach wiederholten Fehlversuchen (Admin-, Gateway- und Tracker-Token)
const authGuard = createAuthGuard({
  maxFailures: parseInt(process.env.AUTH_MAX_FAILURES || '8', 10),
  blockMs: parseInt(process.env.AUTH_BLOCK_MINUTES || '15', 10) * 60 * 1000
});
app.use('/api/admin', authGuard.middleware);
app.use('/api/gateway', authGuard.middleware);

// Seiten fuer Zuschauer nur mit Anmeldung (sonst Weiterleitung zur Login-Seite). Verwaltung, Gateway- und Tracker-Seiten
// sind nicht betroffen: dort schuetzen Tokens die Daten.
const VIEWER_PAGES = new Set(['/', '/index.html', '/results.html']);
app.use((req, res, next) => {
  if (sessions.enabled && req.method === 'GET' && VIEWER_PAGES.has(req.path) && !sessions.fromRequest(req)) {
    return res.redirect(`/login.html?next=${encodeURIComponent(req.path === '/' ? '/index.html' : req.path)}`);
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Hilfsfunktionen ----------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isSecure(req) {
  return req.secure || /https/i.test(req.get('x-forwarded-proto') || '') || /https/i.test(req.get('cf-visitor') || '');
}

// Das Token wird nur noch im Header akzeptiert (nicht in der URL, sonst landet es in Logs/Verlauf).
// Alternativ gilt eine Admin-Anmeldung per Cookie (POST /api/login mit dem Admin-Token).
function requireAdmin(req, res, next) {
  const supplied = req.get('x-admin-token') || '';
  if (ADMIN_TOKEN && supplied && safeEqual(supplied, ADMIN_TOKEN)) return next();
  if (ADMIN_TOKEN && sessions.fromRequest(req) === 'admin') return next();
  return res.status(401).json({ error: 'Ungueltiges oder fehlendes Admin-Token' });
}

// Lesezugriff auf Karte/Ergebnisse: ohne VIEWER_PASSWORD offen; sonst Anmeldung (Cookie) ODER Admin-/Gateway-Token
// im Header ODER Token eines Trackers (fuer die Tracker-Seite im Handy).
function requireViewer(req, res, next) {
  if (!sessions.enabled) return next();
  if (sessions.fromRequest(req)) return next();
  const admin = req.get('x-admin-token') || '';
  const gw = req.get('x-gateway-token') || '';
  if (ADMIN_TOKEN && admin && safeEqual(admin, ADMIN_TOKEN)) return next();
  if (GATEWAY_TOKEN && gw && safeEqual(gw, GATEWAY_TOKEN)) return next();
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ') && store.findTrackerByToken(auth.slice(7))) return next();
  return res.status(401).json({ error: 'Anmeldung erforderlich' });
}

// ---------- Anmeldung (Cookie) ----------

// Zuschauer-Passwort oder Admin-Token -> Cookie. Falsche Eingaben zaehlen fuer die Sperre (authGuard).
app.post('/api/login', authGuard.middleware, (req, res) => {
  const role = sessions.checkPassword(req.body && req.body.password);
  if (!role) return res.status(401).json({ error: 'Passwort falsch' });
  res.set('Set-Cookie', sessions.cookieHeader(sessions.issue(role), isSecure(req)));
  res.json({ ok: true, role });
});

app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', sessions.clearCookieHeader(isSecure(req)));
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ enabled: sessions.enabled, role: sessions.fromRequest(req) });
});

function requireGateway(req, res, next) {
  const admin = req.get('x-admin-token') || '';
  const gw = req.get('x-gateway-token') || '';
  const ok = (ADMIN_TOKEN && safeEqual(admin, ADMIN_TOKEN)) || (GATEWAY_TOKEN && safeEqual(gw, GATEWAY_TOKEN));
  if (!ok) return res.status(401).json({ error: 'Ungueltiges Gateway-/Admin-Token' });
  next();
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// ---------- Oeffentliche API (Dashboard) ----------

// Alle Tracker inkl. letzter Position + Spur - fuer das Live-Dashboard.
app.get('/api/trackers', requireViewer, (req, res) => {
  res.json({ trackers: store.listPublicTrackers(), staleAfterMs: store.STALE_AFTER_MS });
});

// ---------- Tracker-API (vom Handy / DIY-Geraet aufgerufen) ----------

// Position eines einzelnen Trackers melden. Auth per Bearer-Token (pro Tracker einzigartig).
app.post('/api/trackers/:id/position', authGuard.middleware, (req, res) => {
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

  broadcast({ type: 'position', tracker: store.getPublicTracker(id, { trail: false }) });
  res.json({ ok: true, entry });
});

// Mehrere (ggf. nachgesendete) Positionen auf einmal - der Handy-Client puffert bei Funkloch.
app.post('/api/trackers/:id/positions', authGuard.middleware, (req, res) => {
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
  if (accepted) broadcast({ type: 'position', tracker: store.getPublicTracker(id, { trail: false }) });
  res.json({ ok: true, accepted });
});

// Bootsregistrierung durch den Skipper selbst (Segelnummer, Steuermann, Yardstick-Klasse).
app.put('/api/trackers/:id/registration', authGuard.middleware, (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!store.getTracker(req.params.id)) return res.status(404).json({ error: 'Tracker unbekannt' });
  if (!store.verifyToken(req.params.id, token)) return res.status(401).json({ error: 'Ungueltiges Token' });
  res.json({ boat: regatta.registerBoat(req.params.id, req.body || {}) });
});

// Oeffentlich: Klassen, Registrierungen, Linie, Wettfahrten.
app.get('/api/regatta', requireViewer, (req, res) => res.json(regatta.publicState()));
app.get('/api/races/:id/results', requireViewer, (req, res) => res.json(regatta.computeResults(regatta.getRace(req.params.id))));
app.get('/api/races/:id/results.csv', requireViewer, (req, res) => {
  const race = regatta.getRace(req.params.id);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="ergebnis-${race.name.replace(/[^\w-]+/g, '_')}.csv"`);
  res.send(regatta.toCsv(regatta.computeResults(race)));
});

// Metadaten eines Trackers oeffentlich abrufbar (z.B. fuer die Tracker-Seite selbst: Name/Farbe anzeigen).
app.get('/api/trackers/:id', requireViewer, (req, res) => {
  const t = store.getPublicTracker(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tracker unbekannt' });
  res.json(t);
});

// ---------- Gateway-API (Handy mit LoRa-Master-ESP32) ----------

// Mehrere Positionen verschiedener Boote auf einmal. Jeder Eintrag identifiziert das Boot entweder
// ueber die LoRa-Nummer ("id") oder direkt ueber "trackerId" (z.B. Handy-GPS des eigenen Boots).
app.post('/api/gateway/positions', requireGateway, (req, res) => {
  const list = Array.isArray(req.body && req.body.positions) ? req.body.positions.slice(0, 2000) : [];
  const touched = new Set();
  const unknown = new Set();
  let accepted = 0;
  const maxTs = Date.now() + 5 * 60 * 1000;
  for (const p of list) {
    if (!p || !isFiniteNumber(p.lat) || !isFiniteNumber(p.lon) || !isFiniteNumber(p.ts)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || p.ts > maxTs) continue;
    const tracker = p.trackerId ? store.getTracker(p.trackerId) : store.getTrackerByLoraId(p.id);
    if (!tracker) { unknown.add(p.trackerId || p.id); continue; }
    store.recordPosition(tracker.id, {
      lat: p.lat,
      lon: p.lon,
      accuracy: isFiniteNumber(p.accuracy) ? p.accuracy : null,
      speed: isFiniteNumber(p.speed) ? p.speed : null,
      heading: isFiniteNumber(p.heading) ? p.heading : null,
      battery: isFiniteNumber(p.battery) ? p.battery : null,
      ts: p.ts
    });
    touched.add(tracker.id);
    accepted += 1;
  }
  for (const id of touched) broadcast({ type: 'position', tracker: store.getPublicTracker(id, { trail: false }) });
  res.json({ ok: true, accepted, unknown: [...unknown] });
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
  if (req.body && 'loraId' in req.body) {
    const n = req.body.loraId === null || req.body.loraId === '' ? null : Number(req.body.loraId);
    const err = store.setLoraId(req.params.id, n);
    if (err) return res.status(400).json({ error: err });
  }
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
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Live-Verbindung nur mit gueltiger Anmeldung (Cookie wird vom Browser beim Verbinden mitgeschickt)
  verifyClient: (info, done) => {
    if (!sessions.enabled || sessions.fromRequest(info.req)) return done(true);
    done(false, 401, 'Anmeldung erforderlich');
  }
});

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
  broadcast({ type: 'status', stale: store.staleMap() }); // klein (nur Online/Offline) und haelt die Verbindung offen
}, 15000);

server.listen(PORT, () => {
  console.log(`Roemis Regatta Tracker laeuft auf http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Admin:     http://localhost:${PORT}/admin.html`);
});
