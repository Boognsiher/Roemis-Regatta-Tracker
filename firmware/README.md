# Firmware

Zwei Ausbaustufen, **dieselbe Hardware-Basis (ESP32-S3 + GPS + Akku)**:

1. **Logger (Start-Variante, ~12-15 EUR pro Boot, ohne LoRa):** zeichnet jede Sekunde Position + GPS-Zeit
   im Flash auf und laedt das Log automatisch ueber den **Hotspot deines Handys** auf den Server, sobald das Boot
   in Reichweite ist (Start-/Zielbereich). Reicht fuer die offizielle Zeitmessung. Keine Live-Karte waehrend der Fahrt.
2. **LoRa-Live (spaeter, optional):** LoRa-Modul + Antenne nachruesten, dann sehen Zuschauer die Boote live
   (siehe weiter unten). Das Log im Flash bleibt als Backup.

## Logger (Start-Variante)

Hardware pro Boot: ESP32-S3 (z.B. dein vorhandenes DevKit), GPS-Modul (ATGM336H/NEO-6M, 9600 Baud), LiPo +
Lademodul (TP4056). Verdrahtung: GPS-TX -> `GPS_RX_PIN`, GPS-RX -> `GPS_TX_PIN` (Pins in `include/config.h`),
3.3 V, GND. PPS wird hier nicht gebraucht: die Zeit kommt direkt aus dem GPS-Datensatz.

**Tipp fuer spaeteres LoRa (Firmware `tracker` kann dann beides: Live-Funk + Hotspot-Upload):** Lass die SPI-Pins (`LORA_*` in config.h) am ESP32 frei, oder nimm gleich ein
Heltec WiFi LoRa 32 V3 (hat den LoRa-Chip schon an Bord, dann fehlt spaeter nur die Antenne + Firmware `tracker`).

Einrichten (pro Geraet):
1. Im Admin-Bereich den Tracker anlegen, beim Tracker **"Firmware-Config kopieren"** klicken.
2. `include/secrets.h.example` nach `include/secrets.h` kopieren, die kopierten Zeilen (SERVER_URL, TRACKER_ID,
   SERVER_ID, TRACKER_TOKEN) einsetzen, Hotspot-Name/-Passwort eintragen, und fuer HTTPS das Root-Zertifikat
   (`SERVER_CA_PEM`) einfuegen (z.B. Let's Encrypt: `curl -O https://letsencrypt.org/certs/isrgrootx1.pem`).
3. `pio run -e logger -t upload`

Am Regattatag:
1. Geraete im Boot einschalten (warten bis GPS-Fix, Seriell `s` zeigt Satelliten). Aufzeichnung startet selbst.
2. Dein Handy: **Hotspot an** (2.4 GHz, gleicher Name/Passwort wie in `secrets.h`, mobile Daten an).
   Jedes Geraet prueft alle 30 s, ob der Hotspot da ist, und laedt dann nur das noch nicht Hochgeladene.
   Bereits uebertragene Daten gehen nicht doppelt hoch (Offset im Flash), und der Server entfernt Duplikate ohnehin.
3. Wettfahrt wie gewohnt in `/regatta.html` starten; nach dem Zieleinlauf kommen die Logs der Boote beim Hotspot
   an und das Ergebnis erscheint. Hotspot-Reichweite auf dem Wasser ca. 30-50 m.
4. Notfall/Backup: Geraet per USB, `d` im seriellen Monitor -> CSV, dann `scripts/upload-log.js`.

Grenzen: maximal etwa 8-10 gleichzeitig verbundene Geraete pro Android-Hotspot (fuer 5 Boote unkritisch).
Der Flash reicht fuer etwa 20 Stunden Aufzeichnung (ca. 75 KB pro Stunde). Befehle seriell: `d` Log ausgeben,
`e` Log loeschen (nach der Regatta empfohlen), `s` Status, `u` Upload sofort versuchen.

## LilyGO T-Beam V1.2 (ESP32 + SX1262 + GPS + 18650)

Fertiges Profil `BOARD_TBEAM_V12` (Pins in `include/config.h`, Strom-Chip in `include/board.h`). Drei Programme:

```bash
pio run -e logger_tbeam  -t upload   # Hotspot-Logger, LoRa aus (spart Strom)
pio run -e tracker_tbeam -t upload   # LoRa-Funk-Tracker
pio run -e master_tbeam  -t upload   # LoRa-Master (auch ein T-Beam, GPS bleibt ungenutzt)
```

Wichtig:
- **868-MHz-Version** (SX1262) kaufen, V1.2 mit **AXP2101**-Strom-Chip. Bei V1.0/V1.1 (AXP192) meldet die
  Firmware "PMU (AXP2101) nicht gefunden" - dafuer ist `board.h` noch nicht angepasst.
- GPS und LoRa bekommen auf dem T-Beam nur Strom, wenn der Strom-Chip initialisiert ist. Das macht `boardInit()`.
- 18650-Akku (nicht im Lieferumfang, geschuetzte Zelle empfohlen) einsetzen, Laden per USB-C. Akkustand kommt vom
  Strom-Chip und wird im Paket / Upload mitgeschickt.
- **Pins und TCXO-Spannung (1.8 V) stammen aus der Meshtastic-/LilyGO-Belegung und sind noch nicht an echter
  Hardware geprueft.** Bei "LoRa-Init fehlgeschlagen" zuerst `LORA_*` und `LORA_TCXO_V` in `config.h` gegen den
  Schaltplan deiner Revision pruefen.
- Antenne vor dem Einschalten anschliessen (LoRa-Antenne am SMA-Anschluss, GPS-Keramikantenne ist verbaut/beiliegend).

### Direkt mit LoRa starten (T-Beam)

Ja, das geht ohne Umbau: fuer 5 Boote **5 x `tracker_tbeam`** (TRACKER_ID = LoRa-Nr aus dem Admin, 1..5) plus
**1 x `master_tbeam`** bei dir im Boot, dann Gateway-Seite am Android-Handy (siehe unten "Ablauf am Regattatag").
Beachte:
- LoRa hat keine Quittung, einzelne Pakete koennen fehlen. Darum schreibt jeder LoRa-Tracker zusaetzlich das
  Flash-Log und **laedt es wie der Logger ueber den Hotspot hoch** (gleiche `secrets.h`, gleicher Ablauf). So hat
  der Server nach dem Zieleinlauf die lueckenlosen Daten, die Live-Karte kommt on top per LoRa. Notfall: per USB
  (`d` im seriellen Monitor, dann `scripts/upload-log.js`).
- Die Zeitmessung nutzt die GPS-Zeit. Live aus LoRa-Paketen kann um den Zieldurchgang ein Paket fehlen
  (Ergebnis zeigt `±` und Warnung); sobald das Hotspot-Upload das lueckenlose Log liefert, wird die Zeit exakt.
- Empfehlung fuer den ersten Test: zuerst `logger_tbeam` (Hotspot) auf einem Board pruefen, dann LoRa mit zwei Boards.

## Display (optional, SSD1306 OLED 128x64)

Funktioniert in allen drei Programmen (Logger, Tracker, Master). Ohne Display kostet es nichts.
1. **Hardware:** 0.96" I2C-OLED (SSD1306, Adresse 0x3C), 4 Pins VCC/GND/SDA/SCL. Am T-Beam V1.2 an den
   Display-Anschluss (SDA = GPIO21, SCL = GPIO22, gleicher Bus wie der Strom-Chip). Der Heltec V3 hat ein OLED onboard.
2. **Aktivieren:** in `platformio.ini` bei der Umgebung `; -DUSE_OLED` zu `-DUSE_OLED` machen (Semikolon weg).
3. **Anzeige:** Logger/Tracker: ID + UTC-Zeit, GPS-Fix + Satelliten, Speed + Akku, Log-Eintraege, Upload-Stand
   (`Up hochgeladen/gesamt` + Status wie "kein Hotspot"/"Upload..."), beim Tracker zusaetzlich LoRa-Sendezaehler.
   Master: RX-Zaehler, letzter Tracker mit RSSI, BLE-Status, Puffer.
4. **Strom sparen:** Das Display schaltet sich nach 60 s aus (`OLED_TIMEOUT_MS` in `config.h`, 0 = immer an) und geht
   mit der Taste am Board (T-Beam: GPIO38, Heltec: PRG) wieder an. Ohne Taste (`BUTTON_PIN -1`) bleibt es dauerhaft an.
5. Beim Eigenbau die Pins `OLED_SDA/OLED_SCL` und `BUTTON_PIN` im Abschnitt "Allgemeiner ESP32-S3" anpassen.

## Status-Ampel (optional, Modul mit 4 Pins: GND, Rot, Gelb, Gruen)

Funktioniert in Logger, Tracker und Master. Anschluss: GND an GND, die drei Farb-Pins an freie GPIOs. Die Pins stehen in
`include/config.h` (`LED_RED_PIN`, `LED_YELLOW_PIN`, `LED_GREEN_PIN`, `-1` = nicht vorhanden). **Die Standard-Pins sind
Vorschlaege: vor dem Einbau am Board pruefen, dass sie frei und herausgefuehrt sind.** Das Modul hat eingebaute
Widerstaende und laeuft direkt an 3.3 V. Hat dein Modul invertierte Logik, `-DLED_ACTIVE_LOW` in `build_flags` setzen.

Beim Einschalten kommt eine **Lampenprobe** (Rot, Gelb, Gruen nacheinander): so siehst du, ob alles stimmt.

**Im Betrieb (spart Strom, blinkt nur kurz):**

| Anzeige | Bedeutung |
|---|---|
| Gruen: kurzes Blinken alle 2 s | GPS-Fix da, Aufzeichnung laeuft - alles in Ordnung |
| Gelb: blinkt 1x pro Sekunde | Suche GPS **oder** Upload laeuft |
| Rot: blinkt 1x pro Sekunde | Fehler: Flash/LoRa-Init fehlgeschlagen oder mehr als 5 min kein GPS |
| Rot: sehr kurzes Blitzen jede Sekunde | Akku unter 15 % |

**Master:** Gruen = Handy per Bluetooth verbunden, Gelb blinkt = wartet auf Handy, Rot = LoRa-Init fehlgeschlagen.

**Taste** (am T-Beam: User-Taste GPIO38; am Heltec: PRG), nur Logger/Tracker:
- **Kurz druecken:** 10 s Dauer-Anzeige (Gruen = alles hochgeladen, Gelb = Daten warten noch, Rot = Fehler/Akku) und
  Upload sofort versuchen.
- **5 s halten:** Log loeschen - nur wenn alles hochgeladen ist (Gruen leuchtet 3 s). Sonst Rot 3 s und es passiert nichts.
- Eine Start-Taste braucht es nicht: Die Aufzeichnung laeuft automatisch, sobald das Geraet an ist und GPS-Fix hat.
  Der Start der Wettfahrt wird von der Wettfahrtleitung im System gesetzt.

"Alles hochgeladen" heisst: Der letzte Upload war erfolgreich und es fehlen hoechstens ca. 40 Eintraege (Sekunden).
Die Entscheidungslogik ist auf dem Rechner testbar:
`g++ -std=c++17 -I firmware/include firmware/test/test_ledlogic.cpp -o /tmp/t && /tmp/t`

---

# LoRa-Live (optional, spaeter)


```
Tracker (GPS + LoRa, auf jedem Boot) --LoRa 869.525 MHz--> Master-ESP32 (bei dir im Boot)
   --Bluetooth (BLE)--> dein Android-Handy (/gateway.html) --Internet--> Server
```

**Status (alle Firmware):** Der Code ist geschrieben, aber noch **nicht auf echter Hardware getestet und nicht kompiliert**
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
