#!/bin/sh
# Aktualisiert den Regatta-Tracker auf dem NAS: holt den neuesten Stand von GitHub, ersetzt Programmdateien und baut den Container neu.
# Fasst NIE an: .env, data/, docker-compose.yml, .github-token (Zugangsdaten und Aufzeichnungen bleiben unveraendert).
#
# Aufruf im Projektordner des NAS (dort, wo docker-compose.yml und .env liegen):
#   sudo sh scripts/update-nas.sh            # Standard-Branch
#   sudo sh scripts/update-nas.sh meinbranch # anderer Branch
# Von Windows (PowerShell):  ssh -t BENUTZER@NAS-IP "cd /PFAD/ZUM/PROJEKT && sudo sh scripts/update-nas.sh"
#
# Ist das GitHub-Repository privat, liegt ein Zugangstoken (nur Lese-Recht) in der Datei .github-token im Projektordner
# (oder in der Umgebungsvariable GITHUB_TOKEN). Das Token steht nie in diesem Skript und wird nicht ausgegeben.
set -eu

REPO="${REPO:-Boognsiher/Roemis-Regatta-Tracker}"
BRANCH="${1:-${BRANCH:-claude/diy-position-tracker-km1g1v}}"
URL="${TARBALL_URL:-https://api.github.com/repos/$REPO/tarball/$BRANCH}"
KEEP="server public scripts docs README.md package.json package-lock.json Dockerfile .dockerignore"

cd "$(dirname "$0")/.."
[ -f docker-compose.yml ] && [ -f .env ] || { echo "FEHLER: docker-compose.yml oder .env fehlt - bitte im Projektordner des NAS ausfuehren."; exit 1; }

TOKEN="${GITHUB_TOKEN:-}"
[ -z "$TOKEN" ] && [ -f .github-token ] && TOKEN="$(tr -d ' \r\n' < .github-token)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "1/5 Lade $REPO ($BRANCH) von GitHub ..."
if [ -n "$TOKEN" ]; then
  curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -o "$TMP/src.tgz" "$URL" \
    || { echo "FEHLER: Download fehlgeschlagen (Token ungueltig oder abgelaufen?)"; exit 1; }
else
  curl -fsSL -H "Accept: application/vnd.github+json" -o "$TMP/src.tgz" "$URL" \
    || { echo "FEHLER: Download fehlgeschlagen. Ist das Repository privat? Dann Token in .github-token ablegen (siehe Kopf dieses Skripts)."; exit 1; }
fi
mkdir "$TMP/src"
tar -xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1
[ -f "$TMP/src/server/index.js" ] || { echo "FEHLER: Download enthaelt kein server/index.js - nichts veraendert."; exit 1; }

echo "2/5 Sichere die bisherigen Programmdateien nach .update-backup ..."
rm -rf .update-backup
mkdir .update-backup
for f in $KEEP; do [ -e "$f" ] && cp -R "$f" .update-backup/ || true; done

echo "3/5 Ersetze Programmdateien (.env, data und docker-compose.yml bleiben unberuehrt) ..."
for f in $KEEP; do
  if [ -e "$TMP/src/$f" ]; then rm -rf "./$f"; cp -R "$TMP/src/$f" "./$f"; fi
done
if ! cmp -s docker-compose.yml "$TMP/src/docker-compose.yml"; then
  echo "HINWEIS: Die docker-compose.yml im Repository unterscheidet sich von deiner. Sie wurde NICHT ueberschrieben."
  echo "         Vergleich: diff docker-compose.yml $TMP/src/docker-compose.yml (Datei liegt nur waehrend dieses Laufs vor)"
fi

echo "4/5 Baue und starte die Container ..."
docker compose --profile tunnel up -d --build

echo "5/5 Pruefe, ob der Server antwortet ..."
PORT="$(grep -E '^HOST_PORT=' .env | tail -1 | cut -d= -f2 | tr -d ' \r"')"
PORT="${PORT:-3000}"
i=0
while [ $i -lt 30 ]; do
  if curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "OK: Der Server laeuft (Port $PORT). Stand: $(date '+%d.%m.%Y %H:%M')"
    echo "Zurueck zum alten Stand (falls noetig): cp -R .update-backup/* . && docker compose --profile tunnel up -d --build"
    exit 0
  fi
  i=$((i + 1)); sleep 2
done
echo "FEHLER: Der Server antwortet nicht. Log ansehen: docker compose logs --tail 50 regatta-tracker"
echo "Zurueck zum alten Stand: cp -R .update-backup/* . && docker compose --profile tunnel up -d --build"
exit 1
