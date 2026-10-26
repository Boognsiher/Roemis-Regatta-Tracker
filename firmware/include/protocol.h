#pragma once
#include <stdint.h>
/*
 * Funkpaket Tracker -> Master. Gegenstueck: public/js/lora-packet.js (muss uebereinstimmen!).
 * Little-Endian (ESP32), 21 Byte.
 */
#define PKT_MAGIC 0xA7

struct __attribute__((packed)) TrackerPacket {
  uint8_t  magic;       // PKT_MAGIC
  uint8_t  id;          // Tracker-Nr 1..250
  uint32_t epochSec;    // GPS-Zeit (UTC) in Sekunden seit 1970
  uint8_t  centisec;    // Hundertstelsekunden 0..99
  int32_t  lat;         // 1e-6 Grad
  int32_t  lon;         // 1e-6 Grad
  uint16_t speedCms;    // cm/s
  uint16_t headingDeg10;// 0.1 Grad, 0xFFFF = unbekannt
  uint8_t  battPct;     // 0..100, 255 = unbekannt
  uint8_t  hdop10;      // HDOP*10, 255 = unbekannt
};
static_assert(sizeof(TrackerPacket) == 21, "TrackerPacket muss 21 Byte haben");

// Master -> Handy (BLE-Notification): Paket + RSSI/SNR
struct __attribute__((packed)) MasterNotify {
  TrackerPacket pkt;
  int16_t rssi;         // dBm
  int8_t  snr4;         // SNR * 4 dB
};
static_assert(sizeof(MasterNotify) == 24, "MasterNotify muss 24 Byte haben");
