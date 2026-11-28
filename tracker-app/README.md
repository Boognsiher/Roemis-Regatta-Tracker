# Regatta-Tracker (Android)

Stark vereinfachte reine Tracker-App: sendet die GPS-Position des Handys im Hintergrund an den Regatta-Server. Keine Karte, keine Wertung – die Ansicht gibt es im Browser (Knopf „Karte im Browser öffnen“).

## Bedienung
1. Tracker-Link der Wettfahrtleitung (`https://regattazeit.ch/t/<id>?token=…`) einfügen oder QR-Code scannen.
2. START drücken, Standort erlauben, Akku-Optimierung ausschalten (einmaliger Hinweis).
3. Läuft als Vordergrunddienst (Benachrichtigung mit „Stopp“), auch bei ausgeschaltetem Bildschirm. Ohne Netz wird gepuffert (max. 20 000 Positionen) und nachgesendet.

Server-Schnittstelle: `POST /api/trackers/:id/positions` mit `Authorization: Bearer <token>`.

## Aufbau
- `core/` – reine Kotlin-Logik (Link, Fix, Warteschlange, Uploader), ohne Android. Test: `cd core && gradle selfTest` (7 Tests).
- `app/` – Android-Teil (`MainActivity`, `TrackingService`, `Prefs`, `Net`); bindet `core/src/main` ein.

## Bauen
Braucht Android SDK (API 34) und JDK 17:

    ./gradlew assembleDebug

Die APK liegt danach in `app/build/outputs/apk/debug/app-debug.apk`.

### Release (zum Verteilen)
    ./gradlew assembleRelease

Ergebnis: `app/build/outputs/apk/release/app-release.apk`, signiert mit dem Release-Schluessel. Schluessel und Passwoerter liegen NICHT im Repository, sondern in `~/.regatta-tracker/keystore.properties` (Eintraege `storeFile`, `storePassword`, `keyAlias`, `keyPassword`; anderer Ort per Umgebungsvariable `REGATTA_TRACKER_KEYSTORE`). Fehlt die Datei, wird die Release-APK unsigniert gebaut und laesst sich nicht installieren.

**Den Schluessel sicher aufbewahren (Backup!).** Ohne ihn kann keine Update-Version mehr gebaut werden: Android installiert ein Update nur mit derselben Signatur, sonst muessen alle Nutzer die App deinstallieren. Vor jeder Verteilung `versionCode` in `app/build.gradle.kts` erhoehen.

**Stand:** Die Core-Logik ist getestet. Der Android-Teil wurde in der Cloud-Umgebung NICHT kompiliert (kein SDK) und nicht auf einem Gerät getestet – beim ersten Build können Kleinigkeiten anfallen.

## Verteilen
APK nach `data/app/regatta-tracker.apk` auf dem NAS kopieren. Dann ist sie unter `/tracker.apk` herunterladbar, Anleitung unter `/app.html`.
