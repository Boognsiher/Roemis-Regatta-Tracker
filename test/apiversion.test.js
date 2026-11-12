'use strict';
const test = require('node:test');
const assert = require('node:assert');
const v = require('../server/apiversion');

test('info() liefert Major/Minor als Zahlen', () => {
  const i = v.info();
  assert.strictEqual(i.api, v.API_VERSION);
  assert.strictEqual(i.minor, v.API_MINOR);
  assert.ok(Number.isInteger(i.api) && i.api >= 1);
  assert.ok(Number.isInteger(i.minor) && i.minor >= 0);
});

test('Vertrag: dokumentierte Version stimmt mit dem Code ueberein', () => {
  const doc = require('fs').readFileSync(require('path').join(__dirname, '../docs/GATEWAY_PROTOCOL.md'), 'utf8');
  assert.ok(doc.includes(`API-Version: ${v.API_VERSION}.${v.API_MINOR}`), 'docs/GATEWAY_PROTOCOL.md nennt eine andere API-Version');
});
