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

### Kurs, Live-Rangliste, nachtraegliche Wettfahrten und Export

**Mehrere Kurse zur Auswahl:** Ein *Kurs* buendelt Linie, Bahnmarken und die Zaehllogik (Linie pro Runde `loop`/`bounce`,
Runden, minimale Rundenzeit, Zielschluss, Start in der Verlaengerung). In `/regatta.html`, Bereich 3, waehlst du den aktiven Kurs,
legst neue an (Rundkurs / hin und zurueck / Kopie des aktuellen), benennst und loeschst sie. Der Editor darunter bearbeitet immer den
aktiven Kurs. Beim Anlegen einer Wettfahrt waehlst du den Kurs; Runden, Zielschluss und Modus werden vorbelegt und die Wettfahrt
behaelt ihre eigene Kopie (spaetere Aenderungen am Kurs aendern bestehende Wettfahrten nicht). Vorinstalliert ist der Kurs
"Rundkurs, Linie in der Mitte (Boje 1 oben, Boje 2 unten)" - Koordinaten eintragen und testen.

**Kurs (Bahnmarken) und Linie eingeben** (`/regatta.html`, Bereich 3): Linie (A, B, Referenz) und Bojen einer Runde **in Fahrtreihenfolge**
lassen sich per **Koordinaten** eingeben, per Klick auf die Karte setzen oder als GPX/GeoJSON importieren (Strecken werden auf die
Eckpunkte vereinfacht). Koordinaten werden in den ueblichen Schreibweisen verstanden: `46.8419, 10.5130`, `46,8419; 10,5130`,
`N 46.8419 E 10.5130`, `46°50.514' N, 10°30.780' E`, `46°50'30.5"N 10°30'46.8"E` (ohne Buchstaben: Breite, Laenge wie bei Google Maps).
Mehrere Bojen koennen zeilenweise eingefuegt, verschoben und geloescht werden; ohne eigene Referenz-Tonne bestimmt die erste Boje die
Kursseite der Linie.

- **"Positionen sind exakt" (Standard bei eingegebenen Koordinaten):** Die Positionen werden genau so verwendet. Das System erkennt nur noch,
  wann welches Boot welche Boje rundet.
- **Ohne dieses Haekchen** gelten die Punkte als grobe Hinweise: Das System sucht die genauen Positionen selbst aus den Aufzeichnungen der Boote
  (pro Boot der Punkt mit der staerksten Kursaenderung in der Naehe, Median ueber alle Boote und Runden; auf der Karte blau). Die Punkte sollten dann
  unter ca. 100 m von der Boje entfernt und mindestens ca. 300 m voneinander entfernt sein; sonst bleibt die gezeichnete Position stehen.
  Aus einem Bild geschaetzte Positionen sind dafuer zu ungenau - besser echte Koordinaten oder eine GPX-Datei.
- **"Erkannte Bojen uebernehmen"** setzt die aus den Logs gefundenen Positionen als exakte Koordinaten (zum Nachpruefen und Korrigieren).

**Tor (zwei Marken):** Neben einzelnen Bojen kann der Kurs Tore enthalten (zwei Koordinaten A und B; in der Sammel-Eingabe `A | B`).
Gezaehlt wird die Durchfahrt: die erste Kreuzung der Verbindungslinie A-B von der Anfahrtsseite her (Seite des vorherigen Kurspunkts) zwischen
den Marken, mit 15 m Toleranz fuer GPS-Fehler. Fuer den Fortschritt gilt die Mitte des Tores; Tore werden nie aus den Logs verschoben.
Der Kurs steht **einmal** fuer eine Runde; die Wettfahrt faehrt ihn so oft ab, wie Runden eingestellt sind (Standard 2).

**Wichtig - Start, Ziel und Runden haengen nur an der Linie**, nicht an den Bojen: Die offizielle Zeit (Start, Ende der letzten Runde) wird
ausschliesslich aus den Durchgaengen durch die Start-/Ziellinie bestimmt. Bojen und Tore beeinflussen nur die Live-Rangliste (Schaetzung);
eine nicht erkannte Boje aendert das Ergebnis nicht. Wie die Linie pro Runde gezaehlt wird, stellst du pro Wettfahrt ein. **Start und Ziel zaehlen nur, wenn das Boot zwischen Zielboot und
Zielboje durchfaehrt** (3 m Toleranz fuer GPS-Fehler); sonst zaehlt der Durchgang nicht, und im Ergebnis steht eine Warnung mit Runde und Abstand.
- **Immer in dieselbe Richtung (Rundkurs, Standard):** Die Boote fahren in jeder Runde durch die Linie Richtung Boje 1 und kommen von Boje 1
  ueber die Seite (ausserhalb der Marken) zu Boje 2 und von dort wieder zur Linie. Der erste Durchgang ist der Start, jeder weitere beendet eine
  Runde, der letzte (bei 2 Runden der 3.) ist das Ziel. Die Referenz-Tonne der Linie muss auf der Seite von Boje 1 liegen.
  **Runden-Anzeiger:** Der Abstieg ausserhalb der Marken (Kreuzen der Verlaengerung der Linie) zeigt, auf welcher Runde das Boot ist. Folgen zwei
  solche Abstiege ohne gueltigen Durchgang dazwischen, fehlt ein Durchgang zwischen den Marken: Die Live-Rangliste nutzt dann die Runde aus den
  Abstiegen (mit Warnzeichen), und im Ergebnis steht eine Warnung.
- **Hin und zurueck (gegenlaeufig):** Start = Durchgang auf die Kursseite, Ende der Runde = Durchgang zurueck.
- Optional pro Wettfahrt: **"Erster Start darf in der Verlaengerung der Linie liegen"** (bis ca. 400 m hinter den Marken; nur der erste Start,
  nie ein weiterer Start oder das Ziel).
- GPS-Zittern direkt nach einem Durchgang zaehlt nicht (Mindestrundenzeit). Einzelne Zeiten und Status lassen sich im Ergebnis von Hand korrigieren.

Der Kurs wird beim Anlegen/Starten einer Wettfahrt in diese kopiert; fuer bestehende Wettfahrten "Linie & Kurs aktuell uebernehmen".

**Live-Rangliste** (`/live.html`, aktualisiert sich alle 5 s): Fortschritt = Strecke entlang Linie -> Bojen -> Linie (je Runde).
Rang nach geschaetzter berechneter Zeit = (verstrichene Zeit x Gesamtstrecke / Fortschritt) x 100 / Yardstick; nach dem Ziel zaehlt die
gemessene Zeit. Rueckstand (korrigiert) bezieht sich auf das Boot mit der besten berechneten Zeit, "Abstand" auf das vorderste Boot
(groesster Fortschritt). Das ist eine **Schaetzung** (nimmt konstantes Tempo an; Kreuzen/Vorwind schwanken) und erst nach ca. 3 % der
Strecke bzw. 60 s sinnvoll. Offiziell ist nur das freigegebene Ergebnis.

**Nachtraeglich eine Wettfahrt eintragen**: Bereich 4 "Wettfahrt anlegen" mit **Startzeit** (auch in der Vergangenheit) und Zielschluss
(Minuten nach dem Start; Durchgaenge danach zaehlen nicht - wichtig, wenn mehrere Laeufe in derselben Aufzeichnung stehen). Die
Wettfahrt wird sofort aus den gespeicherten Positionen ausgewertet. Aenderungen an Runden/Zielschluss/Boote/Yardstick rechnen alles neu.
Bereich 5 zeigt, fuer welche Zeitraeume Aufzeichnungen vorhanden sind.

**Export**: Positionen als CSV (Excel, ';') oder GPX (Karten-Apps) - ganze Historie, Zeitfenster (Von/Bis) oder eine Wettfahrt
(Links in der Wettfahrt-Karte, inkl. Linie und Bojen als Wegpunkte). API (Admin): `/api/admin/export/tracks.csv|gpx?race=ID` oder
`?from=...&to=...&trackers=id1,id2` (Zeit als ms oder ISO).

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

### Cloudflare-Tunnel einrichten (Beispiel: `regattazeit.ch`, App direkt unter `https://regattazeit.ch`)

1. **Domain zu Cloudflare:** Auf cloudflare.com kostenlosen Account anlegen -> *Add a domain* -> `regattazeit.ch` -> Tarif
   *Free*. Cloudflare nennt zwei Nameserver. Diese beim Registrar der Domain eintragen (Nameserver ersetzen).
   Ist beim Registrar **DNSSEC** aktiv, vorher abschalten (sonst ist die Domain nach der Umstellung nicht erreichbar).
   Warten, bis Cloudflare "Active" anzeigt (Minuten bis wenige Stunden).
2. **Tunnel anlegen:** Cloudflare-Dashboard -> *Zero Trust* -> *Networks* -> *Tunnels* -> *Create a tunnel* -> Typ
   *Cloudflared* -> Name `regatta-nas` -> Umgebung *Docker* -> den **Token** aus dem angezeigten Befehl kopieren
   (der lange Text nach `--token`).
3. **Public Hostname** im Tunnel hinzufuegen: Subdomain leer (Hauptadresse) oder z.B. `live`, Domain `regattazeit.ch`, Service Typ `HTTP`,
   URL `regatta-tracker:3000` (Name des Containers im selben Compose-Projekt).
4. In `.env` auf dem NAS: `CLOUDFLARE_TUNNEL_TOKEN=<Token>`, dann `docker compose --profile tunnel up -d`
   (Synology Container Manager: Projekt neu bauen/starten; das Profil `tunnel` aktivieren bzw. den Service
   `cloudflared` im Projekt starten).
5. Test mit dem Handy ueber Mobilfunk: `https://regattazeit.ch`. Admin: `https://regattazeit.ch/admin.html`.
6. Firmware: `SERVER_URL "https://regattazeit.ch"`. Root-Zertifikate fuer `SERVER_CA_PEM`: vorher mit
   `openssl s_client -connect regattazeit.ch:443 -showcerts </dev/null` die aktuelle Kette ansehen und mehrere
   Roots hintereinander einfuegen (mindestens ISRG Root X1, ISRG Root X2, GTS Root R1, GTS Root R4), weil Cloudflare
   die Zertifizierungsstelle wechseln kann.
7. Cloudflare -> *SSL/TLS* -> Modus *Full* belassen; *Always Use HTTPS* einschalten. **Keine** Access-Anmeldung auf `/api/*`.

Hinweise zum Tunnel:
- **Keine Cloudflare-Access-Login-Pflicht auf `/api/*`** legen: Handys und ESP32-Geraete koennen sich dort nicht einloggen.
  Der Admin-Bereich ist ueber das `ADMIN_TOKEN` geschuetzt; zusaetzlicher Zugriffsschutz nur fuer `/admin.html` und
  `/regatta.html` ist moeglich, aber der Gateway/Tracker brauchen `/api/*` offen.
- WebSocket (Live-Karte) funktioniert durch den Tunnel.
- **ESP32 und TLS-Zertifikat:** Cloudflare wechselt gelegentlich die Zertifizierungsstelle. In `secrets.h` bei
  `SERVER_CA_PEM` darum mehrere Root-Zertifikate hintereinander einfuegen (z.B. ISRG Root X1 *und* Google Trust
  Services GTS Root R1), oder vorab mit `openssl s_client -connect <domain>:443 -showcerts` pruefen, welche Kette aktuell ist.
- Ohne eigene Domain gibt es nur temporaere Quick-Tunnel-Adressen (aendern sich) - fuer Geraete ungeeignet.

### Synology-Anleitung (DSM 7.2+, ohne eigene Domain: `*.synology.me`)

Voraussetzung: Dein Internetanschluss hat eine **oeffentliche IPv4-Adresse** (Test: WAN-IP im Router = die IP, die
eine "Wie ist meine IP"-Seite anzeigt, und nicht im Bereich 100.64.x.x - sonst CGNAT, dann Cloudflare Tunnel s.o.).

**1. App starten**
1. Paketzentrum -> **Container Manager** installieren.
2. Repo als ZIP laden, mit File Station nach z.B. `/docker/regatta-tracker` kopieren (Ordner enthaelt `docker-compose.yml`).
3. In diesem Ordner eine Datei `.env` anlegen (Vorlage `.env.example`), mindestens `ADMIN_TOKEN=<langer Zufallswert>`
   und `GATEWAY_TOKEN=<langer Zufallswert>`.
4. Container Manager -> **Projekt** -> Erstellen -> Pfad dieses Ordners waehlen -> Bauen/Starten.
   Test im LAN: `http://<nas-ip>:3000`.

**2. Adresse + Zertifikat**
1. Systemsteuerung -> Externer Zugriff -> **DDNS** -> Hinzufuegen: Anbieter *Synology*, Hostname z.B. `meine-regatta`
   (ergibt `meine-regatta.synology.me`).
2. Router: **Port 443** (und fuer die Zertifikatsausstellung kurz **Port 80**) auf die NAS-IP weiterleiten.
   Den DSM-Port 5001 **nicht** weiterleiten.
3. Systemsteuerung -> Sicherheit -> **Zertifikat** -> Hinzufuegen -> *Zertifikat von Let's Encrypt holen* fuer den Hostnamen.

**3. Reverse Proxy**
1. Systemsteuerung -> Anmeldeportal -> Erweitert -> **Reverse-Proxy** -> Erstellen.
2. Quelle: Protokoll HTTPS, Hostname `meine-regatta.synology.me`, Port 443. Ziel: HTTP, `localhost`, Port 3000.
3. Reiter *Benutzerdefinierte Kopfzeile* -> Erstellen -> **WebSocket** (ohne das bleibt die Live-Karte leer).
4. Systemsteuerung -> Sicherheit -> Zertifikat -> Einstellungen: dem Reverse-Proxy-Eintrag das Let's-Encrypt-Zertifikat zuweisen.
5. Test von aussen (Handy mit Mobilfunk, nicht im WLAN): `https://meine-regatta.synology.me`.

**4. Geraete eintragen**
- In `firmware/include/secrets.h`: `SERVER_URL "https://meine-regatta.synology.me"` und als `SERVER_CA_PEM`
  das Root-Zertifikat **ISRG Root X1** (`curl -O https://letsencrypt.org/certs/isrgrootx1.pem`).
- Handy-Gateway: `https://meine-regatta.synology.me/gateway.html`, Tracker-/Admin-Seiten genauso.

**5. Betrieb**
- `data/` in Hyper Backup aufnehmen. Update: neuen Code in den Ordner kopieren, im Container Manager das Projekt neu bauen.
- DSM: Zwei-Faktor-Anmeldung aktivieren, Auto-Block einschalten, automatische DSM-Updates aktiv lassen - das NAS ist jetzt
  (nur ueber den Reverse-Proxy) aus dem Internet erreichbar.
- Die Regatta-App hat bewusst keine Benutzerverwaltung: Admin ist per `ADMIN_TOKEN` geschuetzt, die Live-Karte ist oeffentlich.

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

- **Login fuer Zuschauer:** Ist `VIEWER_PASSWORD` gesetzt, sind Live-Karte (`/`), Ergebnisse und deren Daten
  (`/api/trackers`, `/api/regatta`, `/api/races/...`, WebSocket) nur nach Anmeldung auf `/login.html` erreichbar. Das
  Passwort gibst du an die Zuschauer weiter (z.B. als QR-Code am See). Die Anmeldung gilt 14 Tage (signiertes,
  HttpOnly-Cookie ohne Passwort darin). Das Admin-Token meldet ebenfalls an (mit Admin-Rechten). Ohne `VIEWER_PASSWORD`
  bleibt alles oeffentlich wie bisher. Die Geraete sind davon **nicht** betroffen: Tracker-Upload, Gateway und die
  Tracker-Seite im Handy laufen weiter mit ihren eigenen Tokens. Falsche Passwoerter zaehlen fuer die Sperre unten.
- **Sperre bei Fehlversuchen:** Nach 8 falschen Tokens (Admin, Gateway, Tracker) innerhalb von 15 Minuten wird die
  absendende IP 15 Minuten gesperrt (HTTP 429; hinter dem Cloudflare Tunnel zaehlt die echte Besucher-IP aus
  `CF-Connecting-IP`). Einstellbar mit `AUTH_MAX_FAILURES` und `AUTH_BLOCK_MINUTES`. Die oeffentliche Live-Karte ist
  nie betroffen. Ein Neustart des Containers hebt Sperren auf.
- **Viele Zuschauer:** Live-Updates enthalten nur die letzte Position (ca. 200 Byte), die Spur wird beim Laden ausgeduennt
  (`PUBLIC_TRAIL_POINTS`, Standard 150) und vom Browser selbst fortgeschrieben; alle 15 s kommt nur eine kleine Statusmeldung.
  Gemessen: 100 gleichzeitige Zuschauer bei 10 Trackern mit je 1 Update/s ergeben ca. 1.6 Mbit/s Upload am NAS.
- Tokens werden nur noch im Header akzeptiert (nicht in der URL), Vergleich zeitkonstant; Antworten enthalten
  Schutz-Header (`X-Frame-Options`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`).
- Das Admin-Token wird im Browser (localStorage) gespeichert: auf geteilten Rechnern nach Gebrauch abmelden bzw. den
  Browser-Speicher leeren.
- Der Admin-Bereich ist nur ueber das `ADMIN_TOKEN` geschuetzt - unbedingt ein langes, zufaelliges
  Token setzen und nicht committen (`.env` ist in `.gitignore`).
- Jeder Tracker hat sein eigenes Secret-Token im Link/QR-Code - wer den Link nicht hat, kann keine
  Fake-Positionen fuer dieses Boot senden.
- Die Live-Karte (`/`) selbst ist bewusst oeffentlich/ohne Login, da sie fuer Zuschauer gedacht ist.
  Falls das nicht gewuenscht ist, z.B. per Reverse-Proxy mit Basic-Auth davorschalten.
