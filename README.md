# Roemis Regatta Tracker

Selbst gehosteter Live-Positions-Tracker fuer Regatten. Zeigt beliebig viele Boote gleichzeitig
live auf einer Karte an. Jeder "Tracker" ist einfach ein Smartphone im Boot mit einer Web-Seite
offen (kein App-Store, kein Loeten noetig) - Hardware-Tracker (ESP32 etc.) koennen spaeter
genauso an dieselbe API angebunden werden (siehe unten).

## Architektur

```
Handy im Boot (Browser/PWA)  --HTTPS POST alle ~5s-->  Server (Node.js)  --WebSocket-->  Live-Karte (Browser)
```

- **Server** (`server/`): Express + WebSocket. Speichert Tracker + Positionen als einfache
  JSON-Dateien unter `data/` (keine Datenbank noetig).
- **Live-Karte** (`public/index.html`): Leaflet-Karte, zeigt alle Tracker live inkl. Spur (Track)
  und Alter der letzten Meldung. Aktualisiert sich per WebSocket automatisch.
- **Tracker-Seite** (`public/tracker.html`, erreichbar unter `/t/<id>?token=<token>`): Mini-PWA,
  die per `navigator.geolocation.watchPosition` die Position holt und alle 5 Sekunden an den
  Server sendet. Ein Start/Stop-Knopf, Status-Anzeige, haelt den Bildschirm wach (Wake Lock),
  installierbar auf dem Homescreen.
- **Admin** (`public/admin.html`): Neue Tracker anlegen (erzeugt eindeutige ID + Secret-Token),
  Link/QR-Code zum Teilen an den Skipper, Tracker umbenennen/loeschen, Spur zuruecksetzen.

Neue Boote hinzufuegen heisst nur: im Admin-Bereich einen Tracker anlegen und den QR-Code an das
Handy im Boot schicken - keine Server-Konfiguration noetig, beliebig skalierbar.

## Schnellstart (lokal, mit Docker)

```bash
cp .env.example .env
# .env oeffnen und ADMIN_TOKEN auf ein eigenes, langes Passwort setzen

docker compose up -d --build
```

Danach:

- Live-Karte: http://localhost:3000/
- Admin-Bereich: http://localhost:3000/admin.html (Login mit dem `ADMIN_TOKEN` aus der `.env`)

Ohne Docker geht es genauso mit reinem Node.js (>= 18):

```bash
npm install
ADMIN_TOKEN=mein-geheimes-token npm start
```

## Einen Tracker anlegen und benutzen

1. Im Admin-Bereich Namen eingeben (z.B. Bootsname/Segelnummer) -> "Tracker anlegen".
2. QR-Code mit dem Handy scannen, das im Boot mitfaehrt (oder Link per Nachricht schicken).
3. Auf dem Handy oeffnet sich die Tracker-Seite. Standortzugriff erlauben, "Start" druecken.
4. Idealerweise die Seite per "Zum Home-Bildschirm hinzufuegen" installieren (PWA) und das Handy
   waehrend des Rennens eingeschaltet/im Boot befestigt lassen. GPS + mobile Daten muessen aktiv
   sein, da die Position ueber das Internet an den Server gesendet wird.
5. Auf der Live-Karte (`/`) erscheint das Boot automatisch, sobald die erste Position eintrifft.

## Zeitmessung und Yardstick-Auswertung

Seiten: **Wettfahrtleitung** `/regatta.html` (Admin-Login wie `/admin.html`), oeffentliche Ergebnisse `/results.html`.

Ablauf:

1. **Yardstick-Liste** einlesen (Text/CSV, eine Klasse pro Zeile `Name;Zahl`) oder Klassen einzeln anlegen.
2. **Boote registrieren:** Segelnummer, Steuermann, Klasse - durch die Wettfahrtleitung oder vom Skipper selbst
   auf seiner Tracker-Seite ("Boot registrieren").
3. **Start-/Ziellinie** setzen (Start = Ziel): Punkt A/B per Kartenklick oder per Tracker-Position
   (z.B. Startschiff + Pin-Boot) plus Referenz-Tonne (Luv-Tonne), die die Kursseite festlegt.
4. **Wettfahrt anlegen** (Rundenzahl, Standard 2) und **Startsignal** setzen ("JETZT" oder sekundengenau).
5. Ergebnis erscheint laufend, ist **vorlaeufig**, bis die Wettfahrtleitung es **offiziell freigibt** (dann gesperrt).

Berechnung:

- Gruppenstart: gesegelte Zeit = Zieldurchgang - Startsignal. Ein Boot startet mit dem Durchqueren der Linie
  Richtung Kursseite; jede Rueckkehr durch die Linie zaehlt eine Runde, die letzte ist das Ziel.
- Durchgangszeit = lineare Interpolation zwischen den zwei GPS-Fixes beidseits der Linie. Zeitstempel sind
  GPS-Zeit (nicht die Handy-Uhr). Typische Genauigkeit bei 2s-Takt: unter 1-2 s; ausgewiesen als `±`.
- Berechnete Zeit = gesegelte Zeit * 100 / Yardstick, Rang nach auf ganze Sekunden gerundeter Zeit
  (gleiche Zeit = gleicher Rang).
- Wettfahrtleitung kann pro Boot korrigieren: Status (DNS/DNF/DSQ/OCS/RET/DNC), Zielzeit manuell,
  Zeitstrafe (Sekunden auf die berechnete Zeit), Bemerkung. Auffaelligkeiten (OCS-Verdacht, GPS-Luecke am
  Ziel, ignoriertes GPS-Zittern) werden als Warnung angezeigt.
- Das Handy zeichnet alle 2 s auf und puffert bei Funkloch (bis ~3 h), Nachsenden ist korrekt zeitgestempelt.
  Der Server speichert alle Fixes dauerhaft in `data/history/<tracker>.jsonl` (unabhaengig von der Karten-Spur).
- Export: CSV pro Wettfahrt.

Tests der Rechenlogik: `npm test`.

## Damit das auch auf dem Wasser funktioniert (wichtig!)

Der Server muss aus dem Mobilfunknetz heraus erreichbar sein, sonst kommen keine Positionen an.
Optionen, sortiert nach Aufwand:

- **Am einfachsten:** Server auf einem echten VPS/Server mit eigener Domain + HTTPS betreiben
  (z.B. per Reverse Proxy wie Caddy/Traefik/nginx vor diesem Container). `docker-compose.yml`
  bleibt gleich, nur Port 3000 hinter den Proxy haengen.
- **Ohne eigenen Server im Internet:** Ein Tool wie [Tailscale](https://tailscale.com) oder
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  auf dem Raspberry Pi/Rechner installieren, der die App hostet - macht sie ohne Portfreigabe von
  ueberall erreichbar.
- Rein lokal im Vereinsheim-WLAN reicht es auch, wenn alle Boote in WLAN-Reichweite bleiben
  (z.B. Uebungsregatta auf einem See mit Hotspot am Ufer).

Fuer HTTPS: `navigator.geolocation` und Wake Lock funktionieren im mobilen Chrome/Safari nur
zuverlaessig ueber **https://** (oder `http://localhost`). Ein Reverse Proxy mit Let's Encrypt
(z.B. Caddy - macht das automatisch) wird daher fuer den echten Einsatz empfohlen.

## Betrieb auf dem NAS (Docker) + Cloudflare Tunnel

Die App laeuft als Docker-Container (Synology "Container Manager", QNAP "Container Station", Unraid/TrueNAS usw.).

1. Repo auf das NAS holen (`git clone`) oder Ordner kopieren, `cp .env.example .env`, `ADMIN_TOKEN` (und
   `GATEWAY_TOKEN`) auf lange Zufallswerte setzen.
2. `docker compose up -d --build` - die App ist im LAN unter `http://<nas-ip>:3000` erreichbar.
3. Daten liegen in `./data` (Tracker, Wettfahrten, volle Positions-Historie) - **diesen Ordner ins NAS-Backup aufnehmen**.
4. Von aussen: HTTPS ist Pflicht (Handy-GPS, Web Bluetooth und der ESP32-Upload brauchen es). Am einfachsten per
   Cloudflare Tunnel, ohne Portfreigabe und auch hinter CGNAT: Domain bei Cloudflare, Tunnel im Zero-Trust-Dashboard
   anlegen, Ziel `http://regatta-tracker:3000`, Token als `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, dann
   `docker compose --profile tunnel up -d`.

Hinweise zum Tunnel:
- **Keine Cloudflare-Access-Login-Pflicht auf `/api/*`** legen: Handys und ESP32-Geraete koennen sich dort nicht einloggen.
  Der Admin-Bereich ist ueber das `ADMIN_TOKEN` geschuetzt; zusaetzlicher Zugriffsschutz nur fuer `/admin.html` und
  `/regatta.html` ist moeglich, aber der Gateway/Tracker brauchen `/api/*` offen.
- WebSocket (Live-Karte) funktioniert durch den Tunnel.
- **ESP32 und TLS-Zertifikat:** Cloudflare wechselt gelegentlich die Zertifizierungsstelle. In `secrets.h` bei
  `SERVER_CA_PEM` darum mehrere Root-Zertifikate hintereinander einfuegen (z.B. ISRG Root X1 *und* Google Trust
  Services GTS Root R1), oder vorab mit `openssl s_client -connect <domain>:443 -showcerts` pruefen, welche Kette aktuell ist.
- Ohne eigene Domain gibt es nur temporaere Quick-Tunnel-Adressen (aendern sich) - fuer Geraete ungeeignet.

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Beschreibung |
|---|---|---|
| `ADMIN_TOKEN` | - (Pflicht) | Passwort fuer den Admin-Bereich |
| `PORT` | `3000` | HTTP-Port |
| `STALE_AFTER_SECONDS` | `90` | Ab wann ein Tracker als "offline" markiert wird |
| `MAX_TRAIL_POINTS` | `1000` | Wie viele Punkte Spur pro Tracker auf der Karte gehalten werden (Zeitmessung nutzt die volle Historie) |
| `DATA_DIR` | `./data` | Ordner fuer die JSON-Datenablage |

## Hardware: Logger mit Hotspot-Upload (Start-Variante)

Guenstigste Variante: ESP32 + GPS + Akku pro Boot, kein LoRa. Das Geraet zeichnet jede Sekunde Position und
GPS-Zeit auf und laedt das Log ueber den Hotspot des Master-Handys hoch, sobald es in Reichweite ist. Anleitung:
[`firmware/README.md`](firmware/README.md). LoRa fuer die Live-Karte kann spaeter nachgeruestet werden.

## LoRa-Funk-Tracker (ESP32) + Master-Handy (optional, spaeter)

Fuer ~20 Boote ohne Handy im Boot: Funk-Tracker (ESP32 + GPS + LoRa) senden an einen Master-ESP32 in deinem Boot,
dein Android-Handy holt die Daten per Bluetooth (`/gateway.html`) und leitet sie an den Server weiter. Firmware,
Hardwareliste, Verdrahtung und Ablauf: siehe [`firmware/README.md`](firmware/README.md). Server-Endpunkt:
`POST /api/gateway/positions` (Header `x-gateway-token`, optional `GATEWAY_TOKEN` in `.env`).

## Guenstige DIY-Hardware-Tracker statt Smartphone

Die Server-API ist bewusst simpel gehalten (ein HTTP-POST mit Bearer-Token), damit spaeter auch
eigene Mini-Hardware-Tracker angebunden werden koennen, ohne den Server zu aendern:

```
POST /api/trackers/<id>/position
Authorization: Bearer <token>
Content-Type: application/json

{ "lat": 47.123, "lon": 8.456, "speed": 3.1, "heading": 210, "battery": 0.82 }
```

Guenstige Optionen fuer spaeter (grob nach Aufwand/Preis):

1. **ESP32 + GPS-Modul (z.B. NEO-6M) + WLAN** (~10-15 EUR/Stueck): sendet per WLAN direkt an
   diesen Server. Braucht WLAN-Empfang am Kurs (z.B. Hotspot auf einem Begleitboot).
2. **ESP32 + GPS + LoRa** (~15-20 EUR/Tracker + einmalig ~15 EUR fuer eine LoRa-Basisstation am
   Ufer): groessere Reichweite auf offenem Wasser (oft mehrere km), keine laufenden Kosten, die
   Basisstation leitet die Daten dann per WLAN/LAN an diesen Server weiter.
3. **ESP32 + GPS + Mobilfunk-Modul (SIM800L/A7670)** (~20-25 EUR/Tracker + SIM-Karte mit
   Datenvolumen): funktioniert ueberall mit Mobilfunknetz, unabhaengig von WLAN-Reichweite.

Jede dieser Varianten muss letztlich nur regelmaessig obigen HTTP-POST absetzen - der Rest der
App (Karte, Admin, Speicherung) bleibt unveraendert.

## Sicherheit

- Der Admin-Bereich ist nur ueber das `ADMIN_TOKEN` geschuetzt - unbedingt ein langes, zufaelliges
  Token setzen und nicht committen (`.env` ist in `.gitignore`).
- Jeder Tracker hat sein eigenes Secret-Token im Link/QR-Code - wer den Link nicht hat, kann keine
  Fake-Positionen fuer dieses Boot senden.
- Die Live-Karte (`/`) selbst ist bewusst oeffentlich/ohne Login, da sie fuer Zuschauer gedacht ist.
  Falls das nicht gewuenscht ist, z.B. per Reverse-Proxy mit Basic-Auth davorschalten.
