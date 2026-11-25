// Reine Kotlin-Logik der Tracker-App (Link lesen, Puffer, Senden) ohne Android-Abhaengigkeiten, damit sie auf dem Rechner geprueft werden kann:
//   gradle selfTest        (oder ./gradlew selfTest im Ordner core, siehe ../README.md)
// Die App (../app) bindet genau diese Quelldateien ein (sourceSets in app/build.gradle.kts).
// Der Test kommt bewusst ohne Test-Bibliothek aus (nur Kotlin-Standardbibliothek): weniger Abhaengigkeiten, laeuft ueberall.
plugins {
    kotlin("jvm") version "1.9.24"
}

repositories {
    mavenCentral()
}

val selfTest by tasks.registering(JavaExec::class) {
    group = "verification"
    description = "Fuehrt die Tests der Kernlogik aus"
    classpath = sourceSets["test"].runtimeClasspath
    mainClass.set("ch.regattazeit.tracker.CoreSelfTestKt")
}
