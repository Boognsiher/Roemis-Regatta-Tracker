# Firmware: Funk-Tracker (LoRa) + Master

```
Tracker (GPS + LoRa, auf jedem Boot) --LoRa 869.525 MHz--> Master-ESP32 (bei dir im Boot)
   --Bluetooth (BLE)--> dein Android-Handy (/gateway.html) --Internet--> Server
```

**Status:** Der Code ist geschrieben, aber noch **nicht auf echter Hardware getestet und nicht kompiliert**
(in der Entwicklungsumgebung war PlatformIO nicht installierbar). Erwartet Anpassungen bei Pins/TCXO und evtl.
Kleinigkeiten beim ersten Kompilieren. Das Funkpaket (`lora-packet.js`) und der Server-Teil sind getestet.

## Hardware (guenstig)

Pro Tracker, alle Preise grobe Schaetzungen (bitte aktuell pruefen):

| Variante | Teile | ca. Kosten |
|---|---|---|
| **A: Fertigboard** (empfohlen, weniger Loeten) | Heltec WiFi LoRa 32 V3 (ESP32-S3 + SX1262, LiPo-Anschluss) + GPS-Modul ATGM336H oder NEO-6M + LiPo 1000-2000 mAh + 868-MHz-Antenne (meist dabei) | ~35-40 EUR |
| **B: Eigenbau mit deinen ESP32-S3** | ESP32-S3-DevKit (hast du) + SX1262-LoRa-Modul 868 MHz (z.B. Waveshare Core1262-HF / EByte E22-900M22S) + ATGM336H + TP4056-Lader + LiPo | ~20-25 EUR |

- **Master:** gleiches Board wie ein Tracker (Master braucht kein GPS). Mit guter Antenne, moeglichst hoch/frei montiert.
- **Antenne ist wichtiger als alles andere.** Nie ohne Antenne senden (zerstoert die Endstufe). Auf dem Wasser
  funktionieren einfache 868-MHz-Antennen mit Sichtverbindung oft ueber mehrere km.
- **GPS:** ATGM336H/NEO-6M/NEO-M8N, 9600 Baud, **mit PPS-Pin verdrahten** (siehe unten). Die Position wird
  nur 1x pro Sekunde gebraucht.
- **Wasserdicht:** Dose/Gehaeuse mit Dichtung, Akku nicht in der Sonne.
- Laufzeit: etwa 15-20 h mit 2000 mAh, wenn Display/WLAN/BLE aus sind (Tracker nutzt nur GPS + LoRa).

### Verdrahtung

Heltec V3: LoRa ist onboard, nur GPS anschliessen: GPS-TX -> GPIO4, GPS-RX -> GPIO5 (optional), PPS -> GPIO6,
VCC 3.3 V, GND. Fuer den Heltec in `platformio.ini` `-DBOARD_HELTEC_V3` einkommentieren.

Eigenbau: Pins stehen in `include/config.h` (Abschnitt "Allgemeiner ESP32-S3"). **Unbedingt gegen dein Modul
und Datenblatt pruefen**, vor allem `LORA_TCXO_V` (Module mit TCXO brauchen 1.8, sonst 0).

## Funkparameter, Reichweite, Zeitfenster

- 869.525 MHz, 125 kHz, SF7: Paket 21 Byte = ca. 57 ms Sendezeit. Laut Duty-Cycle-Regel (10 % im Band
  869.4-869.65) sind 57 ms alle 2 s (2.9 %) erlaubt. Bitte Bandplan/Leistung fuer euren Standort pruefen.
- **Zeitfenster-Verfahren (TDMA):** Jeder Tracker sendet nur in seinem Fenster:
  `(GPS-Zeit mod 2000 ms)` im Bereich `(TRACKER_ID-1) * 100 ms`. Die GPS-Zeit hat jeder Tracker selbst, es braucht
  keine Verbindung zum Master. Dadurch kollidieren die Boote nicht. Bis 20 Boote alle 2 s (`CYCLE_MS = SLOT_MS * Bootszahl`).
- Ohne PPS-Verdrahtung ist die Fenstergenauigkeit nur etwa +-200 ms -> Kollisionen moeglich.
- Die **Positionszeit** im Paket kommt immer direkt aus dem GPS-Datensatz und ist unabhaengig von Funk-Latenz.
- LoRa hat keine Quittung: einzelne Pakete koennen fehlen. Darum schreibt jeder Tracker zusaetzlich jede
  Sekunde ins Flash-Log (siehe unten).

## Flashen

```bash
cd firmware
# Tracker: TRACKER_ID in include/config.h setzen (= LoRa-Nr aus dem Admin-Bereich), dann
pio run -e tracker -t upload
# Master:
pio run -e master -t upload
```

Serieller Monitor (115200): Tracker zeigt Status mit `s`. Master gibt alle 10 s Empfangszaehler aus.

## Ablauf am Regattatag

1. Server laeuft, im Admin Tracker anlegen (jeder bekommt eine **LoRa-Nr**, aenderbar im Admin). Die Nr in die
   Firmware des jeweiligen Geraets eintragen.
2. Master im Boot einschalten. Am Android-Handy in Chrome `https://<server>/gateway.html` oeffnen, Token eingeben,
   "Mit Master verbinden". Die Tabelle "Zuletzt gehoert" zeigt alle empfangenen Boote mit RSSI.
3. Optional "Eigenes Boot per Handy-GPS melden" aktivieren (waehlt den Tracker fuer dein eigenes Boot).
4. Die Seite waehrend der Regatta offen lassen, Bildschirm an (Wake Lock). Bei Bluetooth-Abbruch verbindet die
   Seite automatisch neu; der Master puffert bis zu 3000 Pakete und sendet sie nach. Bei Internet-Ausfall puffert
   das Handy und sendet nach.
5. Nach der Regatta: fehlende Paket-Luecken mit dem **Flash-Log** schliessen: Tracker per USB anschliessen,
   `d` im seriellen Monitor -> CSV speichern, dann
   `node scripts/upload-log.js https://<server> <token> <LoRa-Nr> boot7.csv`. `e` loescht das Log.

## Token

Fuer das Gateway-Handy besser ein eigenes `GATEWAY_TOKEN` (in `.env`) benutzen: damit kann man nur
Positionen melden, nichts verwalten. Der Admin-Token funktioniert ebenfalls.

## Grenzen / Todo

- Android + Chrome noetig (Web Bluetooth). iPhone geht so nicht.
- Hintergrund-Betrieb: Chrome darf im Hintergrund Bluetooth/Netz drosseln, daher Seite im Vordergrund lassen.
- Kein OTA-Update, keine Verschluesselung/Authentifizierung auf Funkebene (Sync-Word ist nur eine Netz-Trennung).
