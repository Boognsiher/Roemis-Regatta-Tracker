// Test der Ampel-Logik auf dem Rechner:
//   g++ -std=c++17 -I firmware/include firmware/test/test_ledlogic.cpp -o /tmp/test_ledlogic && /tmp/test_ledlogic
#include <cstdio>
#include "ledlogic.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (Zeile %d)\n", #cond, __LINE__); failures++; } } while (0)

static LedInputs ok() { return LedInputs{true, false, true, 0, 0.8f, false}; }

int main() {
  // Normalbetrieb: gruenes Herzschlag-Blinken
  CHECK(decidePattern(ok()) == PAT_OK_HEARTBEAT);

  // Kein Fix: gelb blinkt; nach 5 min Fehler (rot)
  LedInputs nofix = ok(); nofix.hasFix = false; nofix.noFixMs = 10000;
  CHECK(decidePattern(nofix) == PAT_BUSY_BLINK);
  nofix.noFixMs = LED_NOFIX_FAULT_MS + 1;
  CHECK(decidePattern(nofix) == PAT_FAULT_BLINK);

  // GPS-Zustand bekannt (Tracker, 17.11.2026): 5 min ohne Fix sind kein Fehler mehr, die GPS-Muster zeigen die Ursache
  LedInputs gs = nofix; gs.noFixMs = LED_NOFIX_FAULT_MS + 1;
  gs.gpsInfo = GPS_INFO_SEARCH;  CHECK(decidePattern(gs) == PAT_BUSY_BLINK);
  gs.gpsInfo = GPS_INFO_NOSATS;  CHECK(decidePattern(gs) == PAT_GPS_NOSATS);
  gs.gpsInfo = GPS_INFO_SILENT;  CHECK(decidePattern(gs) == PAT_GPS_SILENT);
  gs.fsOk = false;               CHECK(decidePattern(gs) == PAT_FAULT_BLINK);       // Geraetefehler hat Vorrang
  gs.fsOk = true; gs.battery = 0.1f; CHECK(decidePattern(gs) == PAT_BATT_LOW);      // Akku niedrig vor GPS-Muster
  LedInputs fixOk = ok(); fixOk.gpsInfo = GPS_INFO_SILENT;                           // mit Fix zaehlt der Zustand nicht
  CHECK(decidePattern(fixOk) == PAT_OK_HEARTBEAT);
  LedInputs unknown = nofix; unknown.noFixMs = LED_NOFIX_FAULT_MS + 1; unknown.gpsInfo = GPS_INFO_UNKNOWN;
  CHECK(decidePattern(unknown) == PAT_FAULT_BLINK);                                  // Logger/Master: altes Verhalten

  // Upload laeuft: gelb blinkt
  LedInputs up = ok(); up.uploading = true;
  CHECK(decidePattern(up) == PAT_BUSY_BLINK);

  // Fehler haben Vorrang vor allem anderen
  LedInputs bad = ok(); bad.fsOk = false; bad.uploading = true;
  CHECK(decidePattern(bad) == PAT_FAULT_BLINK);
  LedInputs radio = ok(); radio.radioFailed = true;
  CHECK(decidePattern(radio) == PAT_FAULT_BLINK);

  // Akku niedrig (unbekannt = ignorieren)
  LedInputs low = ok(); low.battery = 0.10f;
  CHECK(decidePattern(low) == PAT_BATT_LOW);
  LedInputs unk = ok(); unk.battery = -1;
  CHECK(decidePattern(unk) == PAT_OK_HEARTBEAT);

  // Synchronisation
  CHECK(ledSynced(true, 1000, 980));
  CHECK(!ledSynced(true, 1000, 900));
  CHECK(!ledSynced(false, 1000, 1000));
  CHECK(ledSynced(true, 0, 0));

  // Dauer-Anzeige nach Tastendruck
  CHECK(decideSteady(ok(), true) == STEADY_GREEN);
  CHECK(decideSteady(ok(), false) == STEADY_YELLOW);
  CHECK(decideSteady(bad, true) == STEADY_RED);
  CHECK(decideSteady(low, true) == STEADY_RED);

  // Zeitmuster
  CHECK(patternAt(PAT_OK_HEARTBEAT, 50).g);
  CHECK(!patternAt(PAT_OK_HEARTBEAT, 500).g);
  CHECK(patternAt(PAT_OK_HEARTBEAT, 2050).g);
  CHECK(patternAt(PAT_BUSY_BLINK, 100).y && !patternAt(PAT_BUSY_BLINK, 600).y);
  CHECK(patternAt(PAT_FAULT_BLINK, 100).r && !patternAt(PAT_FAULT_BLINK, 600).r);
  CHECK(patternAt(PAT_BATT_LOW, 50).r && !patternAt(PAT_BATT_LOW, 150).r);
  CHECK(patternAt(PAT_GPS_SILENT, 100).r && !patternAt(PAT_GPS_SILENT, 100).y);
  CHECK(patternAt(PAT_GPS_SILENT, 600).y && !patternAt(PAT_GPS_SILENT, 600).r);
  CHECK(patternAt(PAT_GPS_NOSATS, 50).y && !patternAt(PAT_GPS_NOSATS, 200).y);
  CHECK(patternAt(PAT_GPS_NOSATS, 350).y && !patternAt(PAT_GPS_NOSATS, 600).y && !patternAt(PAT_GPS_NOSATS, 1200).y);
  CHECK(patternAt(PAT_GPS_NOSATS, 1550).y);                                          // naechster Zyklus (1500 ms)
  CHECK(!patternAt(PAT_OK_HEARTBEAT, 50).r && !patternAt(PAT_OK_HEARTBEAT, 50).y);

  if (failures == 0) std::printf("alle Tests ok\n");
  return failures ? 1 : 0;
}
