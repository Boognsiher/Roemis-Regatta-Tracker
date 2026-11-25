'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ImportLog = require('../public/js/importlog.js');

test('Server-Export (Semikolon, BOM): Gruppen je Boot, Akku und Tempo', () => {
  const txt = '﻿Boot;Segelnr;Steuermann;Klasse;LoRa-Nr;Tracker-ID;Zeit_UTC;ts_ms;lat;lon;Speed_m/s;Speed_kn;Kurs_Grad;Genauigkeit_m;Akku_%\n' +
    'Master;;;;1;54qvek;2026-11-24T20:55:24.973Z;1795553724973;47.242820;8.719563;0.00;0.00;;6.5;63\n' +
    'Master;;;;1;54qvek;2026-11-24T20:55:29.976Z;1795553729976;47.242824;8.719563;1.50;2.9;90;6.3;63\n' +
    'Boot2;;;;2;abc;2026-11-24T20:55:30.000Z;1795553730000;47.3;8.8;2.00;3.9;180;5;80\n';
  const r = ImportLog.parse(txt, 'positionen.csv');
  assert.match(r.format, /Server-Export/);
  assert.strictEqual(r.groups.length, 2);
  const m = r.groups.find((g) => g.loraId === 1);
  assert.strictEqual(m.points.length, 2);
  assert.strictEqual(m.points[1].speed, 1.5);
  assert.ok(Math.abs(m.points[0].battery - 0.63) < 1e-9);
  assert.strictEqual(r.groups.find((g) => g.loraId === 2).points[0].heading, 180);
});

test('Tracker-Flash-Log (d-Befehl): eine Gruppe, Zeile ohne Heading', () => {
  const txt = 'ts_ms,lat,lon,speed_ms,heading_deg\n1795553724000,47.1,8.7,2.5,\n1795553725000,47.1001,8.7,2.6,91.5\nkaputt,zeile\n';
  const r = ImportLog.parse(txt, 'boot2.csv');
  assert.match(r.format, /Flash-Log/);
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].label, 'boot2');
  assert.strictEqual(r.groups[0].points.length, 2);
  assert.strictEqual(r.groups[0].points[0].heading, null);
  assert.strictEqual(r.skipped, 1);
});

test('Segeluhr-Tracker-Log: Lebenszeichen ohne Fix und Marker-Zeilen werden uebersprungen, GPS-Zeit aus pkt_ts_ms', () => {
  const head = 'ts_iso,ts_epoch_ms,source,tracker_id,pkt_ts_ms,lat,lon,speed_ms,heading_deg,battery_pct,hdop,rssi_dbm,snr_db,gps_fix,accuracy_m,event\n';
  const txt = head +
    '05:19:24,1794975564398,TRACKER,1,,,,,,92,,0,0.0,0,,OHNE_FIX gpsState=1 sats=0\n' +
    '05:25:30,1794975930000,TRACKER,2,1794975929500,46.84,10.5,3.2,90.0,90,1.2,-40,12.0,1,6.0,\n' +
    '05:25:31,1794975931000,EIGEN,own,1794975931000,46.8401,10.5001,3.3,91,87,,,,1,3.8,\n' +
    '05:25:32,1794975932000,EVENT,,,,,,,,,,,,,MARKER\n';
  const r = ImportLog.parse(txt, 'trackerlog.csv');
  assert.match(r.format, /Tracker-Log/);
  assert.strictEqual(r.groups.length, 2);
  const t2 = r.groups.find((g) => g.loraId === 2);
  assert.strictEqual(t2.points[0].ts, 1794975929500);
  assert.ok(Math.abs(t2.points[0].accuracy - 6.0) < 1e-9);
  assert.ok(r.groups.find((g) => g.own));
  assert.strictEqual(r.skipped, 1);   // nur das Lebenszeichen ohne Position (EVENT-Zeile zaehlt nicht)
  assert.ok(r.notes.length >= 1);
});

test('Segeluhr-Diagnose-Log: Knoten werden zu m/s, ungueltige Fixes uebersprungen', () => {
  const txt = 'ts_iso,ts_epoch_ms,lat,lon,sog_kn,cog_deg,gps_valid,gps_accuracy_m\n' +
    '05:22:26,1794889346926,,,,,false,\n05:22:29,1794889349718,47.2426046,8.7196771,2.0,164.4,true,9.0\n';
  const r = ImportLog.parse(txt, 'diagnose.csv');
  assert.match(r.format, /Diagnose/);
  assert.strictEqual(r.groups[0].points.length, 1);
  assert.ok(Math.abs(r.groups[0].points[0].speed - 2 * 0.514444) < 1e-6);
});

test('GPX: Trackpunkte mit Zeit, Gruppen je Strecke, Punkte ohne Zeit werden uebersprungen', () => {
  const gpx = '<?xml version="1.0"?><gpx><trk><name>Fahrt 1</name><trkseg>' +
    '<trkpt lat="46.84" lon="10.51"><time>2026-11-24T10:00:00Z</time></trkpt>' +
    '<trkpt lat="46.8401" lon="10.5101"><time>2026-11-24T10:00:01Z</time></trkpt>' +
    '<trkpt lat="46.8402" lon="10.5102"></trkpt></trkseg></trk>' +
    '<trk><trkseg><trkpt lat="47" lon="8"><time>2026-11-24T11:00:00Z</time></trkpt></trkseg></trk></gpx>';
  const r = ImportLog.parse(gpx, 'x.gpx');
  assert.strictEqual(r.format, 'GPX');
  assert.strictEqual(r.groups.length, 2);
  assert.strictEqual(r.groups[0].label, 'Fahrt 1');
  assert.strictEqual(r.groups[0].points.length, 2);
  assert.strictEqual(r.groups[0].points[0].ts, Date.parse('2026-11-24T10:00:00Z'));
  assert.strictEqual(r.skipped, 1);
});

test('Unbekanntes Format und Sekunden-Zeitstempel', () => {
  const r = ImportLog.parse('a,b,c\n1,2,3\n', 'x.csv');
  assert.strictEqual(r.format, null);
  assert.ok(r.notes[0].includes('nicht erkannt'));
  assert.strictEqual(ImportLog.normTs(1795553724), 1795553724000);
  assert.strictEqual(ImportLog.normTs(1795553724973), 1795553724973);
  assert.strictEqual(ImportLog.normTs('x'), null);
});
