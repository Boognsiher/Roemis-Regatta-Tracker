#pragma once
#include <stdint.h>
#include <stddef.h>
/*
 * Liest die Meldung UBX-NAV-TIMEGPS des u-blox NEO-6M mit (reine Logik, ohne Arduino; Test: test/firmware/ubxtime_test.cpp).
 * Ihr Flag leapSValid sagt, ob das Modul die Schaltsekunden (GPS-Zeit -> UTC) schon kennt. Direkt nach einem Kaltstart rechnet das Modul mit einem
 * eingebauten Wert, bis es die Daten vom Satelliten hat (bis ca. 12 Minuten): Die NMEA-Zeit ist dann um einige Sekunden falsch (in Messungen: genau 3 s),
 * obwohl die Position stimmt. Solche Positionen duerfen nicht mit Zeitstempel gesendet oder aufgezeichnet werden.
 *
 * UBX-Rahmen: B5 62 | Klasse | ID | Laenge (2 Byte, LE) | Nutzdaten | CK_A CK_B (Fletcher ueber Klasse..Nutzdaten).
 * NAV-TIMEGPS = Klasse 0x01, ID 0x20, 16 Byte: iTOW U4, fTOW I4, week I2, leapS I1 (Offset 10), valid X1 (Offset 11), tAcc U4.
 * valid: Bit0 towValid, Bit1 weekValid, Bit2 leapSValid.
 */
#define UBX_MAX_PAYLOAD 64        // laengere "Rahmen" gelten als Stoerung (sonst koennte ein Zufallstreffer NMEA-Text verschlucken)
#define UBX_TIME_GIVEUP_MS 90000UL // spricht das Modul bis dahin kein UBX, ist es kein u-blox: Zeit gilt dann als nicht pruefbar = vertrauenswuerdig

struct UbxTime {
  uint8_t st = 0;
  uint8_t cls = 0, id = 0;
  uint16_t len = 0, pos = 0;
  uint8_t ckA = 0, ckB = 0;
  uint8_t buf[16];
  bool seen = false;        // mindestens ein gueltiger NAV-TIMEGPS-Rahmen empfangen
  bool leapValid = false;   // Schaltsekunden bekannt
  int8_t leapS = 0;

  void sum(uint8_t c) { ckA = (uint8_t)(ckA + c); ckB = (uint8_t)(ckB + ckA); }

  /** Ein Byte vom GPS-Modul. true = Byte gehoert zu einem UBX-Rahmen (nicht an die NMEA-Auswertung weitergeben). */
  bool feed(uint8_t c) {
    switch (st) {
      case 0: if (c == 0xB5) { st = 1; return true; } return false;   // 0xB5 kommt in NMEA-Text (ASCII) nie vor
      case 1:
        if (c == 0x62) { st = 2; ckA = ckB = 0; } else if (c != 0xB5) st = 0;   // 0xB5 0xB5 0x62: zweites 0xB5 ist der echte Rahmenanfang
        return true;
      case 2: cls = c; sum(c); st = 3; return true;
      case 3: id = c; sum(c); st = 4; return true;
      case 4: len = c; sum(c); st = 5; return true;
      case 5:
        len |= (uint16_t)c << 8; sum(c); pos = 0;
        if (len > UBX_MAX_PAYLOAD) { st = 0; return true; }
        st = len ? 6 : 7;
        return true;
      case 6:
        if (pos < sizeof(buf)) buf[pos] = c;
        pos++; sum(c);
        if (pos >= len) st = 7;
        return true;
      case 7: if (c == ckA) { st = 8; } else { st = 0; } return true;
      case 8:
        st = 0;
        if (c == ckB && cls == 0x01 && id == 0x20 && len == 16) {
          uint8_t valid = buf[11];
          leapS = (int8_t)buf[10];
          leapValid = (valid & 0x07) == 0x07;
          seen = true;
        }
        return true;
    }
    st = 0;
    return false;
  }

  /** Ist die GPS-Zeit (UTC) verlaesslich? Ohne UBX-Antwort des Moduls nach UBX_TIME_GIVEUP_MS: ja (nicht pruefbar). */
  bool trusted(uint32_t nowMs) const {
    if (seen) return leapValid;
    return nowMs >= UBX_TIME_GIVEUP_MS;
  }
};

/** UBX-CFG-MSG: Nachricht (cls,id) mit Rate auf dem aktuellen Port einschalten. Schreibt 11 Byte nach out. */
static inline size_t ubxEnableMsg(uint8_t cls, uint8_t id, uint8_t rate, uint8_t *out) {
  const uint8_t body[] = {0x06, 0x01, 0x03, 0x00, cls, id, rate};
  uint8_t a = 0, b = 0;
  out[0] = 0xB5; out[1] = 0x62;
  for (size_t i = 0; i < sizeof(body); i++) { out[2 + i] = body[i]; a = (uint8_t)(a + body[i]); b = (uint8_t)(b + a); }
  out[9] = a; out[10] = b;
  return 11;
}
