#pragma once
/*
 * Flash-Log + Hotspot-Upload (gemeinsam fuer Logger und LoRa-Tracker).
 *  - logupAdd() sammelt Eintraege (21 Byte) im RAM und schreibt sie alle WRITE_BUFFER Eintraege ins Flash.
 *  - Ein Task auf Core 0 prueft alle UPLOAD_INTERVAL_MS per WLAN-Scan, ob der Hotspot (WIFI_SSID) in Reichweite
 *    ist. Nur dann verbindet er sich und laedt alles noch nicht Hochgeladene auf den Server
 *    (POST /api/trackers/<SERVER_ID>/positions, Bearer TRACKER_TOKEN).
 * Voraussetzung: secrets.h ist vorher eingebunden (WIFI_SSID, WIFI_PASSWORD, SERVER_URL, SERVER_ID,
 * TRACKER_TOKEN, SERVER_CA_PEM, ALLOW_INSECURE_TLS).
 */
#include <Arduino.h>
#include <LittleFS.h>
#include "config.h"
#include "protocol.h"

#ifndef HOTSPOT_UPLOAD
#define HOTSPOT_UPLOAD 1            // 0 = nur im Flash aufzeichnen (Backup per USB), kein WLAN, kein secrets.h noetig
#endif
#if HOTSPOT_UPLOAD
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#endif
#define LOG_PATH            "/log.bin"
#define OFFSET_PATH         "/uploaded.txt"
#define UPLOAD_INTERVAL_MS  30000   // alle 30 s nach dem Hotspot schauen
#define WIFI_TIMEOUT_MS     10000
#define UPLOAD_CHUNK        300     // Eintraege pro HTTP-Request
#define WRITE_BUFFER        5       // Eintraege, die im RAM gesammelt werden, bevor ins Flash geschrieben wird

enum UpState : uint8_t { UP_IDLE, UP_SCAN, UP_CONNECT, UP_UPLOAD, UP_DONE, UP_ERROR };
static volatile uint8_t upState = UP_IDLE;

static const char *upStateText() {
  switch (upState) {
    case UP_SCAN: return "suche Hotspot";
    case UP_CONNECT: return "verbinde";
    case UP_UPLOAD: return "Upload...";
    case UP_DONE: return "hochgeladen";
    case UP_ERROR: return "Fehler";
    default: return "kein Hotspot";
  }
}

static SemaphoreHandle_t fsMutex = nullptr;
static TrackerPacket writeBuf[WRITE_BUFFER];
static uint8_t writeBufCount = 0;
static uint32_t entriesFlash = 0;     // Eintraege im Flash-Log
static uint32_t uploadedOffset = 0;   // Bytes im Log, die schon auf dem Server sind
static volatile bool uploadNow = false;
static bool fsOk = false;

static uint32_t logupEntries() { return entriesFlash + writeBufCount; }
static uint32_t logupUploaded() { return uploadedOffset / sizeof(TrackerPacket); }

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
    entriesFlash += writeBufCount;
  }
  xSemaphoreGive(fsMutex);
  writeBufCount = 0;
}

static void logupAdd(const TrackerPacket &p) {
  if (!fsOk) return;
  writeBuf[writeBufCount++] = p;
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

static void eraseLog() {
  flushWriteBuffer();
  xSemaphoreTake(fsMutex, portMAX_DELAY);
  LittleFS.remove(LOG_PATH);
  LittleFS.remove(OFFSET_PATH);
  uploadedOffset = 0;
  entriesFlash = 0;
  xSemaphoreGive(fsMutex);
  Serial.println("Log geloescht");
}

/** Serielle Befehle 'd' (Log als CSV), 'e' (Log loeschen), 'u' (Upload sofort versuchen). true = behandelt. */
static bool logupHandleChar(char c) {
  if (c == 'd') { dumpLog(); return true; }
  if (c == 'e') { eraseLog(); return true; }
  if (c == 'u') { uploadNow = true; Serial.println("Upload angefordert"); return true; }
  return false;
}

#if HOTSPOT_UPLOAD
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

// Kurzer Scan: nur verbinden, wenn der Hotspot wirklich in Reichweite ist (spart Strom).
static bool hotspotVisible() {
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks(false, false, false, 200);
  bool found = false;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == WIFI_SSID) { found = true; break; }
  }
  WiFi.scanDelete();
  return found;
}

static bool connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) vTaskDelay(pdMS_TO_TICKS(250));
  return WiFi.status() == WL_CONNECTED;
}

// true = alles Vorhandene hochgeladen, false = Fehler (beim naechsten Versuch geht es ab dort weiter)
static bool uploadPending() {
  static uint8_t raw[UPLOAD_CHUNK * sizeof(TrackerPacket)];
  for (;;) {
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
    if (!got) return true;

    String body;
    body.reserve(got / sizeof(TrackerPacket) * 110 + 20);
    body = "{\"positions\":[";
    bool first = true;
    for (size_t i = 0; i < got; i += sizeof(TrackerPacket)) {
      TrackerPacket p;
      memcpy(&p, raw + i, sizeof(p));
      if (p.magic != PKT_MAGIC) continue;
      unsigned long long ts = (unsigned long long)p.epochSec * 1000ULL + p.centisec * 10;
      char item[200];
      int n = snprintf(item, sizeof(item), "%s{\"lat\":%.6f,\"lon\":%.6f,\"ts\":%llu,\"speed\":%.2f",
                       first ? "" : ",", p.lat / 1e6, p.lon / 1e6, ts, p.speedCms / 100.0);
      first = false;
      if (p.headingDeg10 != 0xFFFF) n += snprintf(item + n, sizeof(item) - n, ",\"heading\":%.1f", p.headingDeg10 / 10.0);
      if (p.battPct != 255) n += snprintf(item + n, sizeof(item) - n, ",\"battery\":%.2f", p.battPct / 100.0);
      if (p.hdop10 != 255) n += snprintf(item + n, sizeof(item) - n, ",\"accuracy\":%.1f", p.hdop10 / 10.0 * 5.0);
      snprintf(item + n, sizeof(item) - n, "}");
      body += item;
    }
    body += "]}";

    if (!postChunk(body)) return false;
    uploadedOffset += got;
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
    if (size <= uploadedOffset) continue; // nichts Neues (die letzten <=5 s im RAM-Puffer gehen spaeter mit)

    upState = UP_SCAN;
    if (!hotspotVisible()) {
      WiFi.mode(WIFI_OFF);
      upState = UP_IDLE;
      continue;
    }
    upState = UP_CONNECT;
    if (connectWifi()) {
      upState = UP_UPLOAD;
      upState = uploadPending() ? UP_DONE : UP_ERROR;
    } else {
      upState = UP_ERROR;
    }
    WiFi.disconnect(true, false);
    WiFi.mode(WIFI_OFF);
  }
}

#endif  // HOTSPOT_UPLOAD

/** Dateisystem oeffnen, Log reparieren, Upload-Task starten. Als erstes im setup() nach Serial.begin() aufrufen. */
static void logupInit() {
  fsMutex = xSemaphoreCreateMutex();
  fsOk = LittleFS.begin(true);
  if (!fsOk) { Serial.println("LittleFS Fehler - keine Aufzeichnung moeglich!"); return; }
  repairLog();
  loadOffset();
  entriesFlash = logSizeLocked() / sizeof(TrackerPacket);
#if HOTSPOT_UPLOAD
  xTaskCreatePinnedToCore(uploadTask, "upload", 12288, nullptr, 1, nullptr, 0);
#endif
}
