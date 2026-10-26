/*
 * Regatta-Master (bei dir im Boot)
 *  - empfaengt dauerhaft die LoRa-Pakete aller Tracker
 *  - reicht sie per BLE-Notification an das Handy weiter (Seite /gateway.html)
 *  - puffert bis zu RING_SIZE Pakete, falls das Handy gerade nicht verbunden ist, und sendet sie nach
 */
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <NimBLEDevice.h>
#include "config.h"
#include "protocol.h"

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

uint32_t rxOk = 0, rxBad = 0, lastStatus = 0, lastNotify = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("Regatta-Master");

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR, LORA_SYNC_WORD, LORA_TX_POWER_DBM,
                       LORA_PREAMBLE, LORA_TCXO_V);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("LoRa-Init fehlgeschlagen: %d (Pins/TCXO in config.h pruefen)\n", st);
    for (;;) delay(1000);
  }
  radio.setCRC(true);
  radio.setDio1Action(onRx);
  radio.startReceive();

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

  if (millis() - lastStatus > 10000) {
    lastStatus = millis();
    Serial.printf("RX ok %u, defekt %u, BLE %s, Puffer %u\n", rxOk, rxBad, bleConnected ? "verbunden" : "getrennt",
                  (unsigned)((ringHead + RING_SIZE - ringTail) % RING_SIZE));
  }
}
