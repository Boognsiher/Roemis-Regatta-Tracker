package ch.regattazeit.tracker

import java.io.File
import java.io.IOException

// Kleine Pruef-Hilfen statt einer Test-Bibliothek (siehe build.gradle.kts)
private fun <T> assertEquals(expected: T, actual: T) = check(expected == actual) { "erwartet <$expected>, erhalten <$actual>" }
private fun assertTrue(v: Boolean) = check(v) { "erwartet true" }
private fun assertFalse(v: Boolean) = check(!v) { "erwartet false" }
private fun assertNull(v: Any?) = check(v == null) { "erwartet null, erhalten <$v>" }
private fun <T : Any> assertNotNull(v: T?): T = checkNotNull(v) { "erwartet nicht null" }

class CoreTest {
    private val t0 = 1_790_000_000_000L
    private fun fix(i: Int) = Fix(t0 + i * 1000L, 46.84 + i * 1e-5, 10.51, accuracy = 4.2, speed = 3.5, heading = 90.0, battery = 0.8)
    private fun tmp(): File = File.createTempFile("queue", ".txt").also { it.delete(); it.deleteOnExit() }

    fun linkAusAdminLink() {
        val l = assertNotNull(TrackerLink.parse("  https://regattazeit.ch/t/54qvek?token=AbC123xyz \n"))
        assertEquals("https://regattazeit.ch", l.serverUrl)
        assertEquals("54qvek", l.trackerId)
        assertEquals("AbC123xyz", l.token)
        assertEquals("https://regattazeit.ch/api/trackers/54qvek/positions", l.positionsUrl)
        assertEquals("https://regattazeit.ch/index.html", l.mapUrl)
    }

    fun linkVarianten() {
        assertEquals("http://192.168.0.46:3010", TrackerLink.parse("http://192.168.0.46:3010/t/abc?token=zz")!!.serverUrl)
        assertEquals("tok", TrackerLink.parse("Mein Link: https://x.ch/t/id1/?foo=1&token=tok&bar=2 viel Spass")!!.token)
        assertEquals("a b", TrackerLink.parse("https://x.ch/t/id1?token=a%20b")!!.token)
        assertNull(TrackerLink.parse("https://regattazeit.ch/t/54qvek"))            // kein Token
        assertNull(TrackerLink.parse("https://regattazeit.ch/t/54qvek?token="))     // leeres Token
        assertNull(TrackerLink.parse("https://regattazeit.ch/index.html"))          // kein Tracker-Link
        assertNull(TrackerLink.parse("ftp://x.ch/t/a?token=b"))
        assertNull(TrackerLink.parse("https://x.ch/t/a%b?token=b"))                  // ungueltige ID
        assertNull(TrackerLink.parse(null))
    }

    fun fixJsonUndZeile() {
        val f = fix(3)
        assertEquals("{\"lat\":46.8400300,\"lon\":10.5100000,\"ts\":${t0 + 3000},\"accuracy\":4.2,\"speed\":3.50,\"heading\":90.0,\"battery\":0.800}", f.toJson())
        assertEquals(f.copy(lat = 46.84003, lon = 10.51), Fix.fromLine(f.toLine()))
        assertEquals("{\"lat\":1.0000000,\"lon\":2.0000000,\"ts\":$t0}", Fix(t0, 1.0, 2.0).toJson())              // unbekannte Felder fehlen
        assertEquals("{\"positions\":[${fix(0).toJson()},${fix(1).toJson()}]}", Fix.batchJson(listOf(fix(0), fix(1))))
        assertFalse(Fix(t0, 0.0, 0.0).isValid())                  // Null Island
        assertFalse(Fix(t0, 91.0, 0.0).isValid())
        assertFalse(Fix(5, 46.0, 10.0).isValid())                 // Uhr nicht gesetzt
        assertFalse(Fix(t0, Double.NaN, 10.0).isValid())
        assertNull(Fix.fromLine("kaputt"))
        assertNull(Fix.fromLine("1,2,3"))
    }

    fun warteschlangeUeberlebtNeustartUndDefekteZeile() {
        val file = tmp()
        val q = PositionQueue(file)
        repeat(5) { assertTrue(q.add(fix(it))) }
        assertFalse(q.add(Fix(t0, 0.0, 0.0)))
        assertEquals(5, q.size())
        file.appendText("halbe zeile ohne zeilenende")                       // Absturz mitten im Schreiben
        val q2 = PositionQueue(file)
        assertEquals(5, q2.size())
        assertEquals(listOf(fix(0).ts, fix(1).ts), q2.peek(2).map { it.ts })
        q2.drop(2)
        assertEquals(3, PositionQueue(file).size())
        q2.clear()
        assertEquals(0, PositionQueue(file).size())
    }

    fun warteschlangeVerliertAelteste() {
        val q = PositionQueue(tmp(), maxEntries = 10)
        repeat(25) { q.add(fix(it)) }
        assertEquals(10, q.size())
        assertEquals(t0 + 15_000L, q.peek(1).first().ts)                      // die 15 aeltesten sind weg
        assertEquals(0, PositionQueue(tmp()).size())         // frische Datei: leer
    }

    fun uploaderSendetStueckeUndEntferntErstNachBestaetigung() {
        val q = PositionQueue(tmp())
        repeat(1200) { q.add(fix(it)) }
        val link = TrackerLink("https://x.ch", "abc", "tok")
        val calls = ArrayList<Triple<String, String, Int>>()
        val up = Uploader(q, { url, token, json -> calls.add(Triple(url, token, json.split("\"lat\"").size - 1)); 200 }, link, batchSize = 500)
        val (total, last) = up.flushAll()
        assertEquals(1200, total)
        assertEquals(FlushResult.Empty, last)
        assertEquals(0, q.size())
        assertEquals(listOf(500, 500, 200), calls.map { it.third })
        assertEquals("https://x.ch/api/trackers/abc/positions", calls[0].first)
        assertEquals("tok", calls[0].second)
    }

    fun uploaderBehaeltBeiFehlernUndFuerLinkProbleme() {
        val link = TrackerLink("https://x.ch", "abc", "tok")
        fun run(code: Int?): Pair<FlushResult, Int> {
            val q = PositionQueue(tmp()); repeat(3) { q.add(fix(it)) }
            val r = Uploader(q, { _, _, _ -> code ?: throw IOException("offline") }, link).flushOnce()
            return r to q.size()
        }
        assertEquals(FlushResult.Retry("keine Verbindung") to 3, run(null))             // Funkloch: alles bleibt
        assertTrue(run(500).first is FlushResult.Retry && run(500).second == 3)
        assertTrue(run(429).first is FlushResult.Retry && run(429).second == 3)
        assertTrue(run(401).first is FlushResult.Rejected && run(401).second == 3)       // Link ungueltig: nichts loeschen
        assertTrue(run(404).first is FlushResult.Rejected && run(404).second == 3)
        val bad = run(400)
        assertTrue(bad.first is FlushResult.Retry && bad.second == 0)                   // fehlerhaftes Stueck wird verworfen
        assertEquals(FlushResult.Empty, Uploader(PositionQueue(tmp()), { _, _, _ -> 200 }, link).flushOnce())
    }
}

/** Startet alle Tests; bei einem Fehler Abbruch mit Meldung und Exit-Code 1. */
fun main() {
    val t = CoreTest()
    val tests = listOf<Pair<String, () -> Unit>>(
        "linkAusAdminLink" to t::linkAusAdminLink,
        "linkVarianten" to t::linkVarianten,
        "fixJsonUndZeile" to t::fixJsonUndZeile,
        "warteschlangeUeberlebtNeustartUndDefekteZeile" to t::warteschlangeUeberlebtNeustartUndDefekteZeile,
        "warteschlangeVerliertAelteste" to t::warteschlangeVerliertAelteste,
        "uploaderSendetStueckeUndEntferntErstNachBestaetigung" to t::uploaderSendetStueckeUndEntferntErstNachBestaetigung,
        "uploaderBehaeltBeiFehlernUndFuerLinkProbleme" to t::uploaderBehaeltBeiFehlernUndFuerLinkProbleme,
    )
    var failed = 0
    for ((name, test) in tests) {
        try { test(); println("ok   $name") } catch (e: Throwable) { failed += 1; println("FAIL $name: ${e.message}") }
    }
    println(if (failed == 0) "alle ${tests.size} Tests ok" else "$failed von ${tests.size} Tests fehlgeschlagen")
    if (failed > 0) kotlin.system.exitProcess(1)
}
