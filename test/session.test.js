'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessions, parseCookies, COOKIE_NAME } = require('../server/session');

function make(opts = {}) {
  let t = 1000000;
  const s = createSessions({ adminToken: 'admintoken', viewerPassword: 'zuschauer', now: () => t, ttlMs: 60000, ...opts });
  return { s, advance: (ms) => { t += ms; } };
}

test('Passwoerter: Zuschauer, Admin, falsch', () => {
  const { s } = make();
  assert.strictEqual(s.checkPassword('zuschauer'), 'viewer');
  assert.strictEqual(s.checkPassword('admintoken'), 'admin');
  assert.strictEqual(s.checkPassword('falsch'), null);
  assert.strictEqual(s.checkPassword(''), null);
  assert.strictEqual(s.checkPassword(undefined), null);
});

test('Cookie: Ausstellen, Pruefen, Ablauf', () => {
  const { s, advance } = make();
  const c = s.issue('viewer');
  assert.strictEqual(s.verify(c), 'viewer');
  assert.strictEqual(s.verify(s.issue('admin')), 'admin');
  advance(61000);
  assert.strictEqual(s.verify(c), null);
});

test('Cookie: Manipulation und fremde Signatur werden abgelehnt', () => {
  const { s } = make();
  const c = s.issue('viewer');
  const [payload, sig] = c.split('.');
  const forged = Buffer.from(JSON.stringify({ r: 'admin', e: 9e15 })).toString('base64url') + '.' + sig;
  assert.strictEqual(s.verify(forged), null);
  assert.strictEqual(s.verify(payload + '.AAAA'), null);
  assert.strictEqual(s.verify('muell'), null);
  const other = createSessions({ adminToken: 'admintoken', viewerPassword: 'zuschauer', secret: 'anders' });
  assert.strictEqual(other.verify(c), null);
});

test('Passwortwechsel macht alte Anmeldungen ungueltig', () => {
  const a = createSessions({ adminToken: 'x', viewerPassword: 'alt' });
  const b = createSessions({ adminToken: 'x', viewerPassword: 'neu' });
  assert.strictEqual(b.verify(a.issue('viewer')), null);
});

test('enabled nur mit Zuschauer-Passwort; Cookie-Parsing und Header', () => {
  assert.strictEqual(createSessions({ adminToken: 'a' }).enabled, false);
  const { s } = make();
  assert.strictEqual(s.enabled, true);
  const c = s.issue('viewer');
  assert.strictEqual(s.fromRequest({ headers: { cookie: `a=1; ${COOKIE_NAME}=${c}; b=2` } }), 'viewer');
  assert.strictEqual(s.fromRequest({ headers: {} }), null);
  assert.deepStrictEqual(parseCookies('a=1; b=2=3'), { a: '1', b: '2=3' });
  assert.ok(s.cookieHeader(c, true).includes('HttpOnly') && s.cookieHeader(c, true).includes('Secure'));
  assert.ok(!s.cookieHeader(c, false).includes('Secure'));
  assert.ok(s.clearCookieHeader(false).includes('Max-Age=0'));
});
