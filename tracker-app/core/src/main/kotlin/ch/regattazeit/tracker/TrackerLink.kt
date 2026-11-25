package ch.regattazeit.tracker

/**
 * Zugangsdaten aus dem Tracker-Link des Admin-Bereichs (QR-Code oder Link): `https://regattazeit.ch/t/<id>?token=<token>`.
 * Daraus kennt die App Server-Adresse, Tracker-ID und Token - ein Eintippen ist nie noetig.
 */
data class TrackerLink(val serverUrl: String, val trackerId: String, val token: String) {

    companion object {
        private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val LINK = Regex("""(https?)://([^/\s?#]+)/t/([^/\s?#]+)(?:/)?(?:\?([^#\s]*))?""", RegexOption.IGNORE_CASE)

        /**
         * Liest einen Link (auch aus eingefuegtem Text mit Leerzeichen/Zeilenumbruechen drumherum). Gibt null zurueck, wenn er unvollstaendig ist.
         * http ist erlaubt (Test im lokalen Netz), im Betrieb gilt https.
         */
        fun parse(text: String?): TrackerLink? {
            val m = LINK.find((text ?: "").trim()) ?: return null
            val scheme = m.groupValues[1].lowercase()
            val host = m.groupValues[2]
            val id = m.groupValues[3]
            if (!ID.matches(id)) return null
            val token = queryParam(m.groupValues[4], "token") ?: return null
            if (token.isBlank()) return null
            return TrackerLink("$scheme://$host", id, token)
        }

        private fun queryParam(query: String, name: String): String? {
            for (part in query.split('&')) {
                val i = part.indexOf('=')
                if (i > 0 && part.substring(0, i) == name) return java.net.URLDecoder.decode(part.substring(i + 1), "UTF-8")
            }
            return null
        }
    }

    /** Adresse zum Senden mehrerer Positionen (Server: POST /api/trackers/:id/positions, Header Authorization: Bearer <token>). */
    val positionsUrl: String get() = "$serverUrl/api/trackers/$trackerId/positions"

    /** Adresse der Tracker-Daten (Name usw.), mit dem Tracker-Token abrufbar. */
    val infoUrl: String get() = "$serverUrl/api/trackers/$trackerId"

    /** Live-Karte im Browser (die App selbst zeigt keine Karte). */
    val mapUrl: String get() = "$serverUrl/index.html"
}
