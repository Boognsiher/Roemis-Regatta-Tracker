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
  PAT_BATT_LOW       // rot: sehr kurzes Blitzen jede Sekunde (Akku niedrig)
};

enum SteadyColor : uint8_t { STEADY_NONE, STEADY_RED, STEADY_YELLOW, STEADY_GREEN };

struct LedInputs {
  bool fsOk;          // Flash-Speicher in Ordnung
  bool radioFailed;   // LoRa-Init fehlgeschlagen (nur Tracker/Master)
  bool hasFix;        // Tracker: GPS-Fix; Master: Handy per Bluetooth verbunden
  uint32_t noFixMs;   // Tracker: so lange schon kein Fix (seit Start oder letztem Fix)
  float battery;      // 0..1, < 0 = unbekannt
  bool uploading;     // Hotspot-Upload laeuft (scannen/verbinden/hochladen)
};

#define LED_BATT_LOW_LEVEL 0.15f
#define LED_NOFIX_FAULT_MS 300000UL   // 5 min ohne Fix = Fehler (rot)
#define LED_SYNC_TOLERANCE 40         // Eintraege, die noch fehlen duerfen, damit "alles hochgeladen" gilt

inline bool ledFault(const LedInputs &in) {
  return !in.fsOk || in.radioFailed || (!in.hasFix && in.noFixMs > LED_NOFIX_FAULT_MS);
}

inline bool ledBatteryLow(const LedInputs &in) {
  return in.battery >= 0 && in.battery < LED_BATT_LOW_LEVEL;
}

inline LedPattern decidePattern(const LedInputs &in) {
  if (ledFault(in)) return PAT_FAULT_BLINK;
  if (ledBatteryLow(in)) return PAT_BATT_LOW;
  if (!in.hasFix || in.uploading) return PAT_BUSY_BLINK;
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
  }
  return o;
}

inline LedOut steadyOut(SteadyColor c) {
  return LedOut{c == STEADY_RED, c == STEADY_YELLOW, c == STEADY_GREEN};
}
