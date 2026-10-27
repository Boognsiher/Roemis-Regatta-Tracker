#pragma once
/*
 * Ampel + Taste fuer Logger und LoRa-Tracker (braucht logupload.h und board.h).
 *  Normal: kurzes Blinken: gruen = alles gut, gelb = GPS-Suche/Upload, rot = Fehler / Akku niedrig.
 *  Kurzer Tastendruck: 10 s Dauer-Anzeige (gruen = alles hochgeladen, gelb = Daten warten, rot = Fehler)
 *                      und Upload sofort versuchen.
 *  Taste 5 s halten:   Log loeschen - nur wenn alles hochgeladen ist (sonst rot).
 */
#include "statusled.h"
#include "board.h"
#include "logupload.h"

#define TL_SHORT_PRESS_MIN_MS 40
#define TL_LONG_PRESS_MS 5000
#define TL_STEADY_MS 10000

static uint32_t tlLastFixMs = 0;     // millis() des letzten Fix (oder Start)
static uint32_t tlBattCheckMs = 0;
static float tlBatt = -1;
static bool tlPressed = false, tlLongDone = false;
static uint32_t tlPressStart = 0;

static LedInputs tlInputs(bool hasFix, bool radioFailed) {
  uint32_t now = millis();
  if (hasFix) tlLastFixMs = now;
  if (now - tlBattCheckMs > 2000) { tlBattCheckMs = now; tlBatt = boardBattery(); }
  LedInputs in;
  in.fsOk = fsOk;
  in.radioFailed = radioFailed;
  in.hasFix = hasFix;
  in.noFixMs = now - tlLastFixMs;
  in.battery = tlBatt;
  in.uploading = upState == UP_SCAN || upState == UP_CONNECT || upState == UP_UPLOAD;
  return in;
}

static void tlButton(const LedInputs &in) {
#if BUTTON_PIN >= 0
  uint32_t now = millis();
  bool down = digitalRead(BUTTON_PIN) == LOW;
  bool synced = ledSynced(upState == UP_DONE, logupEntries(), logupUploaded());
  if (down && !tlPressed) { tlPressed = true; tlLongDone = false; tlPressStart = now; }
  if (down && tlPressed && !tlLongDone && now - tlPressStart >= TL_LONG_PRESS_MS) {
    tlLongDone = true;
    if (synced) { eraseLog(); ledShowSteady(STEADY_GREEN, 3000); }
    else ledShowSteady(STEADY_RED, 3000);             // abgelehnt: noch nicht alles hochgeladen
  }
  if (!down && tlPressed) {
    tlPressed = false;
    if (!tlLongDone && now - tlPressStart >= TL_SHORT_PRESS_MIN_MS) {
      ledShowSteady(decideSteady(in, synced), TL_STEADY_MS);
      uploadNow = true;
    }
  }
#else
  (void)in;
#endif
}

/** Aus loop() bei jedem Durchlauf aufrufen. hasFix = gueltiger GPS-Fix, radioFailed = LoRa-Init fehlgeschlagen. */
static void trackerLedLoop(bool hasFix, bool radioFailed) {
  LedInputs in = tlInputs(hasFix, radioFailed);
  tlButton(in);
  ledRender(decidePattern(in));
}

static void trackerLedInit() {
#if BUTTON_PIN >= 0
  pinMode(BUTTON_PIN, INPUT_PULLUP);
#endif
  ledsInit();
  tlLastFixMs = millis();
}
