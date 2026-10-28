/*
 * Regatta-Tracker (LoRa-Funk-Tracker fuer jedes Boot)
 *  - liest GPS (NMEA, optional PPS) und sendet die Position im eigenen Zeitfenster per LoRa (Live-Karte)
 *  - schreibt jede Position (1x/s) zusaetzlich ins Flash und laedt das Log ueber den Hotspot deines Handys
 *    auf den Server hoch, sobald das Boot in Reichweite ist (logupload.h) - das ist die lueckenlose
 *    Grundlage fuer die offizielle Zeitmessung
 *  - Serielle Befehle (115200): 'd' Log als CSV, 'e' Log loeschen, 's' Status, 'u' Upload sofort versuchen
 */
// secrets.h: noetig fuer den Hotspot-Upload (HOTSPOT_UPLOAD=1) und kann TRACKER_ID setzen. Ohne Upload darf die Datei
// fehlen - dann TRACKER_ID per Build-Flag (-DTRACKER_ID=7) oder in config.h setzen.
#ifndef HOTSPOT_UPLOAD
#define HOTSPOT_UPLOAD 1
#endif
#if __has_include("secrets.h")
#include "secrets.h"
#elif HOTSPOT_UPLOAD
#error "include/secrets.h fehlt: include/secrets.h.example kopieren und ausfuellen (oder -DHOTSPOT_UPLOAD=0)"
#endif

#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <TinyGPSPlus.h>
#include "config.h"
#include "protocol.h"
#include "board.h"
#include "logupload.h"
#include "display.h"
#include "trackerled.h"

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
TinyGPSPlus gps;
HardwareSerial GPSSerial(1);

// ---- Zeitbasis: GPS-Zeit mit Millisekunden-Aufloesung (fuer die Sendefenster) ----
// Mit PPS ist der Anker exakt (Sekundenimpuls); ohne PPS wird die Ankunftszeit des NMEA-Satzes minus
// NMEA_LATENCY_US genutzt (Genauigkeit nur ca. +-200 ms - fuer die Zeitfenster ok, die Positionszeit
// kommt immer aus dem GPS-Satz selbst).
#define NMEA_LATENCY_US 150000
volatile uint32_t ppsMicros = 0;
void IRAM_ATTR onPps() { ppsMicros = micros(); }

bool anchorValid = false;
uint64_t anchorEpochMs = 0;
uint32_t anchorMicros = 0;
uint32_t anchorSetAtMs = 0;

uint64_t gpsNowMs() {
  if (!anchorValid || millis() - anchorSetAtMs > 5000) return 0;
  return anchorEpochMs + (uint32_t)(micros() - anchorMicros) / 1000;
}

// Tage seit 1970 (Howard Hinnant, gregorianisch)
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

// ---- letzte gueltige Position ----
struct Fix {
  bool valid = false;
  uint64_t tsMs = 0;
  double lat = 0, lon = 0;
  float speedMs = 0, course = -1, hdop = -1;
} lastFix;

void fillPacket(TrackerPacket &p, const Fix &f) {
  p.magic = PKT_MAGIC;
  p.id = TRACKER_ID;
  p.epochSec = (uint32_t)(f.tsMs / 1000);
  p.centisec = (uint8_t)((f.tsMs % 1000) / 10);
  p.lat = (int32_t)lround(f.lat * 1e6);
  p.lon = (int32_t)lround(f.lon * 1e6);
  p.speedCms = (uint16_t)constrain((long)lround(f.speedMs * 100), 0L, 65534L);
  p.headingDeg10 = f.course < 0 ? 0xFFFF : (uint16_t)lround(f.course * 10);
  float b = boardBattery();
  p.battPct = b < 0 ? 255 : (uint8_t)lround(b * 100);
  p.hdop10 = f.hdop < 0 ? 255 : (uint8_t)constrain((long)lround(f.hdop * 10), 0L, 254L);
}

uint32_t txCount = 0;
bool loraOk = false;
uint64_t lastTxCycle = UINT64_MAX;
uint64_t lastLoggedTs = 0;
uint32_t lastDisplay = 0;

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (logupHandleChar(c)) continue;
    if (c == 's') {
      Serial.printf("ID %d | Sat %d | Fix %s | gesendet %u | Log %u | hochgeladen %u | %s\n", TRACKER_ID,
                    gps.satellites.isValid() ? (int)gps.satellites.value() : -1, lastFix.valid ? "ja" : "nein",
                    txCount, (unsigned)logupEntries(), (unsigned)logupUploaded(), HOTSPOT_UPLOAD ? upStateText() : "Upload aus");
    }
  }
}

void updateDisplay() {
  char l[6][24];
  float b = boardBattery();
  snprintf(l[0], sizeof(l[0]), "TRACKER #%d %02d:%02d:%02d", TRACKER_ID, gps.time.hour(), gps.time.minute(), gps.time.second());
  snprintf(l[1], sizeof(l[1]), "GPS %s  Sat %d", lastFix.valid ? "OK" : "suche", gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
  snprintf(l[2], sizeof(l[2]), "%.1f kn  Akku %s%d%%", gps.speed.knots(), b < 0 ? "?" : "", b < 0 ? 0 : (int)lround(b * 100));
  snprintf(l[3], sizeof(l[3]), "LoRa TX %u", (unsigned)txCount);
#if HOTSPOT_UPLOAD
  snprintf(l[4], sizeof(l[4]), "Log %u Up %u", (unsigned)logupEntries(), (unsigned)logupUploaded());
  snprintf(l[5], sizeof(l[5]), "%s", upStateText());
#else
  snprintf(l[4], sizeof(l[4]), "Log %u", (unsigned)logupEntries());
  l[5][0] = 0;
#endif
  const char *lines[6] = {l[0], l[1], l[2], l[3], l[4], l[5]};
  displayShow(lines, 6);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("Regatta-Tracker, ID %d\n", TRACKER_ID);
  boardInit(true);
  displayInit();
  trackerLedInit();
  logupInit();

  GPSSerial.setRxBufferSize(2048);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  if (GPS_PPS_PIN >= 0) attachInterrupt(digitalPinToInterrupt(GPS_PPS_PIN), onPps, RISING);

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR, LORA_SYNC_WORD, LORA_TX_POWER_DBM,
                       LORA_PREAMBLE, LORA_TCXO_V);
  if (st != RADIOLIB_ERR_NONE) {
    // Aufzeichnung ins Flash laeuft trotzdem weiter (Logger-Betrieb), nur ohne Live-Funk.
    Serial.printf("LoRa-Init fehlgeschlagen: %d (Pins/TCXO in config.h pruefen) - nur Logger-Betrieb\n", st);
  } else {
    radio.setCRC(true);
    if (LORA_DIO2_RF_SWITCH) radio.setDio2AsRfSwitch(true);
    loraOk = true;
    Serial.println("LoRa bereit");
  }
}

void loop() {
  while (GPSSerial.available()) gps.encode(GPSSerial.read());

  // Ein RMC-Satz (enthaelt Datum) ist abgeschlossen: Zeitanker + Position uebernehmen.
  if (gps.date.isUpdated() && gps.time.isUpdated()) {
    if (gps.date.isValid() && gps.time.isValid() && gps.location.isValid() && gps.date.year() >= 2024) {
      uint64_t epochMs =
          (uint64_t)(daysFromCivil(gps.date.year(), gps.date.month(), gps.date.day()) * 86400LL +
                     gps.time.hour() * 3600 + gps.time.minute() * 60 + gps.time.second()) * 1000ULL +
          gps.time.centisecond() * 10;
      uint32_t pps = ppsMicros;
      if (GPS_PPS_PIN >= 0 && pps != 0 && (uint32_t)(micros() - pps) < 1000000UL) {
        anchorMicros = pps;       // NMEA-Satz gehoert zum davorliegenden Sekundenimpuls
      } else {
        anchorMicros = micros() - NMEA_LATENCY_US;
      }
      anchorEpochMs = epochMs;
      anchorSetAtMs = millis();
      anchorValid = true;

      lastFix.valid = true;
      lastFix.tsMs = epochMs;
      lastFix.lat = gps.location.lat();
      lastFix.lon = gps.location.lng();
      lastFix.speedMs = gps.speed.isValid() ? gps.speed.mps() : 0;
      lastFix.course = gps.course.isValid() ? gps.course.deg() : -1;
      lastFix.hdop = gps.hdop.isValid() ? gps.hdop.hdop() : -1;

      if (epochMs != lastLoggedTs) {
        lastLoggedTs = epochMs;
        TrackerPacket p;
        fillPacket(p, lastFix);
        logupAdd(p);
      }
    }
  }

  // Sendefenster: (TRACKER_ID-1)*SLOT_MS innerhalb des Zyklus, Start in der ersten Haelfte des Fensters.
  uint64_t now = gpsNowMs();
  if (loraOk && now && lastFix.valid) {
    uint64_t cycle = now / CYCLE_MS;
    uint32_t inCycle = now % CYCLE_MS;
    uint32_t slotStart = (uint32_t)((TRACKER_ID - 1) * SLOT_MS) % CYCLE_MS;
    if (cycle != lastTxCycle && inCycle >= slotStart && inCycle < slotStart + SLOT_MS / 2) {
      lastTxCycle = cycle;
      if (now - lastFix.tsMs < 4000) { // keine veralteten Positionen senden
        TrackerPacket p;
        fillPacket(p, lastFix);
        int st = radio.transmit((uint8_t *)&p, sizeof(p));
        if (st == RADIOLIB_ERR_NONE) txCount++;
        else Serial.printf("TX Fehler %d\n", st);
      }
    }
  }

  trackerLedLoop(lastFix.valid && gps.location.isValid() && gps.location.age() < 3000, !loraOk);
  if (millis() - lastDisplay > 1000) { lastDisplay = millis(); updateDisplay(); }
  handleSerial();
}
