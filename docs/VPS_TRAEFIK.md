# Betrieb auf dem VPS hinter Traefik (statt NAS + Cloudflare-Tunnel)

Stand 27.11.2026. Der VPS (Hostinger KVM 2, Ubuntu 24.04, Docker + Compose) hat schon einen **Traefik** (Host-Netz, Ports 80/443, Certresolver `letsencrypt`
mit HTTP-Challenge, `exposedbydefault=false`). Der Regatta-Tracker wird dort als eigenes Compose-Projekt in `/opt/regatta-tracker` betrieben und bekommt
nur Labels. Traefik und die bestehende Anwendung (Probennahmejournal) bleiben unberuehrt. Kein Cloudflare-Tunnel, kein eigener Zertifikats-Aufwand.

## Einmalig vorbereiten

1. **DNS** (Cloudflare, Zone `regattazeit.ch`): Den bisherigen Tunnel-Eintrag fuer `regattazeit.ch` entfernen (Zero Trust -> Networks -> Tunnels -> Public Hostname
   loeschen, danach den CNAME in DNS). Dann einen **A-Eintrag** `regattazeit.ch` -> `2.24.158.210` anlegen, **graue Wolke (nur DNS)**, damit Traefik das Zertifikat per
   HTTP-Challenge holen kann.
2. **Projekt auf den VPS** (als root):
   ```
   git clone https://github.com/Boognsiher/Roemis-Regatta-Tracker.git /opt/regatta-tracker
   cd /opt/regatta-tracker && git checkout claude/diy-position-tracker-km1g1v
   ```
3. **`.env`** (aus dem NAS uebernehmen, siehe unten; Inhalt nie im Chat posten) und folgende Zeilen ergaenzen bzw. setzen:
   ```
   COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml
   REGATTA_DOMAIN=regattazeit.ch
   VPS_PORT=3012
   ```
   `CLOUDFLARE_TUNNEL_TOKEN` wird nicht mehr gebraucht. Der Port 3012 ist frei (3011 gehoert dem Probennahmejournal); er ist nur an `127.0.0.1` gebunden.

## Daten vom NAS umziehen (Reihenfolge wichtig)

Zwei Tunnel-Verbindungen gleichzeitig wuerden Besucher mal auf das NAS, mal auf den VPS schicken. Deshalb zuerst das NAS stoppen:

1. Auf dem NAS im Projektordner: `sudo docker compose --profile tunnel down`, dann `sudo tar czf /tmp/regatta-data.tgz data .env`.
2. Datei auf den VPS kopieren (`scp`), dort in `/opt/regatta-tracker` entpacken: `tar xzf regatta-data.tgz` (legt `data/` und `.env` an, danach die drei Zeilen oben in der `.env` ergaenzen).
3. DNS umstellen (siehe oben), dann starten: `cd /opt/regatta-tracker && docker compose up -d --build`.
4. Pruefen: `curl -s http://127.0.0.1:3012/healthz`, dann `https://regattazeit.ch` im Browser (das Zertifikat holt Traefik beim ersten Aufruf; kurz warten). Von aussen
   duerfen nur 22/80/443 offen sein.
5. Erst wenn alles laeuft: auf dem NAS `sudo docker compose --profile tunnel down --rmi all` und den Projektordner entfernen; das Backup `regatta-data.tgz` vorerst behalten.

## Aktualisieren

`cd /opt/regatta-tracker && sudo sh scripts/update-nas.sh` (der Name stammt vom NAS; das Skript erkennt `COMPOSE_FILE` in der `.env` und startet dann ohne Tunnel-Profil, mit dem Override).

## Hinweise

- `TRUST_PROXY=1` (im Override gesetzt): Die Sperre nach Fehlversuchen zaehlt pro echter Besucher-IP (X-Forwarded-For von Traefik). Ohne das haetten alle Besucher
  dieselbe IP (die des Proxys), und acht falsche Tokens wuerden alle aussperren. Der Header `CF-Connecting-IP` wird in diesem Betrieb ignoriert.
- Mit `docker compose ... config` laesst sich der zusammengefuehrte Stand pruefen. Ports sind ausschliesslich `127.0.0.1:3012:3000`.
- Backups: `data/` (positions.json, regatta.json, history/) regelmaessig sichern, zum Beispiel taeglich per Cron `tar czf` nach `/opt/backups/`.
