/**
 * Funkprotokoll Tracker -> Master (LoRa) -> Handy (BLE). Muss mit firmware/include/protocol.h
 * uebereinstimmen. Little-Endian.
 *
 *  0  u8   magic (0xA7)
 *  1  u8   Tracker-Nr (1..250)
 *  2  u32  GPS-Zeit, Sekunden seit 1970 (UTC)
 *  6  u8   Hundertstelsekunden (0..99)
 *  7  i32  Breite  in 1e-6 Grad
 * 11  i32  Laenge  in 1e-6 Grad
 * 15  u16  Geschwindigkeit in cm/s
 * 17  u16  Kurs in 0.1 Grad (0xFFFF = unbekannt)
 * 19  u8   Akku in % (255 = unbekannt)
 * 20  u8   HDOP * 10 (255 = unbekannt)
 * Der Master haengt beim Weiterreichen ans Handy an (24 Byte gesamt):
 * 21  i16  RSSI dBm
 * 23  i8   SNR * 4 dB
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LoraPacket = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAGIC = 0xA7;
  const LEN = 21;

  function decode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (u8.length < LEN || u8[0] !== MAGIC) return null;
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const lat = v.getInt32(7, true) / 1e6;
    const lon = v.getInt32(11, true) / 1e6;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const heading = v.getUint16(17, true);
    const bat = v.getUint8(19);
    const hdop = v.getUint8(20);
    const out = {
      id: v.getUint8(1),
      ts: v.getUint32(2, true) * 1000 + v.getUint8(6) * 10,
      lat,
      lon,
      speed: v.getUint16(15, true) / 100, // m/s
      heading: heading === 0xFFFF ? null : heading / 10,
      battery: bat === 255 ? null : bat / 100,
      hdop: hdop === 255 ? null : hdop / 10
    };
    if (u8.length >= 24) {
      out.rssi = v.getInt16(21, true);
      out.snr = v.getInt8(23) / 4;
    }
    return out;
  }

  /** Gegenstueck zur Firmware (fuer Tests und Simulation). */
  function encode(p) {
    const u8 = new Uint8Array(LEN);
    const v = new DataView(u8.buffer);
    v.setUint8(0, MAGIC);
    v.setUint8(1, p.id);
    v.setUint32(2, Math.floor(p.ts / 1000), true);
    v.setUint8(6, Math.round((p.ts % 1000) / 10) % 100);
    v.setInt32(7, Math.round(p.lat * 1e6), true);
    v.setInt32(11, Math.round(p.lon * 1e6), true);
    v.setUint16(15, Math.round((p.speed || 0) * 100), true);
    v.setUint16(17, p.heading == null ? 0xFFFF : Math.round(p.heading * 10), true);
    v.setUint8(19, p.battery == null ? 255 : Math.round(p.battery * 100));
    v.setUint8(20, p.hdop == null ? 255 : Math.min(254, Math.round(p.hdop * 10)));
    return u8;
  }

  return { MAGIC, LEN, decode, encode };
}));
