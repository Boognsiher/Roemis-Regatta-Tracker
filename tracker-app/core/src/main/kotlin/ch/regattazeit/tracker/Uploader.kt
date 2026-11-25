package ch.regattazeit.tracker

import java.io.IOException

/** Schickt einen JSON-Auftrag per HTTP-POST und gibt den Statuscode zurueck; bei fehlender Verbindung wirft sie eine IOException. In der App per HttpURLConnection. */
fun interface Poster {
    @Throws(IOException::class)
    fun post(url: String, token: String, json: String): Int
}

/** Ergebnis eines Sendeversuchs. */
sealed class FlushResult {
    /** Nichts zu senden. */
    object Empty : FlushResult()

    /** n Positionen vom Server angenommen und aus der Warteschlange entfernt. */
    data class Sent(val count: Int) : FlushResult()

    /** Keine Verbindung oder Serverfehler: alles bleibt in der Warteschlange, spaeter erneut versuchen. */
    data class Retry(val reason: String) : FlushResult()

    /** Der Server lehnt Token (401) oder Tracker (404) ab: dauerhaft, der Link ist ungueltig. Senden hat keinen Sinn, bis ein neuer Link eingelesen ist. */
    data class Rejected(val reason: String) : FlushResult()
}

/**
 * Sendet die Warteschlange in Stuecken (Server nimmt bis zu 1000 Positionen pro Aufruf). Ein Stueck wird erst nach der Bestaetigung des Servers aus
 * der Warteschlange entfernt. Lehnt der Server ein Stueck wegen seines Inhalts ab (andere 4xx als 401/404/429), wird es verworfen, damit die Warteschlange
 * nicht fuer immer an einem fehlerhaften Stueck haengt.
 */
class Uploader(private val queue: PositionQueue, private val poster: Poster, private val link: TrackerLink, private val batchSize: Int = 500) {

    /** Ein Stueck senden. */
    fun flushOnce(): FlushResult {
        val batch = queue.peek(batchSize)
        if (batch.isEmpty()) return FlushResult.Empty
        val code = try {
            poster.post(link.positionsUrl, link.token, Fix.batchJson(batch))
        } catch (e: IOException) {
            return FlushResult.Retry("keine Verbindung")
        }
        return when {
            code in 200..299 -> { queue.drop(batch.size); FlushResult.Sent(batch.size) }
            code == 401 -> FlushResult.Rejected("Token ungueltig - bitte den Link neu einlesen")
            code == 404 -> FlushResult.Rejected("Tracker unbekannt - bitte den Link neu einlesen")
            code == 429 || code >= 500 -> FlushResult.Retry("Server antwortet mit $code")
            code in 400..499 -> { queue.drop(batch.size); FlushResult.Retry("Stueck vom Server abgelehnt ($code), verworfen") }
            else -> FlushResult.Retry("unerwartete Antwort $code")
        }
    }

    /** So lange senden, bis die Warteschlange leer ist oder ein Fehler auftritt. Gibt die Gesamtzahl gesendeter Positionen und das letzte Ergebnis zurueck. */
    fun flushAll(maxBatches: Int = 40): Pair<Int, FlushResult> {
        var total = 0
        var last: FlushResult = FlushResult.Empty
        repeat(maxBatches) {
            last = flushOnce()
            when (val r = last) {
                is FlushResult.Sent -> total += r.count
                else -> return total to last
            }
        }
        return total to last
    }
}
