// g++ -std=c++17 -I firmware/include firmware/test/test_battery.cpp -o /tmp/test_battery && /tmp/test_battery
#include <cstdio>
#include "battery.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (Zeile %d)\n", #cond, __LINE__); failures++; } } while (0)

int main() {
  CHECK(nearestChargeMa(500) == 500);
  CHECK(nearestChargeMa(550) == 500);   // nie mehr als gewuenscht
  CHECK(nearestChargeMa(1000) == 1000);
  CHECK(nearestChargeMa(1500) == 1000); // groesste Stufe
  CHECK(nearestChargeMa(250) == 200);
  CHECK(nearestChargeMa(50) == 100);    // Minimum
  CHECK(nearestChargeMa(0) == 100);
  CHECK(clampCutoffMv(3000) == 3000);
  CHECK(clampCutoffMv(3050) == 3000);
  CHECK(clampCutoffMv(2000) == 2600);
  CHECK(clampCutoffMv(4000) == 3300);
  CHECK(nearestChargeMa(BATT_CHARGE_MA) <= BATT_CHARGE_MA);
  CHECK(clampCutoffMv(BATT_CUTOFF_MV) >= 2600 && clampCutoffMv(BATT_CUTOFF_MV) <= 3300);
  if (failures == 0) std::printf("alle Tests ok\n");
  return failures ? 1 : 0;
}
