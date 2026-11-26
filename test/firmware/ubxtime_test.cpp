// Host-Test fuer firmware/include/ubxtime.h:  g++ -std=c++17 -Wall -Wextra -I firmware/include test/firmware/ubxtime_test.cpp -o /tmp/ubxtest && /tmp/ubxtest
#include <cstdio>
#include <cstring>
#include <vector>
#include "ubxtime.h"

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FEHLER Zeile %d: %s\n", __LINE__, #c); fails++; } } while (0)

static std::vector<uint8_t> frame(uint8_t cls, uint8_t id, const std::vector<uint8_t> &pl, bool badSum = false) {
  std::vector<uint8_t> f = {0xB5, 0x62, cls, id, (uint8_t)(pl.size() & 0xFF), (uint8_t)(pl.size() >> 8)};
  f.insert(f.end(), pl.begin(), pl.end());
  uint8_t a = 0, b = 0;
  for (size_t i = 2; i < f.size(); i++) { a = (uint8_t)(a + f[i]); b = (uint8_t)(b + a); }
  f.push_back(badSum ? (uint8_t)(a + 1) : a); f.push_back(b);
  return f;
}
static std::vector<uint8_t> timegps(uint8_t leapS, uint8_t valid, bool bad = false) {
  std::vector<uint8_t> p(16, 0);
  p[10] = leapS; p[11] = valid;
  return frame(0x01, 0x20, p, bad);
}
static int feedAll(UbxTime &u, const std::vector<uint8_t> &v, int *consumed = nullptr) {
  int c = 0; for (uint8_t b : v) if (u.feed(b)) c++;
  if (consumed) *consumed = c;
  return c;
}

int main() {
  // 1) gueltiger Rahmen mit leapSValid
  { UbxTime u; auto f = timegps(18, 0x07); int c; feedAll(u, f, &c);
    CHECK(c == (int)f.size()); CHECK(u.seen); CHECK(u.leapValid); CHECK(u.leapS == 18); CHECK(u.trusted(1000)); }
  // 2) Schaltsekunden noch nicht gueltig (Kaltstart): nicht vertrauenswuerdig, auch nach 3 Minuten
  { UbxTime u; feedAll(u, timegps(15, 0x03)); CHECK(u.seen); CHECK(!u.leapValid); CHECK(!u.trusted(180000)); }
  // 3) danach gueltig
  { UbxTime u; feedAll(u, timegps(15, 0x03)); feedAll(u, timegps(18, 0x07)); CHECK(u.trusted(5000)); }
  // 4) falsche Pruefsumme wird verworfen
  { UbxTime u; feedAll(u, timegps(18, 0x07, true)); CHECK(!u.seen); }
  // 5) NMEA-Text bleibt unberuehrt, UBX zwischen NMEA wird erkannt
  { UbxTime u; const char *nmea = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A\r\n";
    int n = 0; for (const char *p = nmea; *p; p++) if (u.feed((uint8_t)*p)) n++;
    CHECK(n == 0); CHECK(!u.seen);
    auto f = timegps(18, 0x07); feedAll(u, f);
    for (const char *p = nmea; *p; p++) if (u.feed((uint8_t)*p)) n++;
    CHECK(n == 0); CHECK(u.seen && u.leapValid); }
  // 6) Rahmen in einzelnen Stuecken, mit Muell davor
  { UbxTime u; std::vector<uint8_t> junk = {0xB5, 0x00, 0x62, 0xB5}; feedAll(u, junk); auto f = timegps(18, 0x07);
    feedAll(u, f); CHECK(u.seen && u.leapValid); }
  // 7) zu langer Rahmen (Stoerung) wird abgebrochen, NMEA danach wieder normal
  { UbxTime u; UbxTime v; std::vector<uint8_t> bad = {0xB5, 0x62, 0x01, 0x20, 0xFF, 0xFF}; feedAll(u, bad);
    CHECK(!u.feed('$')); (void)v; }
  // 8) anderes Modul (nie UBX): erst nach der Wartezeit vertrauenswuerdig
  { UbxTime u; CHECK(!u.trusted(1000)); CHECK(!u.trusted(UBX_TIME_GIVEUP_MS - 1)); CHECK(u.trusted(UBX_TIME_GIVEUP_MS)); }
  // 9) CFG-MSG-Rahmen: Pruefsumme stimmt (Wert unabhaengig per Fletcher-8 nachgerechnet: B5 62 06 01 03 00 01 20 01 2C 83)
  { uint8_t out[11]; size_t n = ubxEnableMsg(0x01, 0x20, 1, out);
    const uint8_t ref[] = {0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0x01, 0x20, 0x01, 0x2C, 0x83};
    CHECK(n == 11); CHECK(memcmp(out, ref, 11) == 0); }
  printf(fails ? "%d Fehler\n" : "alle Firmware-Parser-Tests ok\n", fails);
  return fails ? 1 : 0;
}
