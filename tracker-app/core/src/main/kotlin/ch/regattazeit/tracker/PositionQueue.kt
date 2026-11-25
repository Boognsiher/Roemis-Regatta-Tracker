package ch.regattazeit.tracker

import java.io.File

/**
 * Warteschlange der noch nicht gesendeten Positionen, in einer Datei (eine Zeile pro Position). Sie ueberlebt Funkloch, App-Neustart und Absturz;
 * erst nach erfolgreichem Senden werden Eintraege entfernt. Wird sie zu gross (lange kein Netz), fallen die AELTESTEN Eintraege weg.
 * Alle Methoden sind synchronisiert (GPS-Rueckruf und Sende-Thread greifen gleichzeitig zu).
 */
class PositionQueue(private val file: File, private val maxEntries: Int = DEFAULT_MAX) {

    companion object {
        /** 20000 Positionen = rund 5,5 Stunden bei 1 Position pro Sekunde (ca. 1,5 MB). */
        const val DEFAULT_MAX = 20_000
    }

    private var entries = ArrayList<Fix>()

    init {
        load()
    }

    @Synchronized
    private fun load() {
        entries = ArrayList()
        if (!file.exists()) return
        file.forEachLine { l -> Fix.fromLine(l)?.let { entries.add(it) } }
        if (entries.size > maxEntries) {
            entries = ArrayList(entries.subList(entries.size - maxEntries, entries.size))
            rewrite()
        }
    }

    @Synchronized
    fun size(): Int = entries.size

    /** Haengt eine Position an. Ungueltige Positionen werden verworfen (false). */
    @Synchronized
    fun add(fix: Fix): Boolean {
        if (!fix.isValid()) return false
        entries.add(fix)
        if (entries.size > maxEntries) {
            val drop = entries.size - maxEntries
            entries = ArrayList(entries.subList(drop, entries.size))
            rewrite()
        } else {
            file.parentFile?.mkdirs()
            file.appendText(fix.toLine() + "\n")
        }
        return true
    }

    /** Die aeltesten bis zu n Eintraege, ohne sie zu entfernen. */
    @Synchronized
    fun peek(n: Int): List<Fix> = ArrayList(entries.subList(0, minOf(n, entries.size)))

    /** Entfernt die aeltesten n Eintraege (nach erfolgreichem Senden). */
    @Synchronized
    fun drop(n: Int) {
        if (n <= 0) return
        entries = ArrayList(entries.subList(minOf(n, entries.size), entries.size))
        rewrite()
    }

    @Synchronized
    fun clear() {
        entries = ArrayList()
        file.delete()
    }

    private fun rewrite() {
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeText(entries.joinToString("\n", postfix = if (entries.isEmpty()) "" else "\n") { it.toLine() })
        if (!tmp.renameTo(file)) {            // Fallback, falls das Umbenennen auf dem Geraet nicht klappt
            file.writeText(tmp.readText())
            tmp.delete()
        }
    }
}
