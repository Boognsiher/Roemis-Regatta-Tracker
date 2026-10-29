/*
 * Regatta-Master (bei dir im Boot)
 *  - empfaengt dauerhaft die LoRa-Pakete aller Tracker
 *  - reicht sie per BLE-Notification an das Handy weiter (Seite /gateway.html)
 *  - puffert bis zu RING_SIZE Pakete, falls das Handy gerade nicht verbunden ist, und sendet sie nach
 *
 * Mit -DOWN_TRACKER_ID=<LoRa-Nr> (Umgebung boatmaster_tbeam) ist der Master zugleich Tracker deines eigenen Boots:
 * Er liest sein GPS (1x pro Sekunde) und schickt die eigene Position direkt - ohne Funk, also verlustfrei - mit den
 * empfangenen Paketen der anderen per Bluetooth ans Handy. Er sendet selbst nichts per LoRa.
 */
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <NimBLEDevice.h>
#include "config.h"
#include "protocol.h"
#include "board.h"
#include "display.h"
#include "statusled.h"

#ifdef OWN_TRACKER_ID
#include <TinyGPSPlus.h>
static TinyGPSPlus gps;
static HardwareSerial GPSSerial(1);
static bool ownFix = false;
static uint32_t ownPushed = 0;

// Tage seit 1970 (Howard Hinnant, gregorianisch)
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}
#endif

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);

volatile bool rxFlag = false;
void IRAM_ATTR onRx() { rxFlag = true; }

#define RING_SIZE 3000
static MasterNotify ring[RING_SIZE];
static uint16_t ringHead = 0, ringTail = 0; // head = naechster freier Platz, tail = aeltester Eintrag

static inline bool ringEmpty() { return ringHead == ringTail; }
static void ringPush(const MasterNotify &m) {
  ring[ringHead] = m;
  ringHead = (ringHead + 1) % RING_SIZE;
  if (ringHead == ringTail) ringTail = (ringTail + 1) % RING_SIZE; // voll: aeltesten verwerfen
}

NimBLECharacteristic *notifyChar = nullptr;
volatile bool bleConnected = false;

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s) { bleConnected = true; }
  void onDisconnect(NimBLEServer *s) {
    bleConnected = false;
    NimBLEDevice::getAdvertising()->start();
  }
};

uint32_t rxOk = 0, rxBad = 0, lastStatus = 0, lastNotify = 0, lastDisplay = 0;
int lastId = 0, lastRssi = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("Regatta-Master");
  boardInit(true);
  displayInit();
  ledsInit();

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR, LORA_SYNC_WORD, LORA_TX_POWER_DBM,
                       LORA_PREAMBLE, LORA_TCXO_V);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("LoRa-Init fehlgeschlagen: %d (Pins/TCXO in config.h pruefen)\n", st);
    for (;;) delay(1000);
  }
  radio.setCRC(true);
  if (LORA_DIO2_RF_SWITCH) radio.setDio2AsRfSwitch(true);
  radio.setDio1Action(onRx);
  radio.startReceive();

#ifdef OWN_TRACKER_ID
  GPSSerial.setRxBufferSize(2048);
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.printf("Eigenes Boot: LoRa-Nr %d (GPS aktiv)\n", OWN_TRACKER_ID);
#endif

  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setMTU(64);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  NimBLEService *svc = server->createService(BLE_SERVICE_UUID);
  notifyChar = svc->createCharacteristic(BLE_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
  svc->start();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->start();
  Serial.println("Empfang + BLE bereit");
}

void loop() {
#ifdef OWN_TRACKER_ID
  while (GPSSerial.available()) gps.encode(GPSSerial.read());
  ownFix = gps.location.isValid() && gps.location.age() < 3000;
  // RMC-Satz abgeschlossen: eigene Position als Paket direkt in den Bluetooth-Puffer (verlustfrei, 1x pro Sekunde)
  if (gps.date.isUpdated() && gps.time.isUpdated()) {
    if (gps.date.isValid() && gps.time.isValid() && gps.location.isValid() && gps.date.year() >= 2024) {
      uint64_t epochMs =
          (uint64_t)(daysFromCivil(gps.date.year(), gps.date.month(), gps.date.day()) * 86400LL +
                     gps.time.hour() * 3600 + gps.time.minute() * 60 + gps.time.second()) * 1000ULL +
          gps.time.centisecond() * 10;
      MasterNotify m;
      m.pkt.magic = PKT_MAGIC;
      m.pkt.id = OWN_TRACKER_ID;
      m.pkt.epochSec = (uint32_t)(epochMs / 1000);
      m.pkt.centisec = (uint8_t)((epochMs % 1000) / 10);
      m.pkt.lat = (int32_t)lround(gps.location.lat() * 1e6);
      m.pkt.lon = (int32_t)lround(gps.location.lng() * 1e6);
      m.pkt.speedCms = gps.speed.isValid() ? (uint16_t)constrain((long)lround(gps.speed.mps() * 100), 0L, 65534L) : 0;
      m.pkt.headingDeg10 = gps.course.isValid() ? (uint16_t)lround(gps.course.deg() * 10) : 0xFFFF;
      float b = boardBattery();
      m.pkt.battPct = b < 0 ? 255 : (uint8_t)lround(b * 100);
      m.pkt.hdop10 = gps.hdop.isValid() ? (uint8_t)constrain((long)lround(gps.hdop.hdop() * 10), 0L, 254L) : 255;
      m.rssi = 0;
      m.snr4 = 0;
      ringPush(m);
      ownPushed++;
    }
  }
#endif

  if (rxFlag) {
    rxFlag = false;
    uint8_t buf[64];
    size_t len = radio.getPacketLength();
    int st = radio.readData(buf, len < sizeof(buf) ? len : sizeof(buf));
    if (st == RADIOLIB_ERR_NONE && len == sizeof(TrackerPacket) && buf[0] == PKT_MAGIC) {
      MasterNotify m;
      memcpy(&m.pkt, buf, sizeof(TrackerPacket));
      m.rssi = (int16_t)lround(radio.getRSSI());
      m.snr4 = (int8_t)lround(radio.getSNR() * 4);
      ringPush(m);
      rxOk++;
      lastId = m.pkt.id;
      lastRssi = m.rssi;
    } else {
      rxBad++;
    }
    radio.startReceive();
  }

  // Pro Durchlauf hoechstens ein Paket nach aussen, mit kleinem Abstand (BLE-Stack nicht fluten).
  if (bleConnected && !ringEmpty() && millis() - lastNotify >= 15) {
    lastNotify = millis();
    notifyChar->setValue((uint8_t *)&ring[ringTail], sizeof(MasterNotify));
    notifyChar->notify();
    ringTail = (ringTail + 1) % RING_SIZE;
  }

  {
    // Ampel: gruen = Handy per Bluetooth verbunden, gelb blinkt = wartet auf Handy
    static uint32_t lastBattMs = 0;
    static float batt = -1;
    if (millis() - lastBattMs > 2000) { lastBattMs = millis(); batt = boardBattery(); }
#ifdef OWN_TRACKER_ID
    LedInputs in = {true, false, bleConnected && ownFix, 0, batt, false};   // gruen: Handy verbunden UND eigener GPS-Fix
#else
    LedInputs in = {true, false, bleConnected, 0, batt, false};
#endif
    ledRender(decidePattern(in));
  }

  if (millis() - lastDisplay > 1000) {
    lastDisplay = millis();
    char l[5][24];
    float b = boardBattery();
    snprintf(l[0], sizeof(l[0]), "MASTER  Akku %s%d%%", b < 0 ? "?" : "", b < 0 ? 0 : (int)lround(b * 100));
    snprintf(l[1], sizeof(l[1]), "RX ok %u  defekt %u", (unsigned)rxOk, (unsigned)rxBad);
    snprintf(l[2], sizeof(l[2]), "Letzter: #%d %d dBm", lastId, lastRssi);
    snprintf(l[3], sizeof(l[3]), "BLE %s", bleConnected ? "verbunden" : "getrennt");
    snprintf(l[4], sizeof(l[4]), "Puffer %u", (unsigned)((ringHead + RING_SIZE - ringTail) % RING_SIZE));
#ifdef OWN_TRACKER_ID
    snprintf(l[3], sizeof(l[3]), "BLE %s  GPS %s", bleConnected ? "ok" : "--", ownFix ? "OK" : "suche");
    char own[24];
    snprintf(own, sizeof(own), "Eigen #%d Sat %d", OWN_TRACKER_ID, gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
    const char *lines[6] = {l[0], l[1], l[2], l[3], l[4], own};
    displayShow(lines, 6);
#else
    const char *lines[5] = {l[0], l[1], l[2], l[3], l[4]};
    displayShow(lines, 5);
#endif
  }

  if (millis() - lastStatus > 10000) {
    lastStatus = millis();
    Serial.printf("RX ok %u, defekt %u, BLE %s, Puffer %u\n", rxOk, rxBad, bleConnected ? "verbunden" : "getrennt",
                  (unsigned)((ringHead + RING_SIZE - ringTail) % RING_SIZE));
  }
}
