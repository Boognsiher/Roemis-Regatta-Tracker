#pragma once
/*
 * Board-spezifische Initialisierung und Akkuanzeige. Jede Firmware ruft boardInit() am Anfang von setup() auf.
 *  - T-Beam V1.2 (-DBOARD_TBEAM_V12): GPS und LoRa haengen am Strom-Chip AXP2101 und bekommen erst nach
 *    Initialisierung Strom. Akkustand kommt vom Strom-Chip.
 *  - alle anderen: nichts zu tun, Akkustand optional per ADC (BAT_ADC_PIN in config.h).
 */
#include <Arduino.h>
#include "config.h"
#include "battery.h"

#if defined(BOARD_TBEAM_V12)
#include <Wire.h>
#include <XPowersLib.h>

static XPowersAXP2101 pmu;
static bool pmuOk = false;

// Ladestrom-Stufe des Strom-Chips (Werte siehe BATT_CHARGE_STEPS_MA in battery.h)
static void pmuSetChargeCurrent(uint16_t ma) {
  switch (nearestChargeMa(ma)) {
    case 100:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_100MA); break;
    case 125:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_125MA); break;
    case 150:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_150MA); break;
    case 175:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_175MA); break;
    case 200:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_200MA); break;
    case 300:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_300MA); break;
    case 400:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_400MA); break;
    case 500:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_500MA); break;
    case 600:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_600MA); break;
    case 700:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_700MA); break;
    case 800:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_800MA); break;
    case 900:  pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_900MA); break;
    default:   pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_1000MA); break;
  }
}

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
  pmu.disableTSPinMeasure();      // kein Akku-Temperaturfuehler am T-Beam (also nicht bei Frost laden!)
  pmu.enableBattVoltageMeasure();

  // Akku: Ladeschlussspannung 4.2 V, Ladestrom und Abschaltspannung aus config.h/battery.h
  pmu.setChargeTargetVoltage(XPOWERS_AXP2101_CHG_VOL_4V2);
  pmuSetChargeCurrent(BATT_CHARGE_MA);
  pmu.setSysPowerDownVoltage(clampCutoffMv(BATT_CUTOFF_MV));
  pmu.enableCellbatteryCharge();
  Serial.printf("Akku: Ladestrom %u mA, Abschaltung bei %u mV\n", nearestChargeMa(BATT_CHARGE_MA), clampCutoffMv(BATT_CUTOFF_MV));
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
