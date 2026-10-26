/*
 * Regatta-Tracker (Funk-Tracker fuer jedes Boot)
 *  - liest GPS (NMEA, optional PPS) und sendet die Position im eigenen Zeitfenster per LoRa
 *  - schreibt jede Position (1x/s) zusaetzlich ins Flash (Backup fuer die offizielle Auswertung)
 *  - Serielle Befehle (115200): 'd' = Log als CSV ausgeben, 'e' = Log loeschen, 's' = Status
 */
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <TinyGPSPlus.h>
#include <LittleFS.h>
#include "config.h"
#include "protocol.h"

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
TinyGPSPlus gps;
HardwareSerial GPSSerial(1);

// ---- Zeitbasis: GPS-Zeit mit Millisekunden-Aufloesung ----
// Mit PPS ist der Anker exakt (Sekundenimpuls); ohne PPS wird die Ankunftszeit des NMEA-Satzes minus
// NMEA_LATENCY_US genutzt (Genauigkeit nur ca. +-200 ms - fuer die Zeitfenster ok, Positionszeit
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

float readBattery() {
#if BAT_ADC_PIN >= 0
  if (BAT_CTRL_PIN >= 0) { pinMode(BAT_CTRL_PIN, OUTPUT); digitalWrite(BAT_CTRL_PIN, LOW); }
  uint32_t mv = analogReadMilliVolts(BAT_ADC_PIN);
  float v = mv / 1000.0f * BAT_DIVIDER;
  float pct = (v - 3.3f) / (4.2f - 3.3f); // grobe LiPo-Naeherung
  return pct < 0 ? 0 : (pct > 1 ? 1 : pct);
#else
  return -1;
#endif
}

void fillPacket(TrackerPacket &p, const Fix &f) {
  p.magic = PKT_MAGIC;
  p.id = TRACKER_ID;
  p.epochSec = (uint32_t)(f.tsMs / 1000);
  p.centisec = (uint8_t)((f.tsMs % 1000) / 10);
  p.lat = (int32_t)lround(f.lat * 1e6);
  p.lon = (int32_t)lround(f.lon * 1e6);
  p.speedCms = (uint16_t)constrain((long)lround(f.speedMs * 100), 0L, 65534L);
  p.headingDeg10 = f.course < 0 ? 0xFFFF : (uint16_t)lround(f.course * 10);
  float b = readBattery();
  p.battPct = b < 0 ? 255 : (uint8_t)lround(b * 100);
  p.hdop10 = f.hdop < 0 ? 255 : (uint8_t)constrain((long)lround(f.hdop * 10), 0L, 254L);
}

// ---- Flash-Log ----
File logFile;
uint32_t lastLogFlush = 0;
uint64_t lastLoggedTs = 0;
bool fsOk = false;

void logFix(const Fix &f) {
  if (!fsOk || f.tsMs == lastLoggedTs) return;
  lastLoggedTs = f.tsMs;
  TrackerPacket p;
  fillPacket(p, f);
  logFile.write((const uint8_t *)&p, sizeof(p));
  if (millis() - lastLogFlush > 5000) { logFile.flush(); lastLogFlush = millis(); }
}

void dumpLog() {
  if (logFile) logFile.flush();
  File r = LittleFS.open("/log.bin", "r");
  if (!r) { Serial.println("kein Log"); return; }
  Serial.println("ts_ms,lat,lon,speed_ms,heading_deg");
  TrackerPacket p;
  while (r.read((uint8_t *)&p, sizeof(p)) == sizeof(p)) {
    if (p.magic != PKT_MAGIC) continue;
    uint64_t ts = (uint64_t)p.epochSec * 1000 + p.centisec * 10;
    Serial.printf("%llu,%.6f,%.6f,%.2f,%s\n", ts, p.lat / 1e6, p.lon / 1e6, p.speedCms / 100.0,
                  p.headingDeg10 == 0xFFFF ? "" : String(p.headingDeg10 / 10.0, 1).c_str());
  }
  r.close();
}

uint32_t txCount = 0;
uint64_t lastTxCycle = UINT64_MAX;

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'd') dumpLog();
    else if (c == 'e') {
      if (logFile) logFile.close();
      LittleFS.remove("/log.bin");
      logFile = LittleFS.open("/log.bin", "a");
      Serial.println("Log geloescht");
    } else if (c == 's') {
      Serial.printf("ID %d | Sat %d | Fix %s | gesendet %u | Log %u Byte\n", TRACKER_ID,
                    gps.satellites.isValid() ? (int)gps.satellites.value() : -1,
                    lastFix.valid ? "ja" : "nein", txCount, logFile ? (unsigned)logFile.size() : 0);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("Regatta-Tracker, ID %d\n", TRACKER_ID);

  fsOk = LittleFS.begin(true);
  if (fsOk) logFile = LittleFS.open("/log.bin", "a");

  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  if (GPS_PPS_PIN >= 0) attachInterrupt(digitalPinToInterrupt(GPS_PPS_PIN), onPps, RISING);

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR, LORA_SYNC_WORD, LORA_TX_POWER_DBM,
                       LORA_PREAMBLE, LORA_TCXO_V);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("LoRa-Init fehlgeschlagen: %d (Pins/TCXO in config.h pruefen)\n", st);
    for (;;) delay(1000);
  }
  radio.setCRC(true);
  Serial.println("LoRa bereit");
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
      logFix(lastFix);
    }
  }

  // Sendefenster: (TRACKER_ID-1)*SLOT_MS innerhalb des Zyklus, Start in der ersten Haelfte des Fensters.
  uint64_t now = gpsNowMs();
  if (now && lastFix.valid) {
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

  handleSerial();
}
