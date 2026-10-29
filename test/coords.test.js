'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../public/js/coords.js');

const near = (p, lat, lon, eps = 1e-5) => p && Math.abs(p.lat - lat) < eps && Math.abs(p.lon - lon) < eps;

test('Dezimalgrad in den ueblichen Schreibweisen', () => {
  assert.ok(near(C.parse('46.8419, 10.5130'), 46.8419, 10.513));
  assert.ok(near(C.parse('46.8419 10.5130'), 46.8419, 10.513));
  assert.ok(near(C.parse('  46.8419,10.5130  '), 46.8419, 10.513));
  assert.ok(near(C.parse('46,8419; 10,5130'), 46.8419, 10.513));        // deutsche Dezimalkomma
  assert.ok(near(C.parse('46,8419 10,5130'), 46.8419, 10.513));
  assert.ok(near(C.parse('(46.8419, 10.5130)'), 46.8419, 10.513));
  assert.ok(near(C.parse('-33.8688, 151.2093'), -33.8688, 151.2093));
});

test('Himmelsrichtungen, auch vertauscht, und O fuer Ost', () => {
  assert.ok(near(C.parse('N 46.8419 E 10.5130'), 46.8419, 10.513));
  assert.ok(near(C.parse('46.8419N 10.5130E'), 46.8419, 10.513));
  assert.ok(near(C.parse('46.8419° N, 10.5130° O'), 46.8419, 10.513));
  assert.ok(near(C.parse('E 10.5130 N 46.8419'), 46.8419, 10.513));      // Laenge zuerst, aber beschriftet
  assert.ok(near(C.parse('33.8688 S 151.2093 E'), -33.8688, 151.2093));
  assert.ok(near(C.parse('12.5 N 70.25 W'), 12.5, -70.25));
});

test('Grad und Dezimalminuten, Grad/Minuten/Sekunden', () => {
  assert.ok(near(C.parse("46°50.514' N, 10°30.780' E"), 46 + 50.514 / 60, 10 + 30.78 / 60));
  assert.ok(near(C.parse('46°50\'30.5"N 10°30\'46.8"E'), 46 + 50 / 60 + 30.5 / 3600, 10 + 30 / 60 + 46.8 / 3600));
  assert.ok(near(C.parse('46° 50′ 30.5″ N 10° 30′ 46.8″ E'), 46 + 50 / 60 + 30.5 / 3600, 10 + 30 / 60 + 46.8 / 3600));
  assert.ok(near(C.parse('N46°50.514 E10°30.780'), 46 + 50.514 / 60, 10 + 30.78 / 60));
});

test('ungueltige Eingaben werden abgelehnt', () => {
  assert.strictEqual(C.parse(''), null);
  assert.strictEqual(C.parse('hallo'), null);
  assert.strictEqual(C.parse('46.8419'), null);
  assert.strictEqual(C.parse('95.0, 10.0'), null);          // Breite > 90
  assert.strictEqual(C.parse('46.0, 190.0'), null);         // Laenge > 180
  assert.strictEqual(C.parse("46°75' N 10°30' E"), null);   // Minuten >= 60
  assert.strictEqual(C.parse(null), null);
});

test('mehrere Zeilen, Fehlerzeilen, Formatierung', () => {
  const r = C.parseLines('46.8419, 10.5130\n\nkaputt\n46.8300 10.5200\n');
  assert.strictEqual(r.points.length, 2);
  assert.deepStrictEqual(r.errors, [3]);
  assert.strictEqual(C.format({ lat: 46.8419, lon: 10.513 }), '46.841900, 10.513000');
  assert.strictEqual(C.formatDM({ lat: 46.8419, lon: 10.513 }), "46°50.514' N, 10°30.780' E");
  const rt = C.parse(C.formatDM({ lat: 46.8419, lon: 10.513 }));
  assert.ok(near(rt, 46.8419, 10.513, 1e-4));
});
