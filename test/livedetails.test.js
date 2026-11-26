'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-details-'));
const store = require('../server/store');
const regatta = require('../server/regatta');

const lat0 = 46.84, lon0 = 10.52;
const mLon = (Math.PI / 180) * 6371000 * Math.cos((lat0 * Math.PI) / 180);
const mLat = (Math.PI / 180) * 6371000;
const pt = (x, y) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon });
const GUN = Date.UTC(2026, 6, 4, 9, 0, 0);

/** Von (0,-200) mit 4 m/s nach Norden, ab t0, bis y = yEnd. */
function north(t0, yEnd) {
  const out = [];
  for (let t = 0; ; t += 1) {
    const y = -200 + 4 * t;
    if (y > yEnd) break;
    out.push({ ...pt(0, y), ts: t0 + t * 1000, speed: 4 });
  }
  return out;
}

test('Live-Details: naechste Boje, Distanz, VMG, Boot davor/dahinter', () => {
  const cls = regatta.addClass('YS100', 100);
  const a = store.createTracker('Vorn');
  const b = store.createTracker('Hinten');
  regatta.registerBoat(a.id, { sailNo: '1', helm: 'a', classId: cls.id });
  regatta.registerBoat(b.id, { sailNo: '2', helm: 'b', classId: cls.id });
  regatta.createCourse({ kind: 'bounce' });
  regatta.setLine({ a: pt(-50, 0), b: pt(50, 0), mark: pt(0, 400) });
  regatta.setCourse([pt(0, 800)], 250, true);
  // A faehrt bei GUN los (bei y=600 nach 200 s), B 30 s spaeter (dann bei y=480)
  for (const f of north(GUN, 600)) store.recordPosition(a.id, f);
  for (const f of north(GUN + 30000, 480)) store.recordPosition(b.id, f);
  const race = regatta.createRace({ name: 'D', laps: 1, lapMode: 'bounce', startTs: GUN });
  const live = regatta.computeLive(race, GUN + 200000);
  const ea = live.entries.find((e) => e.trackerId === a.id);
  const eb = live.entries.find((e) => e.trackerId === b.id);
  assert.strictEqual(ea.status, 'RACING');
  assert.strictEqual(ea.nextMark.label, 'Boje 1');
  assert.ok(Math.abs(ea.nextMark.distM - 200) < 15, `Distanz ${ea.nextMark.distM}`);
  assert.ok(ea.nextMark.bearingDeg <= 2 || ea.nextMark.bearingDeg >= 358);
  assert.ok(ea.headingDeg <= 2 || ea.headingDeg >= 358);
  assert.ok(ea.vmgKn > 6 && ea.vmgKn < 9, `VMG ${ea.vmgKn}`);          // 4 m/s = 7,8 kn direkt auf die Boje zu
  assert.strictEqual(ea.ahead, null);
  assert.ok(ea.behind && Math.abs(ea.behind.courseM - 120) < 15 && Math.abs(ea.behind.directM - 120) < 15, JSON.stringify(ea.behind));
  assert.ok(eb.ahead && eb.ahead.name.includes('Vorn') && Math.abs(eb.ahead.courseM - 120) < 15);
  assert.strictEqual(eb.behind, null);
  assert.ok(ea.pos && Math.abs(ea.pos.lat - pt(0, 600).lat) < 1e-4);
  assert.strictEqual(eb.rankAhead.name.includes('Vorn'), true);
  assert.strictEqual(ea.rankBehind.name.includes('Hinten'), true);
});
