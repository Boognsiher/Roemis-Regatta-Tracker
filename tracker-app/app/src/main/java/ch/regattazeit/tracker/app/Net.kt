package ch.regattazeit.tracker.app

import ch.regattazeit.tracker.Poster
import ch.regattazeit.tracker.TrackerLink
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** HTTP-Zugriff ohne zusaetzliche Bibliothek (HttpURLConnection). */
object Net {

    /** Sendet JSON per POST mit dem Tracker-Token (Authorization: Bearer). Gibt den Statuscode zurueck; ohne Verbindung wirft es eine IOException. */
    val poster = Poster { url, token, json ->
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 10_000
            c.readTimeout = 15_000
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            c.setRequestProperty("Authorization", "Bearer $token")
            c.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val code = c.responseCode
            (if (code >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() }      // Antwort leeren, damit die Verbindung sauber schliesst
            code
        } finally {
            c.disconnect()
        }
    }

    /** Name des Boots vom Server (nur zur Anzeige). null bei jedem Fehler. */
    fun fetchBoatName(link: TrackerLink): String? = try {
        val c = URL(link.infoUrl).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 8_000
            c.readTimeout = 8_000
            c.setRequestProperty("Authorization", "Bearer ${link.token}")
            if (c.responseCode == 200) JSONObject(c.inputStream.bufferedReader().readText()).optString("name").ifBlank { null } else null
        } finally {
            c.disconnect()
        }
    } catch (e: Exception) {
        null
    }
}
