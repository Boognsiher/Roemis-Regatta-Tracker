#pragma once
#include <Arduino.h>
#include <HardwareSerial.h>
#include "ubxtime.h"
/*
 * Zusammenspiel mit dem GPS-Modul: NMEA wie bisher an TinyGPSPlus, nebenbei die UBX-Meldung NAV-TIMEGPS auswerten (siehe ubxtime.h).
 * Statt `while (GPSSerial.available()) gps.encode(GPSSerial.read());` jetzt `gpsPump(GPSSerial, gps);`
 * gpsTimeTrusted() = false: Die Zeit des Moduls ist noch nicht auf UTC abgeglichen -> keine Positionen mit Zeitstempel senden/aufzeichnen.
 */
static UbxTime gpsTimeState;
static uint32_t gpsTimeCfgAt = 0;
static uint8_t gpsTimeCfgTries = 0;

template <class GPS>
static inline void gpsPump(HardwareSerial &ser, GPS &g) {
  uint32_t now = millis();
  // NAV-TIMEGPS einschalten: 2 s nach dem Start, danach alle 15 s, solange das Modul nicht geantwortet hat (hoechstens 8 Versuche; Nicht-u-blox-Module ignorieren es).
  if (!gpsTimeState.seen && gpsTimeCfgTries < 8 && now - gpsTimeCfgAt >= (gpsTimeCfgTries ? 15000UL : 2000UL)) {
    uint8_t msg[11];
    size_t n = ubxEnableMsg(0x01, 0x20, 1, msg);
    ser.write(msg, n);
    gpsTimeCfgAt = now;
    gpsTimeCfgTries++;
  }
  while (ser.available()) {
    uint8_t c = (uint8_t)ser.read();
    if (!gpsTimeState.feed(c)) g.encode((char)c);
  }
}

static inline bool gpsTimeTrusted() { return gpsTimeState.trusted(millis()); }

/** Kurztext fuer die Statusausgabe. */
static inline const char *gpsTimeText() {
  if (gpsTimeState.seen) return gpsTimeState.leapValid ? "verlaesslich (Schaltsekunden bekannt)" : "NICHT verlaesslich (Schaltsekunden fehlen noch, bis ca. 12 min nach Kaltstart)";
  return millis() >= UBX_TIME_GIVEUP_MS ? "nicht pruefbar (Modul spricht kein UBX)" : "wird geprueft ...";
}
