package ch.regattazeit.tracker.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import ch.regattazeit.tracker.PositionQueue
import ch.regattazeit.tracker.TrackerLink
import ch.regattazeit.tracker.R
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.io.File
import kotlin.concurrent.thread

/**
 * Eine Seite, ein Zweck: Link einrichten (einfuegen oder QR-Code), START/STOPP, Status. Die Karte gibt es nur im Browser (Knopf "Karte im Browser oeffnen").
 * (28.11.2026) Noch nicht auf einem Geraet getestet.
 */
class MainActivity : Activity() {

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var tvBoat: TextView
    private lateinit var tvStatus: TextView
    private lateinit var tvMessage: TextView
    private lateinit var setupGroup: View
    private lateinit var runGroup: View
    private lateinit var btnToggle: Button
    private lateinit var etLink: EditText

    private val tick = object : Runnable {
        override fun run() {
            render()
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        tvBoat = findViewById(R.id.tvBoat)
        tvStatus = findViewById(R.id.tvStatus)
        tvMessage = findViewById(R.id.tvMessage)
        setupGroup = findViewById(R.id.setupGroup)
        runGroup = findViewById(R.id.runGroup)
        btnToggle = findViewById(R.id.btnToggle)
        etLink = findViewById(R.id.etLink)

        findViewById<Button>(R.id.btnConnect).setOnClickListener { connect(etLink.text.toString()) }
        findViewById<Button>(R.id.btnScan).setOnClickListener { scan() }
        btnToggle.setOnClickListener { toggle() }
        findViewById<Button>(R.id.btnMap).setOnClickListener {
            Prefs.link(this)?.let { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it.mapUrl))) }
        }
        findViewById<Button>(R.id.btnReset).setOnClickListener {
            if (TrackingStatus.running) stopService(Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_STOP))
            Prefs.clearLink(this)
            render()
        }
    }

    override fun onResume() {
        super.onResume()
        // Link aus der Zwischenablage-/Teilen-Funktion: ACTION_VIEW mit dem Tracker-Link wird nicht abgefangen (bewusst einfach), Einfuegen genuegt.
        tick.run()
    }

    override fun onPause() {
        ui.removeCallbacks(tick)
        super.onPause()
    }

    // ---- Einrichtung ----

    private fun connect(text: String) {
        val link = TrackerLink.parse(text)
        if (link == null) {
            Toast.makeText(this, "Das ist kein Tracker-Link (https://…/t/…?token=…)", Toast.LENGTH_LONG).show()
            return
        }
        Prefs.setLink(this, link)
        etLink.setText("")
        // Namen des Boots holen (nur zur Anzeige und als Pruefung, ob der Link stimmt)
        thread {
            val name = Net.fetchBoatName(link)
            runOnUiThread {
                if (name != null) Prefs.setBoatName(this, name)
                else Toast.makeText(this, "Server nicht erreichbar oder Link ungültig - der Tracker kann trotzdem gestartet werden", Toast.LENGTH_LONG).show()
                render()
            }
        }
        render()
    }

    private fun scan() {
        try {
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { barcode -> connect(barcode.rawValue ?: "") }
                .addOnFailureListener { Toast.makeText(this, "QR-Scanner nicht verfügbar - bitte den Link einfügen", Toast.LENGTH_LONG).show() }
        } catch (e: Exception) {
            Toast.makeText(this, "QR-Scanner nicht verfügbar - bitte den Link einfügen", Toast.LENGTH_LONG).show()
        }
    }

    // ---- Start/Stopp ----

    private fun toggle() {
        if (TrackingStatus.running) {
            startService(Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_STOP))
            return
        }
        val needed = ArrayList<String>()
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), 1)
            return
        }
        startTracker()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) startTracker()
        else Toast.makeText(this, "Ohne Standort-Berechtigung kann der Tracker nicht senden (Einstellungen, App, Berechtigungen)", Toast.LENGTH_LONG).show()
    }

    private fun startTracker() {
        ContextCompat.startForegroundService(this, Intent(this, TrackingService::class.java).setAction(TrackingService.ACTION_START))
        askBatteryOptimization()
    }

    /** Einmalig: Android soll die App im Hintergrund nicht einschlafen lassen (sonst sendet manches Handy nur bei eingeschaltetem Bildschirm). */
    private fun askBatteryOptimization() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName) || Prefs.batteryHintShown(this)) return
        Prefs.setBatteryHintShown(this)
        AlertDialog.Builder(this)
            .setTitle("Im Hintergrund weiterlaufen")
            .setMessage("Damit der Tracker auch bei ausgeschaltetem Bildschirm sendet, sollte die Akku-Optimierung für diese App ausgeschaltet sein. Im nächsten Fenster die App \"Regatta-Tracker\" wählen und \"Nicht optimieren\" einstellen.")
            .setPositiveButton("Einstellungen öffnen") { _, _ -> startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
            .setNegativeButton("Später", null)
            .show()
    }

    // ---- Anzeige ----

    private fun render() {
        val link = Prefs.link(this)
        val configured = link != null
        setupGroup.visibility = if (configured) View.GONE else View.VISIBLE
        runGroup.visibility = if (configured) View.VISIBLE else View.GONE
        tvBoat.text = when {
            !configured -> "Noch nicht eingerichtet"
            Prefs.boatName(this) != null -> "Boot: ${Prefs.boatName(this)}"
            else -> "Tracker ${link?.trackerId}"
        }
        val s = TrackingStatus
        // Dienst laeuft evtl. noch aus einer frueheren Sitzung: Zustand aus den Einstellungen mitnehmen
        val running = s.running || (Prefs.running(this) && s.lastFixLocal > 0)
        btnToggle.text = if (running) "STOPP" else "START"
        val now = System.currentTimeMillis()
        fun ago(t: Long) = if (t <= 0) "–" else "vor ${(now - t) / 1000} s"
        val queued = if (s.running) s.queueSize else PositionQueue(File(filesDir, Prefs.QUEUE_FILE)).size()
        tvStatus.text = buildString {
            append(if (running) "● Läuft" else "○ Gestoppt")
            if (running) {
                append("\nGPS: ")
                append(
                    when {
                        s.gpsOff -> "ausgeschaltet - bitte Standort einschalten"
                        s.lastFixLocal == 0L || now - s.lastFixLocal > 10_000 -> "suche Satelliten …"
                        else -> "Genauigkeit ${if (s.accuracyM >= 0) "${s.accuracyM.toInt()} m" else "?"}"
                    },
                )
            }
            append("\nZuletzt gesendet: ${ago(s.lastSentLocal)}")
            append("\nWartende Positionen: $queued")
        }
        tvMessage.text = s.message
    }
}
