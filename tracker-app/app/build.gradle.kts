plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ch.regattazeit.tracker"
    compileSdk = 34

    defaultConfig {
        applicationId = "ch.regattazeit.tracker"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
