#pragma once
/*
 * Board-spezifische Initialisierung und Akkuanzeige. Jede Firmware ruft boardInit() am Anfang von setup() auf.
 *  - T-Beam V1.2 (-DBOARD_TBEAM_V12): GPS und LoRa haengen am Strom-Chip AXP2101 und bekommen erst nach
 *    Initialisierung Strom. Akkustand kommt vom Strom-Chip.
 *  - alle anderen: nichts zu tun, Akkustand optional per ADC (BAT_ADC_PIN in config.h).
 */
#include <Arduino.h>
#include "config.h"

#if defined(BOARD_TBEAM_V12)
#include <Wire.h>
#include <XPowersLib.h>

static XPowersAXP2101 pmu;
static bool pmuOk = false;

// needLora = false spart Strom (Logger ohne LoRa).
inline void boardInit(bool needLora) {
  Wire.begin(TBEAM_SDA, TBEAM_SCL);
  pmuOk = pmu.begin(Wire, AXP2101_SLAVE_ADDRESS, TBEAM_SDA, TBEAM_SCL);
  if (!pmuOk) {
    Serial.println("PMU (AXP2101) nicht gefunden - ist das ein T-Beam V1.0/V1.1 mit AXP192? Siehe firmware/README.md");
    return;
  }
  pmu.setPowerChannelVoltage(XPOWERS_ALDO3, 3300);   // GPS
  pmu.enablePowerOutput(XPOWERS_ALDO3);
  if (needLora) {
    pmu.setPowerChannelVoltage(XPOWERS_ALDO2, 3300); // LoRa (SX1262)
    pmu.enablePowerOutput(XPOWERS_ALDO2);
  }
  pmu.disableTSPinMeasure();      // kein Akku-Temperaturfuehler am T-Beam
  pmu.enableBattVoltageMeasure();
  delay(200);                     // GPS/LoRa hochfahren lassen
}

// 0..1 oder -1 wenn unbekannt/kein Akku
inline float boardBattery() {
  if (!pmuOk || !pmu.isBatteryConnect()) return -1;
  int p = pmu.getBatteryPercent();
  return p < 0 ? -1 : p / 100.0f;
}

#else

inline void boardInit(bool) {}

inline float boardBattery() {
#if BAT_ADC_PIN >= 0
  if (BAT_CTRL_PIN >= 0) { pinMode(BAT_CTRL_PIN, OUTPUT); digitalWrite(BAT_CTRL_PIN, LOW); }
  float v = analogReadMilliVolts(BAT_ADC_PIN) / 1000.0f * BAT_DIVIDER;
  float pct = (v - 3.3f) / (4.2f - 3.3f); // grobe LiPo-Naeherung
  return pct < 0 ? 0 : (pct > 1 ? 1 : pct);
#else
  return -1;
#endif
}

#endif
