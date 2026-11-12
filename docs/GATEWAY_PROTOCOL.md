# Gateway-Protokoll fuer eine Android-App (Master -> Handy -> Server)

Die App ist nur das Bindeglied: Sie verbindet sich per Bluetooth LE mit dem Master-T-Beam, empfaengt die Funkpakete der
Tracker und reicht sie an den Server weiter. Referenzimplementierung (Browser, Web-Bluetooth): `public/gateway.html` und
`public/js/gateway.js`, Paketdekodierung `public/js/lora-packet.js` (getestet in `test/lora.test.js`).

## 1. Bluetooth LE (Master)

| | |
|---|---|
| Geraetename | `RegattaMaster` |
| Service-UUID | `a7d0c001-5e1b-4f6a-9a53-2d4f7b6c9e10` |
| Characteristic (Notify) | `a7d0c002-5e1b-4f6a-9a53-2d4f7b6c9e10` |

Notifications abonnieren. Jede Notification ist **ein Paket mit 24 Byte, Little-Endian**:

| Offset | Typ | Inhalt |
|---|---|---|
| 0 | u8 | magic `0xA7` (sonst verwerfen) |
| 1 | u8 | LoRa-Nr des Trackers (1..250) |
| 2 | u32 | GPS-Zeit UTC, Sekunden seit 1970 |
| 6 | u8 | Hundertstelsekunden 0..99 |
| 7 | i32 | Breite in 1e-6 Grad |
| 11 | i32 | Laenge in 1e-6 Grad |
| 15 | u16 | Geschwindigkeit in cm/s |
| 17 | u16 | Kurs in 0.1 Grad, `0xFFFF` = unbekannt |
| 19 | u8 | Akku in %, 255 = unbekannt |
| 20 | u8 | HDOP*10, 255 = unbekannt |
| 21 | i16 | RSSI in dBm |
| 23 | i8 | SNR*4 in dB |

**Lebenszeichen ohne GPS-Fix:** Hat ein Tracker keinen Fix, sendet er trotzdem etwa alle 10 s ein Paket mit Breite = Laenge =
`-2147483648` (INT32_MIN) und GPS-Zeit 0. Akku (Byte 19) sowie RSSI/SNR sind gueltig. Die App darf diese Pakete nicht als Position
behandeln (nicht als 0/0 anzeigen), sondern leitet sie als Status weiter (siehe unten).

Umrechnung: `ts_ms = epochSec*1000 + centisec*10`, `lat = i32/1e6`, `lon = i32/1e6`, `speed_ms = cms/100`,
`heading = deg10/10` (oder null), `battery = pct/100` (oder null). Pakete mit `|lat|>90` oder `|lon|>180` verwerfen.
Die Zeit kommt vom GPS des Trackers. Sie ist die Grundlage der offiziellen Zeitmessung: **nicht durch die Handy-Zeit ersetzen.**
Pakete nie verlieren: erst in eine lokale Warteschlange (dauerhaft gespeichert) legen, dann senden.

## 2. Server (HTTPS)

```
POST https://regattazeit.ch/api/gateway/positions
x-gateway-token: <Gateway-Token>          (alternativ x-admin-token: <Admin-Token>)
Content-Type: application/json

{ "positions": [
  { "id": 2, "ts": 1790000000000, "lat": 46.84, "lon": 10.51, "speed": 3.1, "heading": 90, "battery": 0.82 }
] }
```

- Lebenszeichen ohne Fix: `{ "id": 2, "fix": false, "seenTs": <Empfangszeit des Handys in ms>, "battery": 0.82, "rssi": -90, "snr": 6.5 }`.
  Der Server laesst die Position unveraendert (eine fruehere bleibt stehen, ohne fruehere wird keine angezeigt, nichts kommt in die
  Historie) und merkt sich nur Status (Akku, Empfang, zuletzt gehoert). Die Antwort enthaelt dann `heartbeats` statt `accepted`.
- `id` = LoRa-Nr aus dem Paket. Sie muss im Admin einem Tracker zugewiesen sein, sonst steht sie in der Antwort unter `unknown`.
- Statt `id` kann `trackerId` (Tracker-ID aus dem Admin) gesendet werden, z.B. fuer die eigene Handy-GPS-Position.
- Optionale Felder: `speed` (m/s), `heading` (Grad), `battery` (0..1), `accuracy` (m), alles sonst weglassen oder `null`.
- Bis zu 2000 Positionen pro Aufruf (die Referenz sendet alle 4 s Pakete von bis zu 500). Antwort: `{ "ok": true, "accepted": n, "unknown": [] }`.
- Bei Fehler (kein Netz, 5xx) die Warteschlange behalten und spaeter erneut senden. Doppelte Zeitstempel sind unkritisch.
- Bei 401 ist das Token falsch. Zu viele falsche Versuche sperren die IP voruebergehend, also nicht in einer Schleife wiederholen.
- Die Tokens gehoeren in den verschluesselten App-Speicher, nie in den Quelltext oder ins Git.

## 3. Hinweise

- Ausfallsicherheit: Der Hotspot-Upload der Tracker (Flash-Log) liefert nachtraeglich die lueckenlosen Daten.
- Bildschirm/Hintergrund: eine native App sollte als Foreground-Service laufen, damit Android die BLE-Verbindung nicht trennt.
- Die Segeluhr-App kann ausserdem als eigener Tracker senden (`POST /api/trackers/<id>/position`, siehe README) und ihre Konfiguration unter
  `/api/trackers/<id>/config` ablegen.

## 4. Versionierung

Aktuelle API-Version: 1.0

Der Server nennt sie unter `GET /api/version` (ohne Login): `{ "api": 1, "minor": 0, "name": "roemis-regatta-tracker" }`
und in jeder `/api/*`-Antwort im Header `X-API-Version: 1.0`.

- **api (major)** steigt nur bei inkompatiblen Aenderungen (Feld/Endpunkt entfernt oder umgedeutet). Clients mit anderer Major-Version
  sollen **nicht senden**, sondern den Nutzer warnen.
- **minor** steigt bei rueckwaertskompatiblen Ergaenzungen (neue optionale Felder/Endpunkte). Ein Client darf einen hoeheren Minor-Wert
  des Servers ignorieren; ein Server mit niedrigerem Minor als vom Client benoetigt -> Client warnt, nutzt nur die alten Felder.
- Das Funkpaket (Abschnitt 1) hat sein eigenes Format (`magic 0xA7`, 21/24 Byte) und aendert sich nur zusammen mit
  `firmware/include/protocol.h` und `public/js/lora-packet.js`.

### Aenderungsverlauf

| Version | Aenderung |
|---|---|
| 1.0 | Ausgangsstand: `/api/trackers/<id>/position(s)`, `/api/trackers/<id>/config`, `/api/gateway/positions`, `/api/version` |
