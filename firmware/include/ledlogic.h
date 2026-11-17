#pragma once
/*
 * Reine Entscheidungslogik fuer die Status-Ampel (ohne Arduino-Abhaengigkeiten, auf dem Rechner testbar:
 * siehe firmware/test/test_ledlogic.cpp).
 */
#include <stdint.h>

enum LedPattern : uint8_t {
  PAT_OK_HEARTBEAT,  // gruen: kurzes Blinken alle 2 s
  PAT_BUSY_BLINK,    // gelb: 1 Hz blinken (GPS-Suche / Upload / Master ohne Handy)
  PAT_FAULT_BLINK,   // rot: 1 Hz blinken (Fehler)
  PAT_BATT_LOW,      // rot: sehr kurzes Blitzen jede Sekunde (Akku niedrig)
  PAT_GPS_SILENT,    // rot und gelb abwechselnd: GPS-Modul liefert gar keine Daten (Verdrahtung/Strom/Modul)
  PAT_GPS_NOSATS     // gelb, zwei kurze Blinks, dann Pause: GPS-Daten kommen, aber 0 Satelliten (Himmelssicht/Antenne)
};

// GPS-Zustand fuer die Ampel (17.11.2026). 0 = unbekannt (z.B. Master, Logger): es gilt das alte Verhalten.
enum GpsInfo : uint8_t { GPS_INFO_UNKNOWN = 0, GPS_INFO_SILENT = 1, GPS_INFO_NOSATS = 2, GPS_INFO_SEARCH = 3 };

enum SteadyColor : uint8_t { STEADY_NONE, STEADY_RED, STEADY_YELLOW, STEADY_GREEN };

struct LedInputs {
  bool fsOk;          // Flash-Speicher in Ordnung
  bool radioFailed;   // LoRa-Init fehlgeschlagen (nur Tracker/Master)
  bool hasFix;        // Tracker: GPS-Fix; Master: Handy per Bluetooth verbunden
  uint32_t noFixMs;   // Tracker: so lange schon kein Fix (seit Start oder letztem Fix)
  float battery;      // 0..1, < 0 = unbekannt
  bool uploading;     // Hotspot-Upload laeuft (scannen/verbinden/hochladen)
  uint8_t gpsInfo;    // GpsInfo (Tracker); bei 0 = unbekannt bleibt alles beim Alten. Bewusst als LETZTES Feld: bestehende Aggregat-Initialisierungen bleiben gueltig.
};

#define LED_BATT_LOW_LEVEL 0.15f
#define LED_NOFIX_FAULT_MS 300000UL   // 5 min ohne Fix = Fehler (rot)
#define LED_SYNC_TOLERANCE 40         // Eintraege, die noch fehlen duerfen, damit "alles hochgeladen" gilt

// Ist der GPS-Zustand bekannt, ist "5 min ohne Fix" KEIN Fehler mehr: fehlende Himmelssicht ist kein Geraetefehler. Rot bedeutet dann nur noch
// Flash-/LoRa-Fehler; ob das GPS-Modul stumm ist oder nur nichts sieht, zeigen die GPS-Muster (rot/gelb abwechselnd bzw. gelb doppelt).
inline bool ledFault(const LedInputs &in) {
  bool noFixTimeout = in.gpsInfo == GPS_INFO_UNKNOWN && !in.hasFix && in.noFixMs > LED_NOFIX_FAULT_MS;
  return !in.fsOk || in.radioFailed || noFixTimeout;
}

inline bool ledBatteryLow(const LedInputs &in) {
  return in.battery >= 0 && in.battery < LED_BATT_LOW_LEVEL;
}

inline LedPattern decidePattern(const LedInputs &in) {
  if (ledFault(in)) return PAT_FAULT_BLINK;
  if (ledBatteryLow(in)) return PAT_BATT_LOW;
  if (!in.hasFix) {
    if (in.gpsInfo == GPS_INFO_SILENT) return PAT_GPS_SILENT;
    if (in.gpsInfo == GPS_INFO_NOSATS) return PAT_GPS_NOSATS;
    return PAT_BUSY_BLINK;
  }
  if (in.uploading) return PAT_BUSY_BLINK;
  return PAT_OK_HEARTBEAT;
}

/** "Alles hochgeladen": letzter Upload-Durchgang erfolgreich und hoechstens LED_SYNC_TOLERANCE Eintraege offen. */
inline bool ledSynced(bool lastUploadOk, uint32_t entries, uint32_t uploaded) {
  uint32_t pending = entries > uploaded ? entries - uploaded : 0;
  return lastUploadOk && pending <= LED_SYNC_TOLERANCE;
}

/** Farbe fuer die Dauer-Anzeige nach Tastendruck. */
inline SteadyColor decideSteady(const LedInputs &in, bool synced) {
  if (ledFault(in) || ledBatteryLow(in)) return STEADY_RED;
  return synced ? STEADY_GREEN : STEADY_YELLOW;
}

struct LedOut { bool r, y, g; };

/** Welche LEDs zum Zeitpunkt t (ms) leuchten. */
inline LedOut patternAt(LedPattern p, uint32_t t) {
  LedOut o = {false, false, false};
  switch (p) {
    case PAT_OK_HEARTBEAT: o.g = (t % 2000) < 120; break;
    case PAT_BUSY_BLINK:   o.y = (t % 1000) < 500; break;
    case PAT_FAULT_BLINK:  o.r = (t % 1000) < 500; break;
    case PAT_BATT_LOW:     o.r = (t % 1000) < 100; break;
    case PAT_GPS_SILENT:   o.r = (t % 1000) < 500; o.y = !o.r; break;                       // abwechselnd rot/gelb, 1 Hz
    case PAT_GPS_NOSATS: { uint32_t m = t % 1500; o.y = m < 150 || (m >= 300 && m < 450); break; }   // zwei kurze Blinks, dann Pause
  }
  return o;
}

inline LedOut steadyOut(SteadyColor c) {
  return LedOut{c == STEADY_RED, c == STEADY_YELLOW, c == STEADY_GREEN};
}
