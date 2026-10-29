#pragma once
/*
 * Optionales kleines OLED (SSD1306 128x64, I2C). Aktivieren mit Build-Flag -DUSE_OLED (siehe platformio.ini).
 * Ohne das Flag sind alle Funktionen leer und kosten nichts.
 *
 *  - T-Beam: der I2C-Anschluss fuer das OLED liegt auf GPIO21 (SDA) / GPIO22 (SCL) - gleicher Bus wie der Strom-Chip.
 *  - Display schaltet sich nach OLED_TIMEOUT_MS aus (Strom sparen) und geht bei Tastendruck (BUTTON_PIN) wieder an.
 */
#include <Arduino.h>
#include "config.h"

#if defined(USE_OLED)
#include <Wire.h>
#include <U8g2lib.h>

static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, OLED_RST, OLED_SCL, OLED_SDA);
static uint32_t oledWakeAt = 0;
static bool oledOn = true;

static void displayInit() {
#if defined(OLED_VEXT_PIN) && OLED_VEXT_PIN >= 0
  pinMode(OLED_VEXT_PIN, OUTPUT);
  digitalWrite(OLED_VEXT_PIN, LOW);   // Heltec: Vext LOW = Display-Strom an
  delay(50);
#endif
#if BUTTON_PIN >= 0
  pinMode(BUTTON_PIN, INPUT_PULLUP);
#endif
  oled.begin();
  oled.setFont(u8g2_font_6x10_tf);
  oledWakeAt = millis();
}

/** Bis zu 6 Textzeilen anzeigen. Aufruf aus loop() ca. 1x pro Sekunde. */
static void displayShow(const char *const *lines, int n) {
#if BUTTON_PIN >= 0
  if (digitalRead(BUTTON_PIN) == LOW) oledWakeAt = millis();
#endif
  bool want = OLED_TIMEOUT_MS == 0 || millis() - oledWakeAt < OLED_TIMEOUT_MS;
  if (want != oledOn) { oled.setPowerSave(want ? 0 : 1); oledOn = want; }
  if (!oledOn) return;
  oled.clearBuffer();
  for (int i = 0; i < n && i < 6; i++) oled.drawStr(0, 10 * (i + 1), lines[i]);
  oled.sendBuffer();
}

#else
static inline void displayInit() {}
static inline void displayShow(const char *const *, int) {}
#endif
