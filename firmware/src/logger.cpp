/*
 * Regatta-Logger (guenstigste Variante: nur ESP32 + GPS + Akku, kein LoRa)
 *  - schreibt jede Sekunde Position + GPS-Zeit ins Flash (/log.bin, 21 Byte pro Eintrag)
 *  - laedt das Log ueber den Hotspot deines Handys auf den Server, sobald es in Reichweite ist (logupload.h)
 *  - Serielle Befehle (115200): 'd' Log als CSV, 'e' Log loeschen, 's' Status, 'u' Upload sofort versuchen
 */
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "include/secrets.h fehlt: include/secrets.h.example kopieren und ausfuellen"
#endif

#include <Arduino.h>
#include <TinyGPSPlus.h>
#include "config.h"
#include "protocol.h"
#include "board.h"
#include "logupload.h"
#include "display.h"
#include "trackerled.h"

TinyGPSPlus gps;
HardwareSerial GPSSerial(1);
static uint64_t lastLoggedTs = 0;
static uint32_t lastDisplay = 0;

// Tage seit 1970 (Howard Hinnant, gregorianisch)
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

static void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (logupHandleChar(c)) continue;
    if (c == 's') {
      Serial.printf("ID %d | Sat %d | Eintraege im Log %u | hochgeladen %u | Fix %s | %s\n", TRACKER_ID,
                    gps.satellites.isValid() ? (int)gps.satellites.value() : -1, (unsigned)logupEntries(),
                    (unsigned)logupUploaded(), gps.location.isValid() ? "ja" : "nein", upStateText());
    }
  }
}

static void updateDisplay() {
  char l[6][24];
  float b = boardBattery();
  snprintf(l[0], sizeof(l[0]), "LOGGER #%d  %02d:%02d:%02d", TRACKER_ID, gps.time.hour(), gps.time.minute(), gps.time.second());
  snprintf(l[1], sizeof(l[1]), "GPS %s  Sat %d", gps.location.isValid() ? "OK" : "suche", gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
  snprintf(l[2], sizeof(l[2]), "%.1f kn  Akku %s%d%%", gps.speed.knots(), b < 0 ? "?" : "", b < 0 ? 0 : (int)lround(b * 100));
  snprintf(l[3], sizeof(l[3]), "Log %u", (unsigned)logupEntries());
  snprintf(l[4], sizeof(l[4]), "Up %u/%u", (unsigned)logupUploaded(), (unsigned)logupEntries());
  snprintf(l[5], sizeof(l[5]), "%s", upStateText());
  const char *lines[6] = {l[0], l[1], l[2], l[3], l[4], l[5]};
  displayShow(lines, 6);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("Regatta-Logger, ID %d\n", TRACKER_ID);
  boardInit(false);
  displayInit();
  trackerLedInit();
  logupInit();

  GPSSerial.setRxBufferSize(2048);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
}

void loop() {
  while (GPSSerial.available()) gps.encode(GPSSerial.read());

  // RMC-Satz abgeschlossen (enthaelt Datum + Zeit + Position): Eintrag aufzeichnen.
  if (gps.date.isUpdated() && gps.time.isUpdated()) {
    if (gps.date.isValid() && gps.time.isValid() && gps.location.isValid() && gps.date.year() >= 2024) {
      uint64_t epochMs =
          (uint64_t)(daysFromCivil(gps.date.year(), gps.date.month(), gps.date.day()) * 86400LL +
                     gps.time.hour() * 3600 + gps.time.minute() * 60 + gps.time.second()) * 1000ULL +
          gps.time.centisecond() * 10;
      if (epochMs != lastLoggedTs) {
        lastLoggedTs = epochMs;
        TrackerPacket p;
        p.magic = PKT_MAGIC;
        p.id = TRACKER_ID;
        p.epochSec = (uint32_t)(epochMs / 1000);
        p.centisec = (uint8_t)((epochMs % 1000) / 10);
        p.lat = (int32_t)lround(gps.location.lat() * 1e6);
        p.lon = (int32_t)lround(gps.location.lng() * 1e6);
        p.speedCms = gps.speed.isValid() ? (uint16_t)constrain((long)lround(gps.speed.mps() * 100), 0L, 65534L) : 0;
        p.headingDeg10 = gps.course.isValid() ? (uint16_t)lround(gps.course.deg() * 10) : 0xFFFF;
        float b = boardBattery();
        p.battPct = b < 0 ? 255 : (uint8_t)lround(b * 100);
        p.hdop10 = gps.hdop.isValid() ? (uint8_t)constrain((long)lround(gps.hdop.hdop() * 10), 0L, 254L) : 255;
        logupAdd(p);
      }
    }
  }

  trackerLedLoop(gps.location.isValid() && gps.location.age() < 3000, false);
  if (millis() - lastDisplay > 1000) { lastDisplay = millis(); updateDisplay(); }
  handleSerial();
}
