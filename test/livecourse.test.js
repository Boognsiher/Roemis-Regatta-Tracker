'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-live-'));
const regatta = require('../server/regatta');

const pt = (x, y) => ({ lat: 46.84 + y / 111320, lon: 10.52 + x / 76000 });

test('Live-Karte: nur der aufgeschaltete Kurs ist oeffentlich sichtbar, unabhaengig vom bearbeiteten Kurs', () => {
  const a = regatta.createCourse({ kind: 'bounce' });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });
  regatta.setCourse([pt(0, 800)], 250, true);
  assert.strictEqual(regatta.publicState().liveCourse, null);                  // nichts aufgeschaltet = nichts sichtbar

  regatta.setLiveCourse(a.id);
  let st = regatta.publicState();
  assert.strictEqual(st.liveCourseId, a.id);
  assert.strictEqual(st.liveCourse.marks.length, 1);
  assert.ok(st.liveCourse.line.a);

  const b = regatta.createCourse({ kind: 'loop' });                            // neuer, bearbeiteter Kurs wird aktiv
  assert.strictEqual(regatta.activeCourse().id, b.id);
  st = regatta.publicState();
  assert.strictEqual(st.liveCourse.id, a.id);                                  // aufgeschalteter Kurs bleibt A
  assert.strictEqual(st.liveCourse.marks.length, 1);

  regatta.setLiveCourse(null);
  assert.strictEqual(regatta.publicState().liveCourse, null);
  assert.throws(() => regatta.setLiveCourse('gibtsnicht'), /unbekannt/);

  regatta.setLiveCourse(a.id);
  regatta.deleteCourse(a.id);                                                  // geloeschter Kurs wird abgeschaltet
  assert.strictEqual(regatta.publicState().liveCourseId, null);
});

test('Kurs exportieren und wieder importieren (Wiederverwendung): Regeln, Linie, Ziellinie, Bojen mit Umrundungsseite', () => {
  const c = regatta.createCourse({ kind: 'distance', name: 'Langstrecke Test' });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });
  regatta.setCourse([{ ...pt(0, 1000), rounding: 'port' }, { a: pt(500, 1000), b: pt(600, 1000) }, pt(1000, 0)], 200, true);
  regatta.setFinishLine({ a: pt(900, 500), b: pt(1000, 500) });
  const file = JSON.parse(JSON.stringify(regatta.exportCourse(c.id)));
  assert.strictEqual(file.format, 'regattazeit-kurs');
  const n = regatta.importCourse(file);
  assert.notStrictEqual(n.id, c.id);
  assert.strictEqual(n.lapMode, 'distance');
  assert.strictEqual(n.course.marks.length, 3);
  assert.strictEqual(n.course.marks[0].rounding, 'port');
  assert.ok(n.course.marks[1].a && n.course.marks[1].b);
  assert.strictEqual(n.course.radiusM, 200);
  assert.ok(n.finishLine && n.finishLine.a);
  assert.deepStrictEqual(n.line, c.line);
  assert.throws(() => regatta.importCourse({ foo: 1 }), /Kurs-Datei/);
  assert.throws(() => regatta.importCourse({ format: 'regattazeit-kurs', course: { name: 'x', course: { marks: [{ lat: 999, lon: 0 }] } } }), /ungueltig/);
});
