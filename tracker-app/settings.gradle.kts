pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "RegattaTracker"
include(":app")
// Der Ordner "core" ist ein eigenes, auf dem Rechner testbares Gradle-Projekt (nur Kotlin-Logik). Die App bindet seine Quelldateien direkt ein.
