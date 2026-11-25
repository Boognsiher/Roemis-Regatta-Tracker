package ch.regattazeit.tracker

import java.util.Locale

/**
 * Eine gemessene Position. ts = GPS-Zeit in Millisekunden seit 1970 (nicht die Uhr des Handys, damit die Zeitmessung stimmt),
 * speed in m/s, heading in Grad (0..360), battery 0..1, accuracy in Metern. Unbekannte Werte sind null.
 */
data class Fix(
    val ts: Long,
    val lat: Double,
    val lon: Double,
    val accuracy: Double? = null,
    val speed: Double? = null,
    val heading: Double? = null,
    val battery: Double? = null,
) {
    /** Gueltig fuer den Server: endliche Koordinaten im Bereich, nicht (0,0), Zeit nach 2020. */
    fun isValid(): Boolean =
        lat.isFinite() && lon.isFinite() && kotlin.math.abs(lat) <= 90 && kotlin.math.abs(lon) <= 180 &&
            !(kotlin.math.abs(lat) < 1e-6 && kotlin.math.abs(lon) < 1e-6) && ts >= MIN_TS

    /** Eine Zeile fuer die Puffer-Datei: ts,lat,lon,accuracy,speed,heading,battery (leer = unbekannt). */
    fun toLine(): String = listOf(
        ts.toString(), fmt(lat, 7), fmt(lon, 7), opt(accuracy, 1), opt(speed, 2), opt(heading, 1), opt(battery, 3),
    ).joinToString(",")

    /** Ein Eintrag fuer den Sendeauftrag (JSON, Zahlen mit Punkt, unbekannte Felder weggelassen). */
    fun toJson(): String {
        val sb = StringBuilder("{\"lat\":").append(fmt(lat, 7)).append(",\"lon\":").append(fmt(lon, 7)).append(",\"ts\":").append(ts)
        accuracy?.let { sb.append(",\"accuracy\":").append(fmt(it, 1)) }
        speed?.let { sb.append(",\"speed\":").append(fmt(it, 2)) }
        heading?.let { sb.append(",\"heading\":").append(fmt(it, 1)) }
        battery?.let { sb.append(",\"battery\":").append(fmt(it, 3)) }
        return sb.append('}').toString()
    }

    companion object {
        /** Frueher als 2020 ist keine echte GPS-Zeit (Uhr noch nicht gesetzt). */
        const val MIN_TS = 1_577_836_800_000L

        private fun fmt(v: Double, digits: Int): String = String.format(Locale.ROOT, "%.${digits}f", v)
        private fun opt(v: Double?, digits: Int): String = if (v == null || !v.isFinite()) "" else fmt(v, digits)

        /** Gegenstueck zu [toLine]; null bei einer defekten Zeile (halbe Zeile nach einem Absturz, Muell). */
        fun fromLine(line: String): Fix? {
            val p = line.trim().split(',')
            if (p.size != 7) return null
            val ts = p[0].toLongOrNull() ?: return null
            val lat = p[1].toDoubleOrNull() ?: return null
            val lon = p[2].toDoubleOrNull() ?: return null
            val fix = Fix(ts, lat, lon, p[3].toDoubleOrNull(), p[4].toDoubleOrNull(), p[5].toDoubleOrNull(), p[6].toDoubleOrNull())
            return if (fix.isValid()) fix else null
        }

        /** Sendeauftrag fuer POST /api/trackers/:id/positions. */
        fun batchJson(fixes: List<Fix>): String = fixes.joinToString(",", "{\"positions\":[", "]}") { it.toJson() }
    }
}
