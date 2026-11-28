package ch.regattazeit.tracker.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import ch.regattazeit.tracker.FlushResult
import ch.regattazeit.tracker.Fix
import ch.regattazeit.tracker.PositionQueue
import ch.regattazeit.tracker.TrackerLink
import ch.regattazeit.tracker.Uploader
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Vordergrunddienst: misst die Position (GPS, 1x pro Sekunde), legt sie in die dauerhafte Warteschlange und sendet sie gebuendelt alle ~4 s an den Server.
 * Laeuft auch bei ausgeschaltetem Bildschirm und im Hintergrund (Typ "location" mit dauerhafter Benachrichtigung, CPU per Wake-Lock wach). Ohne Netz sammelt er
 * weiter und sendet nach. START_STICKY: Wird der Dienst vom System beendet, startet es ihn neu; Prefs.running merkt, dass der Tracker laufen soll.
 * (28.11.2026) Noch nicht auf einem Geraet getestet.
 */
class TrackingService : Service(), LocationListener {

    companion object {
        const val ACTION_START = "ch.regattazeit.tracker.START"
        const val ACTION_STOP = "ch.regattazeit.tracker.STOP"
        private const val CHANNEL = "tracking"
        private const val NOTIF_ID = 1
        private const val MAX_ACCURACY_M = 100f      // ungenauere Positionen (z.B. Netz statt GPS) werden verworfen
        private const val SEND_EVERY_S = 4L
    }

    private lateinit var queue: PositionQueue
    private var uploader: Uploader? = null
    private var link: TrackerLink? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var sendTask: ScheduledFuture<*>? = null
    private var tracking = false
    private var lastTs = 0L

    override fun onCreate() {
        super.onCreate()
        queue = PositionQueue(File(filesDir, Prefs.QUEUE_FILE))
        TrackingStatus.queueSize = queue.size()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopTracking()
            return START_NOT_STICKY
        }
        // Neustart durch das System (intent == null): nur weiterlaufen, wenn der Tracker laufen sollte
        if (intent == null && !Prefs.running(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val l = Prefs.link(this)
        if (l == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        link = l
        uploader = Uploader(queue, ch.regattazeit.tracker.app.Net.poster, l)
        startInForeground(notification("Regatta-Tracker läuft"))
        startTracking()
        return START_STICKY
    }

    private fun startInForeground(n: Notification) {
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) else startForeground(NOTIF_ID, n)
    }

    private fun startTracking() {
        if (tracking) return
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper())
        } catch (e: SecurityException) {
            TrackingStatus.message = "Standort-Berechtigung fehlt - bitte in den Einstellungen erlauben"
            stopTracking()
            return
        } catch (e: IllegalArgumentException) {
            TrackingStatus.message = "Dieses Gerät hat kein GPS"
            stopTracking()
            return
        }
        tracking = true
        Prefs.setRunning(this, true)
        TrackingStatus.running = true
        TrackingStatus.message = ""
        TrackingStatus.gpsOff = !lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "regattatracker:tracking").apply { acquire() }
        sendTask = worker.scheduleWithFixedDelay({ sendNow() }, 2, SEND_EVERY_S, TimeUnit.SECONDS)
    }

    private fun stopTracking() {
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try { lm.removeUpdates(this) } catch (_: SecurityException) { /* nichts zu entfernen */ }
        sendTask?.cancel(false)
        sendTask = null
        // Letzter Sendeversuch, damit nichts Unnoetiges im Puffer liegen bleibt
        try { worker.submit { sendNow() }.get(8, TimeUnit.SECONDS) } catch (_: Exception) { /* spaeter */ }
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        tracking = false
        Prefs.setRunning(this, false)
        TrackingStatus.running = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        // (28.11.2026) Auch beim Beenden per stopService() (Knopf "Anderen Link einrichten") GPS abmelden und WakeLock freigeben.
        // Vorher lief beides nach dem Zerstoeren des Dienstes weiter (auf dem Geraet nachgewiesen: GPS-Anfrage 1 s + WakeLock aktiv),
        // und der tote Dienst haengte weiter Positionen an den Puffer an.
        try { (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(this) } catch (_: SecurityException) { /* nichts zu entfernen */ }
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        tracking = false
        TrackingStatus.running = false
        worker.shutdown()
        super.onDestroy()
    }

    // ---- GPS ----

    override fun onLocationChanged(loc: Location) {
        val ts = loc.time
        if (ts <= lastTs) return                                   // doppelte/rueckwaerts laufende Zeit ignorieren
        val acc = if (loc.hasAccuracy()) loc.accuracy else -1f
        if (acc > MAX_ACCURACY_M) return
        lastTs = ts
        val speed = if (loc.hasSpeed()) loc.speed.toDouble() else null
        val fix = Fix(
            ts = ts, lat = loc.latitude, lon = loc.longitude,
            accuracy = if (acc >= 0) acc.toDouble() else null,
            speed = speed,
            heading = if (loc.hasBearing() && (speed ?: 0.0) > 0.5) loc.bearing.toDouble() else null,
            battery = batteryFraction(),
        )
        if (queue.add(fix)) {
            TrackingStatus.lastFixTs = ts
            TrackingStatus.lastFixLocal = System.currentTimeMillis()
            TrackingStatus.accuracyM = acc
            TrackingStatus.queueSize = queue.size()
        }
    }

    override fun onProviderEnabled(provider: String) { TrackingStatus.gpsOff = false }
    override fun onProviderDisabled(provider: String) { TrackingStatus.gpsOff = true }
    @Deprecated("Seit Android 10 nicht mehr aufgerufen, aber fuer aeltere Geraete noetig")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    // ---- Senden ----

    private fun sendNow() {
        val up = uploader ?: return
        val (n, result) = up.flushAll()
        TrackingStatus.queueSize = queue.size()
        if (n > 0) {
            TrackingStatus.sentTotal += n
            TrackingStatus.lastSentLocal = System.currentTimeMillis()
        }
        when (result) {
            is FlushResult.Retry -> TrackingStatus.message = "Senden nicht möglich: ${result.reason}. Die Positionen werden gespeichert und später gesendet."
            is FlushResult.Rejected -> {
                TrackingStatus.message = result.reason
                // Link ungueltig: Weitermessen hat keinen Sinn (der Puffer bleibt erhalten, bis ein gueltiger Link eingelesen ist)
                stopTrackingFromWorker()
                return
            }
            else -> TrackingStatus.message = ""
        }
        updateNotification()
    }

    private fun stopTrackingFromWorker() {
        android.os.Handler(Looper.getMainLooper()).post { stopTracking() }
    }

    // ---- Benachrichtigung ----

    private fun notification(text: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Tracking", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, TrackingService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Regatta-Tracker")
            .setContentText(text)
            .setContentIntent(open)
            .addAction(0, "Stopp", stop)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun updateNotification() {
        val ago = if (TrackingStatus.lastSentLocal > 0) "vor ${(System.currentTimeMillis() - TrackingStatus.lastSentLocal) / 1000} s" else "noch nicht"
        val text = if (TrackingStatus.message.isNotEmpty()) "Problem: ${TrackingStatus.message.take(60)}" else "gesendet $ago · ${TrackingStatus.queueSize} wartend"
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, notification(text))
    }

    private fun batteryFraction(): Double? {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (pct in 0..100) pct / 100.0 else null
    }
}
