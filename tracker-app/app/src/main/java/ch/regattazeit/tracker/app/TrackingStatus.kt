package ch.regattazeit.tracker.app

/**
 * Stand des Trackers fuer die Anzeige. Der Dienst schreibt, die Oberflaeche liest einmal pro Sekunde (kein Rueckruf-Geflecht noetig).
 * Alles @Volatile, weil GPS-Rueckruf, Sende-Thread und Oberflaeche auf verschiedenen Threads laufen.
 */
object TrackingStatus {
    @Volatile var running = false
    @Volatile var lastFixTs = 0L           // GPS-Zeit der letzten Position (ms)
    @Volatile var lastFixLocal = 0L        // Handy-Uhr zum Zeitpunkt dieser Position (ms), fuer "vor x s"
    @Volatile var accuracyM = -1f
    @Volatile var lastSentLocal = 0L       // Handy-Uhr beim letzten erfolgreichen Senden
    @Volatile var sentTotal = 0L
    @Volatile var queueSize = 0
    @Volatile var message = ""             // Fehler/Hinweis, leer = alles in Ordnung
    @Volatile var gpsOff = false
}
