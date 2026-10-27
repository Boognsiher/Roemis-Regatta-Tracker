'use strict';

/**
 * Bremst Passwort-Raten: Zu viele fehlgeschlagene Anmeldungen (HTTP 401) von derselben IP fuehren zu einer
 * zeitweiligen Sperre (HTTP 429). Gilt nur fuer geschuetzte Routen (Admin, Gateway, Tracker-Token), nicht fuer die
 * oeffentliche Live-Karte. Zustand liegt im Arbeitsspeicher (Neustart hebt Sperren auf).
 *
 * Hinter dem Cloudflare Tunnel ist die echte Besucher-IP im Header CF-Connecting-IP (Cloudflare setzt ihn selbst
 * und ueberschreibt Angaben des Clients); ohne Tunnel (LAN) wird req.ip benutzt.
 */

function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createAuthGuard({ maxFailures = 8, windowMs = 15 * 60 * 1000, blockMs = 15 * 60 * 1000, now = Date.now, log = console.warn } = {}) {
  /** @type {Map<string, {fails: number[], blockedUntil: number}>} */
  const state = new Map();

  function entry(ip) {
    let e = state.get(ip);
    if (!e) { e = { fails: [], blockedUntil: 0 }; state.set(ip, e); }
    return e;
  }

  function blockedFor(ip) {
    const e = state.get(ip);
    if (!e) return 0;
    const left = e.blockedUntil - now();
    return left > 0 ? left : 0;
  }

  function fail(ip) {
    const e = entry(ip);
    const t = now();
    e.fails = e.fails.filter((x) => t - x < windowMs);
    e.fails.push(t);
    if (e.fails.length >= maxFailures) {
      e.blockedUntil = t + blockMs;
      e.fails = [];
      log(`[auth] ${ip} gesperrt fuer ${Math.round(blockMs / 60000)} min nach ${maxFailures} Fehlversuchen`);
    }
  }

  function clear(ip) {
    state.delete(ip);
  }

  // Alte Eintraege aufraeumen
  const timer = setInterval(() => {
    const t = now();
    for (const [ip, e] of state) {
      if (e.blockedUntil < t && e.fails.every((x) => t - x >= windowMs)) state.delete(ip);
    }
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();

  /** Express-Middleware fuer geschuetzte Routen. */
  function middleware(req, res, next) {
    const ip = clientIp(req);
    const left = blockedFor(ip);
    if (left > 0) {
      res.set('Retry-After', String(Math.ceil(left / 1000)));
      return res.status(429).json({ error: 'Zu viele Fehlversuche - bitte spaeter erneut versuchen' });
    }
    res.on('finish', () => {
      if (res.statusCode === 401) fail(ip);
      else if (res.statusCode >= 200 && res.statusCode < 300) clear(ip); // erfolgreiche Anmeldung setzt zurueck
    });
    next();
  }

  return { middleware, fail, clear, blockedFor, clientIp };
}

module.exports = { createAuthGuard, clientIp };
