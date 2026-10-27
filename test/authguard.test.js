'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAuthGuard } = require('../server/authguard');

function setup(opts = {}) {
  let t = 1000000;
  const g = createAuthGuard({ maxFailures: 3, windowMs: 60000, blockMs: 120000, now: () => t, log: () => {}, ...opts });
  return { g, advance: (ms) => { t += ms; } };
}

test('Sperre nach zu vielen Fehlversuchen, danach wieder frei', () => {
  const { g, advance } = setup();
  g.fail('1.1.1.1'); g.fail('1.1.1.1');
  assert.strictEqual(g.blockedFor('1.1.1.1'), 0);
  g.fail('1.1.1.1');
  assert.ok(g.blockedFor('1.1.1.1') > 0);
  assert.strictEqual(g.blockedFor('2.2.2.2'), 0); // andere IP unberuehrt
  advance(121000);
  assert.strictEqual(g.blockedFor('1.1.1.1'), 0);
});

test('Fehlversuche ausserhalb des Zeitfensters zaehlen nicht', () => {
  const { g, advance } = setup();
  g.fail('1.1.1.1'); g.fail('1.1.1.1');
  advance(61000);
  g.fail('1.1.1.1');
  assert.strictEqual(g.blockedFor('1.1.1.1'), 0);
});

test('Middleware: 429 bei gesperrter IP, 401 zaehlt, Erfolg setzt zurueck', () => {
  const { g } = setup();
  const mk = (status) => {
    const handlers = {};
    const res = { statusCode: status, set() {}, on(ev, fn) { handlers[ev] = fn; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const req = { get: () => undefined, ip: '9.9.9.9' };
    return { req, res, finish: () => handlers.finish && handlers.finish() };
  };
  for (let i = 0; i < 3; i += 1) { const m = mk(401); g.middleware(m.req, m.res, () => {}); m.finish(); }
  const blocked = mk(200);
  let nextCalled = false;
  g.middleware(blocked.req, blocked.res, () => { nextCalled = true; });
  assert.strictEqual(blocked.res.statusCode, 429);
  assert.strictEqual(nextCalled, false);
});

test('CF-Connecting-IP wird bevorzugt', () => {
  const { g } = setup();
  const req = { get: (h) => (h === 'cf-connecting-ip' ? '5.5.5.5' : undefined), ip: '10.0.0.1' };
  assert.strictEqual(g.clientIp(req), '5.5.5.5');
});
