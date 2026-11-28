import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// (28.11.2026) Release-Signatur: Schluessel und Passwoerter liegen NIE im Repository, sondern in einer Datei ausserhalb.
// Standard: ~/.regatta-tracker/keystore.properties (storeFile, storePassword, keyAlias, keyPassword); anderer Ort per
// Umgebungsvariable REGATTA_TRACKER_KEYSTORE. Fehlt die Datei, wird der Release-Build nicht signiert (Debug-Builds gehen immer).
// WICHTIG: Ohne diesen Schluessel kann keine Update-Version mehr gebaut werden - Android verlangt fuer Updates die gleiche Signatur.
val keystoreProps = Properties().apply {
    val f = file(System.getenv("REGATTA_TRACKER_KEYSTORE") ?: "${System.getProperty("user.home")}/.regatta-tracker/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "ch.regattazeit.tracker"
    compileSdk = 34

    defaultConfig {
        applicationId = "ch.regattazeit.tracker"
        minSdk = 26
        targetSdk = 34
        // Bei jeder verteilten Version versionCode erhoehen, sonst installiert Android das Update nicht.
        versionCode = 2
        versionName = "1.1"
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Die Kernlogik (Link lesen, Puffer, Senden) liegt im Ordner ../core und wird dort auf dem Rechner getestet (gradle selfTest).
    sourceSets["main"].java.srcDir("../core/src/main/kotlin")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    // QR-Code lesen (Google-Play-Dienste, keine Kamera-Berechtigung noetig). Ohne Play-Dienste bleibt das Einfuegen des Links.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
