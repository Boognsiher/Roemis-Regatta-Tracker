#pragma once
/*
 * Gemeinsame Einstellungen fuer Tracker und Master. Beide muessen die LoRa-Parameter identisch haben.
 */

// ---------- Funk (LoRa) ----------
// 869.525 MHz: Unterband g3 (869.4-869.65 MHz), 10 % Duty-Cycle, bis 500 mW ERP (EU/CH SRD-Band).
// Bitte fuer euren Einsatzort pruefen. Mit 125 kHz Bandbreite liegt das sicher innerhalb des Bandes.
#define LORA_FREQ_MHZ     869.525f
#define LORA_BW_KHZ       125.0f
#define LORA_SF           7        // SF7 = kurze Sendezeit (~57 ms); fuer mehr Reichweite SF8/SF9, dann CYCLE/SLOT anpassen
#define LORA_CR           5        // Coding Rate 4/5
#define LORA_SYNC_WORD    0x12     // privates Netz; fuer ein getrenntes Netz einen anderen Wert waehlen
#define LORA_TX_POWER_DBM 14       // 14 dBm = 25 mW; auf dem Wasser reicht das meist fuer mehrere km
#define LORA_PREAMBLE     8

// ---------- Zeitfenster (TDMA) ----------
// Jeder Tracker sendet nur in "seinem" Zeitfenster, berechnet aus der GPS-Zeit. So kollidieren die Boote nicht.
// Zyklus = alle Tracker haben einmal gesendet. Bei 100 ms Fenstern passen 20 Boote in 2000 ms.
#define SLOT_MS           100
#define CYCLE_MS          2000     // = SLOT_MS * (max. Anzahl Boote)  -> hier 20 Boote, Position alle 2 s
// Mehr als 20 Boote? CYCLE_MS = SLOT_MS * Bootszahl (Position dann seltener).

// ---------- BLE (Master -> Handy) ----------
#define BLE_DEVICE_NAME   "RegattaMaster"
#define BLE_SERVICE_UUID  "a7d0c001-5e1b-4f6a-9a53-2d4f7b6c9e10"
#define BLE_CHAR_UUID     "a7d0c002-5e1b-4f6a-9a53-2d4f7b6c9e10"

// ---------- Pins ----------
#if defined(BOARD_HELTEC_V3)
  // Heltec WiFi LoRa 32 V3 (ESP32-S3 + SX1262 onboard)
  #define LORA_SCK   9
  #define LORA_MISO  11
  #define LORA_MOSI  10
  #define LORA_NSS   8
  #define LORA_RST   12
  #define LORA_BUSY  13
  #define LORA_DIO1  14
  #define LORA_TCXO_V 1.8f       // Heltec V3 hat einen TCXO
  #define LORA_DIO2_RF_SWITCH 1  // DIO2 steuert den Antennenschalter
  #define GPS_RX_PIN 4           // ESP32 empfaengt <- GPS-TX
  #define GPS_TX_PIN 5
  #define GPS_PPS_PIN 6          // -1 wenn PPS nicht verdrahtet
  #define BAT_ADC_PIN 1
  #define BAT_CTRL_PIN 37        // Heltec V3: LOW = Spannungsteiler aktiv
  #define BAT_DIVIDER 4.9f
#elif defined(BOARD_TBEAM_V12)
  // LilyGO T-Beam V1.2 (ESP32 + SX1262 + GPS, Strom-Chip AXP2101). Pins nach Meshtastic/LilyGO-Belegung -
  // vor dem ersten Einsatz mit dem Schaltplan deiner Revision vergleichen!
  #define LORA_SCK   5
  #define LORA_MISO  19
  #define LORA_MOSI  27
  #define LORA_NSS   18
  #define LORA_RST   23
  #define LORA_BUSY  32
  #define LORA_DIO1  33
  #define LORA_TCXO_V 1.8f
  #define LORA_DIO2_RF_SWITCH 1
  #define GPS_RX_PIN 34          // ESP32 empfaengt <- GPS-TX
  #define GPS_TX_PIN 12
  #define GPS_PPS_PIN 37         // nur Eingang; fuer den Logger nicht noetig
  #define TBEAM_SDA  21          // I2C zum Strom-Chip
  #define TBEAM_SCL  22
  #define BAT_ADC_PIN -1         // Akkustand kommt vom Strom-Chip (board.h)
  #define BAT_CTRL_PIN -1
  #define BAT_DIVIDER 1.0f
#else
  // Allgemeiner ESP32-S3-DevKit + SX1262-Modul (z.B. Waveshare Core1262 / EByte E22-900M22S). ANPASSEN!
  #define LORA_SCK   12
  #define LORA_MISO  13
  #define LORA_MOSI  11
  #define LORA_NSS   10
  #define LORA_RST   9
  #define LORA_BUSY  8
  #define LORA_DIO1  3
  #define LORA_TCXO_V 0.0f       // 0 = kein TCXO; bei Modulen mit TCXO 1.8 (Datenblatt!)
  #define LORA_DIO2_RF_SWITCH 0  // 1, wenn DIO2 den Antennenschalter steuert (Datenblatt/Schaltung des Moduls)
  #define GPS_RX_PIN 16
  #define GPS_TX_PIN 17
  #define GPS_PPS_PIN 15
  #define BAT_ADC_PIN -1         // -1 = Akkuanzeige aus (255 = unbekannt)
  #define BAT_CTRL_PIN -1
  #define BAT_DIVIDER 2.0f
#endif

#define GPS_BAUD 9600

// ---------- Tracker ----------
#ifndef TRACKER_ID
#define TRACKER_ID 1               // 1..250, muss pro Geraet eindeutig und im Admin-Bereich zugewiesen sein
#endif
