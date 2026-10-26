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

**Tipp fuer spaeteres LoRa:** Lass die SPI-Pins (`LORA_*` in config.h) am ESP32 frei, oder nimm gleich ein
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
