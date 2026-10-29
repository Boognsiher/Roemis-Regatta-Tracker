#pragma once
/*
 * Akku-Einstellungen (reine Funktionen, auf dem Rechner testbar: firmware/test/test_battery.cpp).
 * Der Strom-Chip (AXP2101 am T-Beam V1.2) kennt nur bestimmte Ladestrom-Stufen und schaltet das Board ab,
 * wenn die Akkuspannung unter die eingestellte Schwelle faellt (Schutz vor Tiefentladung einer ungeschuetzten Zelle).
 */
#include <stdint.h>

// Gewuenschter Ladestrom und Abschaltspannung - in config.h oder per Build-Flag aenderbar.
#ifndef BATT_CHARGE_MA
#define BATT_CHARGE_MA 500        // hoechstens 0.5C der Zelle: 3000-mAh-Zelle -> bis ca. 1500, konservativ 500-1000
#endif
#ifndef BATT_CUTOFF_MV
#define BATT_CUTOFF_MV 3000       // Abschaltung bei 3.0 V (Strom-Chip erlaubt 2600-3300 mV in 100-mV-Schritten)
#endif

static const uint16_t BATT_CHARGE_STEPS_MA[] = {100, 125, 150, 175, 200, 300, 400, 500, 600, 700, 800, 900, 1000};
#define BATT_CHARGE_STEP_COUNT (sizeof(BATT_CHARGE_STEPS_MA) / sizeof(BATT_CHARGE_STEPS_MA[0]))

/** Groesste unterstuetzte Stufe, die den Wunsch nicht ueberschreitet (nie mehr Strom als gewuenscht). Unter 100 -> 100. */
inline uint16_t nearestChargeMa(uint16_t wantedMa) {
  uint16_t best = BATT_CHARGE_STEPS_MA[0];
  for (unsigned i = 0; i < BATT_CHARGE_STEP_COUNT; i++) {
    if (BATT_CHARGE_STEPS_MA[i] <= wantedMa) best = BATT_CHARGE_STEPS_MA[i];
  }
  return best;
}

/** Abschaltspannung auf den erlaubten Bereich 2600-3300 mV begrenzen und auf 100 mV abrunden. */
inline uint16_t clampCutoffMv(uint16_t mv) {
  if (mv < 2600) mv = 2600;
  if (mv > 3300) mv = 3300;
  return (uint16_t)(mv - mv % 100);
}
