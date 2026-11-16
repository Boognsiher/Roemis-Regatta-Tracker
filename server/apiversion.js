'use strict';
/*
 * Version der Schnittstelle zu externen Clients (Segeluhr-App, Gateway-App, Firmware).
 * NICHT die Paketversion aus package.json.
 *
 * Regeln:
 *  - API_VERSION (major) nur erhoehen, wenn bestehende Felder/Endpunkte entfernt oder umgedeutet werden.
 *  - API_MINOR erhoehen, wenn rueckwaertskompatibel etwas dazukommt (neue Felder/Endpunkte).
 *  - Aenderungen in docs/GATEWAY_PROTOCOL.md (Abschnitt "Versionierung") eintragen.
 */
const API_VERSION = 1;
const API_MINOR = 0;

function info() {
  return { api: API_VERSION, minor: API_MINOR, name: 'roemis-regatta-tracker' };
}

module.exports = { API_VERSION, API_MINOR, info };
