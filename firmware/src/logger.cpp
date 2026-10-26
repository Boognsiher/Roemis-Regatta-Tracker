/*
 * Regatta-Logger (guenstigste Variante: nur ESP32 + GPS + Akku, kein LoRa)
 *  - schreibt jede Sekunde Position + GPS-Zeit ins Flash (/log.bin, 21 Byte pro Eintrag)
 *  - sucht regelmaessig den Hotspot des Master-Handys; sobald er in Reichweite ist, laedt das Geraet das Log
 *    (nur noch nicht hochgeladene Eintraege) direkt auf den Server hoch
 *  - Serielle Befehle (115200): 'd' Log als CSV, 'e' Log loeschen, 's' Status, 'u' Upload sofort versuchen
 *
 * Der Upload laeuft in einem eigenen Task auf Core 0, damit die GPS-Aufzeichnung nie unterbrochen wird.
 */
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "include/secrets.h fehlt: include/secrets.h.example kopieren und ausfuellen"
#endif

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <TinyGPSPlus.h>
#include "config.h"
#include "protocol.h"
#include "board.h"

#define LOG_PATH            "/log.bin"
#define OFFSET_PATH         "/uploaded.txt"
#define UPLOAD_INTERVAL_MS  30000   // alle 30 s pruefen, ob Daten warten und der Hotspot da ist
#define WIFI_TIMEOUT_MS     10000
#define UPLOAD_CHUNK        300     // Eintraege pro HTTP-Request
#define WRITE_BUFFER        5       // Eintraege, die im RAM gesammelt werden, bevor ins Flash geschrieben wird

TinyGPSPlus gps;
HardwareSerial GPSSerial(1);
SemaphoreHandle_t fsMutex;

static TrackerPacket writeBuf[WRITE_BUFFER];
static uint8_t writeBufCount = 0;
static uint64_t lastLoggedTs = 0;
static uint32_t uploadedOffset = 0;
static uint32_t uploadedTotal = 0;
static volatile bool uploadNow = false;
static bool fsOk = false;
static uint32_t logCount = 0;

// Tage seit 1970 (Howard Hinnant, gregorianisch)
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

// ---------- Flash-Log ----------

static uint32_t logSizeLocked() {
  File f = LittleFS.open(LOG_PATH, "r");
  if (!f) return 0;
  uint32_t n = f.size();
  f.close();
  return n;
}

// Nach Stromausfall kann ein halber Eintrag am Ende stehen: auf ganze Eintraege kuerzen.
static void repairLog() {
  uint32_t size = logSizeLocked();
  uint32_t good = size - size % sizeof(TrackerPacket);
  if (good == size) return;
  File r = LittleFS.open(LOG_PATH, "r");
  uint8_t *buf = (uint8_t *)malloc(good ? good : 1);
  if (!r || !buf) { if (r) r.close(); free(buf); return; }
  r.read(buf, good);
  r.close();
  File w = LittleFS.open(LOG_PATH, "w");
  w.write(buf, good);
  w.close();
  free(buf);
  Serial.println("Log repariert (halber Eintrag am Ende entfernt)");
}

static void flushWriteBuffer() {
  if (!writeBufCount) return;
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  File f = LittleFS.open(LOG_PATH, "a");
  if (f) {
    f.write((const uint8_t *)writeBuf, writeBufCount * sizeof(TrackerPacket));
    f.close();
  }
  xSemaphoreGive(fsMutex);
  writeBufCount = 0;
}

static void logPacket(const TrackerPacket &p) {
  if (!fsOk) return;
  writeBuf[writeBufCount++] = p;
  logCount++;
  if (writeBufCount >= WRITE_BUFFER) flushWriteBuffer();
}

static void loadOffset() {
  File f = LittleFS.open(OFFSET_PATH, "r");
  if (!f) return;
  uploadedOffset = (uint32_t)f.readString().toInt();
  f.close();
  uploadedOffset -= uploadedOffset % sizeof(TrackerPacket);
}

static void saveOffset() {
  File f = LittleFS.open(OFFSET_PATH, "w");
  if (f) { f.print(uploadedOffset); f.close(); }
}

static void dumpLog() {
  flushWriteBuffer();
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  File r = LittleFS.open(LOG_PATH, "r");
  if (!r) { xSemaphoreGive(fsMutex); Serial.println("kein Log"); return; }
  Serial.println("ts_ms,lat,lon,speed_ms,heading_deg");
  TrackerPacket p;
  while (r.read((uint8_t *)&p, sizeof(p)) == sizeof(p)) {
    if (p.magic != PKT_MAGIC) continue;
    uint64_t ts = (uint64_t)p.epochSec * 1000 + p.centisec * 10;
    Serial.printf("%llu,%.6f,%.6f,%.2f,", (unsigned long long)ts, p.lat / 1e6, p.lon / 1e6, p.speedCms / 100.0);
    if (p.headingDeg10 != 0xFFFF) Serial.printf("%.1f", p.headingDeg10 / 10.0);
    Serial.println();
  }
  r.close();
  xSemaphoreGive(fsMutex);
}

// ---------- Upload ----------

static bool postChunk(const String &body) {
  String url = String(SERVER_URL) + "/api/trackers/" + SERVER_ID + "/positions";
  WiFiClientSecure sec;
  WiFiClient plain;
  HTTPClient http;
  if (url.startsWith("https")) {
    if (strlen(SERVER_CA_PEM) > 10) sec.setCACert(SERVER_CA_PEM);
    else if (ALLOW_INSECURE_TLS) sec.setInsecure();
    else { Serial.println("Upload: SERVER_CA_PEM fehlt in secrets.h"); return false; }
    http.begin(sec, url);
  } else {
    http.begin(plain, url);
  }
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + TRACKER_TOKEN);
  int code = http.POST(body);
  http.end();
  if (code != 200) Serial.printf("Upload HTTP %d\n", code);
  return code == 200;
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) vTaskDelay(pdMS_TO_TICKS(250));
  return WiFi.status() == WL_CONNECTED;
}

static void uploadPending() {
  for (;;) {
    // Naechsten Block aus dem Flash lesen (nur dort kurz sperren)
    static uint8_t raw[UPLOAD_CHUNK * sizeof(TrackerPacket)];
    xSemaphoreTake(fsMutex, portMAX_DELAY);
    File r = LittleFS.open(LOG_PATH, "r");
    size_t got = 0;
    if (r) {
      r.seek(uploadedOffset);
      got = r.read(raw, sizeof(raw));
      r.close();
    }
    xSemaphoreGive(fsMutex);
    got -= got % sizeof(TrackerPacket);
    if (!got) return;

    String body;
    body.reserve(got / sizeof(TrackerPacket) * 110 + 20);
    body = "{\"positions\":[";
    for (size_t i = 0; i < got; i += sizeof(TrackerPacket)) {
      TrackerPacket p;
      memcpy(&p, raw + i, sizeof(p));
      if (p.magic != PKT_MAGIC) continue;
      unsigned long long ts = (unsigned long long)p.epochSec * 1000ULL + p.centisec * 10;
      char item[200];
      int n = snprintf(item, sizeof(item), "%s{\"lat\":%.6f,\"lon\":%.6f,\"ts\":%llu,\"speed\":%.2f",
                       body.endsWith("[") ? "" : ",", p.lat / 1e6, p.lon / 1e6, ts, p.speedCms / 100.0);
      if (p.headingDeg10 != 0xFFFF) n += snprintf(item + n, sizeof(item) - n, ",\"heading\":%.1f", p.headingDeg10 / 10.0);
      if (p.battPct != 255) n += snprintf(item + n, sizeof(item) - n, ",\"battery\":%.2f", p.battPct / 100.0);
      if (p.hdop10 != 255) n += snprintf(item + n, sizeof(item) - n, ",\"accuracy\":%.1f", p.hdop10 / 10.0 * 5.0);
      snprintf(item + n, sizeof(item) - n, "}");
      body += item;
    }
    body += "]}";

    if (!postChunk(body)) return;           // beim naechsten Versuch ab hier weiter
    uploadedOffset += got;
    uploadedTotal += got / sizeof(TrackerPacket);
    xSemaphoreTake(fsMutex, portMAX_DELAY);
    saveOffset();
    xSemaphoreGive(fsMutex);
    Serial.printf("Upload ok: %u Eintraege\n", (unsigned)(got / sizeof(TrackerPacket)));
  }
}

static void uploadTask(void *) {
  for (;;) {
    for (uint32_t waited = 0; waited < UPLOAD_INTERVAL_MS && !uploadNow; waited += 500) vTaskDelay(pdMS_TO_TICKS(500));
    uploadNow = false;

    xSemaphoreTake(fsMutex, portMAX_DELAY);
    uint32_t size = logSizeLocked();
    xSemaphoreGive(fsMutex);
    // Gepufferte, noch nicht geschriebene Eintraege (max. 5 s) gehen im naechsten Durchlauf mit.
    if (size <= uploadedOffset) continue;

    if (connectWifi()) uploadPending();
    WiFi.disconnect(true, false);
    WiFi.mode(WIFI_OFF);
  }
}

// ---------- Hauptprogramm ----------

static void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'd') dumpLog();
    else if (c == 'u') { uploadNow = true; Serial.println("Upload angefordert"); }
    else if (c == 'e') {
      flushWriteBuffer();
      xSemaphoreTake(fsMutex, portMAX_DELAY);
      LittleFS.remove(LOG_PATH);
      LittleFS.remove(OFFSET_PATH);
      uploadedOffset = 0;
      xSemaphoreGive(fsMutex);
      Serial.println("Log geloescht");
    } else if (c == 's') {
      xSemaphoreTake(fsMutex, portMAX_DELAY);
      uint32_t size = logSizeLocked();
      xSemaphoreGive(fsMutex);
      Serial.printf("ID %d | Sat %d | Eintraege im Log %u | hochgeladen %u | Fix %s\n", TRACKER_ID,
                    gps.satellites.isValid() ? (int)gps.satellites.value() : -1, (unsigned)(size / sizeof(TrackerPacket)),
                    (unsigned)(uploadedOffset / sizeof(TrackerPacket)), gps.location.isValid() ? "ja" : "nein");
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("Regatta-Logger, ID %d\n", TRACKER_ID);
  boardInit(false);

  fsMutex = xSemaphoreCreateMutex();
  fsOk = LittleFS.begin(true);
  if (!fsOk) Serial.println("LittleFS Fehler - keine Aufzeichnung moeglich!");
  else { repairLog(); loadOffset(); }

  GPSSerial.setRxBufferSize(2048);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  xTaskCreatePinnedToCore(uploadTask, "upload", 12288, nullptr, 1, nullptr, 0);
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
        logPacket(p);
      }
    }
  }

  handleSerial();
}
