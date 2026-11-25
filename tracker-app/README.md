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

**Stand:** Die Core-Logik ist getestet. Der Android-Teil wurde in der Cloud-Umgebung NICHT kompiliert (kein SDK) und nicht auf einem Gerät getestet – beim ersten Build können Kleinigkeiten anfallen.

## Verteilen
APK nach `data/app/regatta-tracker.apk` auf dem NAS kopieren. Dann ist sie unter `/tracker.apk` herunterladbar, Anleitung unter `/app.html`.
