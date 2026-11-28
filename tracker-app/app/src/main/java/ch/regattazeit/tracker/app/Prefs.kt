package ch.regattazeit.tracker.app

import android.content.Context
import ch.regattazeit.tracker.TrackerLink

/** Gespeicherte Einstellungen: der eingelesene Tracker-Link, der Name des Boots und ob der Tracker laufen soll (fuer den Neustart des Dienstes). */
object Prefs {
    private const val FILE = "tracker"

    private fun sp(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun link(c: Context): TrackerLink? {
        val p = sp(c)
        val url = p.getString("serverUrl", null) ?: return null
        val id = p.getString("trackerId", null) ?: return null
        val token = p.getString("token", null) ?: return null
        return TrackerLink(url, id, token)
    }

    /** Speichert einen neuen Link. Gehoert er zu einem anderen Tracker als vorher, wird der Puffer der alten Positionen geloescht (sie gehoeren zu einem anderen Boot). */
    fun setLink(c: Context, link: TrackerLink) {
        // (28.11.2026) Vergleich mit der zuletzt benutzten Tracker-ID statt mit link(c): nach "Anderen Link einrichten" (clearLink) ist link(c) null,
        // dadurch blieb der Puffer des alten Boots stehen und wurde unter dem NEUEN Tracker hochgeladen.
        val oldId = sp(c).getString("trackerId", null)
        if (oldId != null && oldId != link.trackerId) java.io.File(c.filesDir, QUEUE_FILE).delete()
        sp(c).edit().putString("serverUrl", link.serverUrl).putString("trackerId", link.trackerId).putString("token", link.token)
            .remove("boatName").apply()
    }

    /**
     * Vergisst den Link. Die Tracker-ID bleibt bewusst gespeichert (ohne serverUrl/token ist link() trotzdem null): setLink() erkennt daran,
     * ob der Puffer zum gleichen Boot gehoert (dann bleibt er, ungesendete Positionen gehen nicht verloren) oder zu einem anderen (dann geloescht).
     * Geloescht wird erst in setLink() und nicht hier, weil ein noch laufender letzter Sendeversuch des Dienstes die Datei sonst neu schreiben koennte.
     */
    fun clearLink(c: Context) {
        sp(c).edit().remove("serverUrl").remove("token").remove("boatName").putBoolean("running", false).apply()
    }

    fun boatName(c: Context): String? = sp(c).getString("boatName", null)
    fun setBoatName(c: Context, v: String) = sp(c).edit().putString("boatName", v).apply()

    fun running(c: Context): Boolean = sp(c).getBoolean("running", false)
    fun setRunning(c: Context, v: Boolean) = sp(c).edit().putBoolean("running", v).apply()

    /** Hinweis zur Akku-Optimierung nur einmal zeigen. */
    fun batteryHintShown(c: Context): Boolean = sp(c).getBoolean("batteryHint", false)
    fun setBatteryHintShown(c: Context) = sp(c).edit().putBoolean("batteryHint", true).apply()

    const val QUEUE_FILE = "queue.txt"
}
