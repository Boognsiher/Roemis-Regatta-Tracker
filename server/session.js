'use strict';

/**
 * Anmeldung per Passwort mit signiertem Cookie (ohne Datenbank).
 *  - Rolle "viewer": Zuschauer-Passwort (VIEWER_PASSWORD) -> Live-Karte und Ergebnisse
 *  - Rolle "admin":  ADMIN_TOKEN -> zusaetzlich Verwaltung
 * Das Cookie enthaelt nur Rolle + Ablaufzeit und ist mit HMAC signiert (kein Passwort im Cookie). Wird das Passwort
 * geaendert, werden alle bestehenden Anmeldungen ungueltig (Geheimnis haengt von den Passwoertern ab).
 * Ist kein VIEWER_PASSWORD gesetzt, ist die Karte oeffentlich (enabled = false).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'regatta_session';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function createSessions({ adminToken = '', viewerPassword = '', secret = '', ttlMs = 14 * 24 * 3600 * 1000, now = Date.now } = {}) {
  const key = crypto.createHash('sha256').update(`session|${secret}|${adminToken}|${viewerPassword}`).digest();
  const enabled = !!viewerPassword;

  function sign(payload) {
    return crypto.createHmac('sha256', key).update(payload).digest();
  }

  /** Cookie-Wert fuer eine Rolle ausstellen. */
  function issue(role) {
    const payload = b64url(JSON.stringify({ r: role, e: now() + ttlMs }));
    return `${payload}.${b64url(sign(payload))}`;
  }

  /** Rolle aus einem Cookie-Wert lesen (null = ungueltig/abgelaufen/manipuliert). */
  function verify(value) {
    if (!value || typeof value !== 'string') return null;
    const [payload, sig] = value.split('.');
    if (!payload || !sig) return null;
    const expected = sign(payload);
    let given;
    try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data || typeof data.e !== 'number' || data.e < now()) return null;
      return data.r === 'admin' || data.r === 'viewer' ? data.r : null;
    } catch {
      return null;
    }
  }

  function fromRequest(req) {
    const header = (req.headers && req.headers.cookie) || (req.get && req.get('cookie')) || '';
    return verify(parseCookies(header)[COOKIE_NAME]);
  }

  /** Passwort pruefen: Rolle oder null. Das Admin-Token gilt auch als Zuschauer-Anmeldung. */
  function checkPassword(pw) {
    if (typeof pw !== 'string' || !pw) return null;
    if (adminToken && safeEqual(pw, adminToken)) return 'admin';
    if (viewerPassword && safeEqual(pw, viewerPassword)) return 'viewer';
    return null;
  }

  function cookieHeader(value, secure) {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  function clearCookieHeader(secure) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  return { enabled, issue, verify, fromRequest, checkPassword, cookieHeader, clearCookieHeader };
}

module.exports = { createSessions, parseCookies, COOKIE_NAME };
