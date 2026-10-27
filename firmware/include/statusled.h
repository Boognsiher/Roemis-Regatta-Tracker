#pragma once
/*
 * Status-Ampel (Modul mit 4 Pins: GND, Rot, Gelb, Gruen; Pins in config.h: LED_RED_PIN/LED_YELLOW_PIN/LED_GREEN_PIN,
 * -1 = nicht vorhanden). Die Entscheidung, was angezeigt wird, steht in ledlogic.h (getestet).
 *  - Normalbetrieb: Herzschlag-Muster (siehe ledlogic.h)
 *  - ledShowSteady(): Dauer-Anzeige fuer eine Zeit (nach Tastendruck)
 * LEDs sind high-aktiv; bei Modulen mit invertierter Logik -DLED_ACTIVE_LOW setzen.
 */
#include <Arduino.h>
#include "config.h"
#include "ledlogic.h"

#ifndef LED_ACTIVE_LOW
#define LED_ACTIVE_LOW 0
#endif

static uint32_t ledSteadyUntil = 0;
static SteadyColor ledSteadyColor = STEADY_NONE;

static inline void ledPin(int pin, bool on) {
  if (pin >= 0) digitalWrite(pin, (on != (bool)LED_ACTIVE_LOW) ? HIGH : LOW);
}

static void ledWrite(LedOut o) {
  ledPin(LED_RED_PIN, o.r);
  ledPin(LED_YELLOW_PIN, o.y);
  ledPin(LED_GREEN_PIN, o.g);
}

/** Pins einrichten und eine Lampenprobe zeigen (Rot, Gelb, Gruen nacheinander) - so siehst du, ob alles richtig angeschlossen ist. */
static void ledsInit() {
  const int pins[3] = {LED_RED_PIN, LED_YELLOW_PIN, LED_GREEN_PIN};
  for (int p : pins) if (p >= 0) pinMode(p, OUTPUT);
  ledWrite({false, false, false});
  const LedOut seq[3] = {{true, false, false}, {false, true, false}, {false, false, true}};
  for (const LedOut &o : seq) { ledWrite(o); delay(300); }
  ledWrite({false, false, false});
}

static void ledShowSteady(SteadyColor c, uint32_t ms) {
  ledSteadyColor = c;
  ledSteadyUntil = millis() + ms;
}

/** Aus loop() aufrufen: zeigt die Dauer-Anzeige, solange sie aktiv ist, sonst das Herzschlag-Muster. */
static void ledRender(LedPattern p) {
  uint32_t now = millis();
  if (ledSteadyUntil && (int32_t)(ledSteadyUntil - now) > 0) ledWrite(steadyOut(ledSteadyColor));
  else ledWrite(patternAt(p, now));
}
