#!/usr/bin/env python3
"""
Liest mehrere Tracker/Master gleichzeitig ueber USB-Seriell mit und schreibt alles in Dateien (fuer GPS-Vergleichstests).

  pip install pyserial
  python scripts/serial_log.py COM5:Tracker2 COM6:Tracker3
  python scripts/serial_log.py /dev/ttyUSB0:A /dev/ttyUSB1:B --interval 20 --minutes 10

Pro Port wird alle --interval Sekunden der Statusbefehl 's' gesendet (Tracker/Logger). Die Antworten werden ausgewertet:
Satelliten, Fix, GPS-Zeichen, Pruefsummenfehler, Chiptemperatur, Akku. Ausgabe im Ordner serial-logs/<Zeitstempel>/:
  roh.log      alle empfangenen Zeilen mit Zeitstempel und Name (auch RX-Zeilen des Masters)
  status.csv   eine Zeile pro Statusantwort (fuer Tabellenkalkulation / zum Weitergeben)
Am Ende (Strg+C oder --minutes) steht eine Zusammenfassung pro Board: Zeit bis zum ersten Fix, maximale Satellitenzahl, GPS-Zeichen.
Keine Tokens oder Passwoerter im Log: die Firmware gibt keine aus.
"""
import argparse
import csv
import os
import re
import sys
import threading
import time
from datetime import datetime

try:
    import serial
except ImportError:
    sys.exit("pyserial fehlt: pip install pyserial")

RE_ID = re.compile(r"ID (\d+) \| Sat (-?\d+) \| Fix (ja|nein)")
RE_AKKU = re.compile(r"Akku (\?|)(\d+)%")
RE_GPS = re.compile(r"GPS-Zeichen (\d+), Pruefsummenfehler (\d+)")
RE_HB = re.compile(r"Lebenszeichen gesendet (\d+), Band belegt (\d+)")
RE_CHIP = re.compile(r"Chip (-?\d+) Grad C")
RE_FW = re.compile(r"Firmware (.+?)\s*(\(|$)")

FIELDS = ["zeit", "name", "tracker_id", "sat", "fix", "gps_zeichen", "pruefsummenfehler", "heartbeats", "band_belegt", "akku_pct", "chip_grad"]


def parse_line(line, state):
    """Aktualisiert 'state' aus einer Monitor-Zeile. Gibt True zurueck, wenn die Statusantwort vollstaendig ist (Chip-Zeile)."""
    m = RE_ID.search(line)
    if m:
        state["tracker_id"], state["sat"], state["fix"] = m.group(1), m.group(2), m.group(3)
        a = RE_AKKU.search(line)
        if a:
            state["akku_pct"] = a.group(2)
        return False
    m = RE_GPS.search(line)
    if m:
        state["gps_zeichen"], state["pruefsummenfehler"] = m.group(1), m.group(2)
        h = RE_HB.search(line)
        if h:
            state["heartbeats"], state["band_belegt"] = h.group(1), h.group(2)
        return False
    m = RE_CHIP.search(line)
    if m:
        state["chip_grad"] = m.group(1)
        return True
    return False


class Port(threading.Thread):
    def __init__(self, dev, name, args, outdir, rawlog, csvw, lock, t0):
        super().__init__(daemon=True)
        self.dev, self.name, self.args = dev, name, args
        self.rawlog, self.csvw, self.lock, self.t0 = rawlog, csvw, lock, t0
        self.stop = threading.Event()
        self.state = {}
        self.first_fix_s = None
        self.max_sat = -1
        self.last = {}
        self.firmware = ""
        self.error = ""

    def log(self, text):
        with self.lock:
            self.rawlog.write(f"{datetime.now().strftime('%H:%M:%S')} [{self.name}] {text}\n")
            self.rawlog.flush()

    def run(self):
        try:
            ser = serial.Serial(self.dev, self.args.baud, timeout=0.5)
        except Exception as e:  # Port belegt (z.B. anderer Monitor offen) oder falscher Name
            self.error = f"{self.dev}: {e}"
            print(f"FEHLER {self.error}")
            return
        next_s = time.time() + 2
        buf = b""
        while not self.stop.is_set():
            if time.time() >= next_s:
                ser.write(b"s\n")
                next_s = time.time() + self.args.interval
            chunk = ser.read(512)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                self.log(line)
                fw = RE_FW.search(line)
                if fw and "Regatta" in line:
                    self.firmware = line
                if parse_line(line, self.state):
                    self.complete_status()
        ser.close()

    def complete_status(self):
        s = dict(self.state)
        now = time.time() - self.t0
        sat = int(s.get("sat", -1)) if s.get("sat", "-1").lstrip("-").isdigit() else -1
        self.max_sat = max(self.max_sat, sat)
        if s.get("fix") == "ja" and self.first_fix_s is None:
            self.first_fix_s = now
        self.last = s
        row = {"zeit": datetime.now().strftime("%H:%M:%S"), "name": self.name}
        row.update({k: s.get(k, "") for k in FIELDS[2:]})
        with self.lock:
            self.csvw.writerow(row)
        print(f"{row['zeit']} {self.name:>10}: Sat {s.get('sat','?'):>2} Fix {s.get('fix','?'):>4} "
              f"GPS-Zeichen {s.get('gps_zeichen','?')} Chip {s.get('chip_grad','?')} C Akku {s.get('akku_pct','?')}%")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ports", nargs="+", help="PORT:NAME, z.B. COM5:Tracker2")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--interval", type=int, default=20, help="Sekunden zwischen den 's'-Abfragen (Standard 20)")
    ap.add_argument("--minutes", type=float, default=0, help="nach so vielen Minuten beenden (0 = bis Strg+C)")
    ap.add_argument("--out", default="serial-logs")
    args = ap.parse_args()

    outdir = os.path.join(args.out, datetime.now().strftime("%Y%m%d_%H%M%S"))
    os.makedirs(outdir, exist_ok=True)
    rawlog = open(os.path.join(outdir, "roh.log"), "w", encoding="utf-8")
    csvf = open(os.path.join(outdir, "status.csv"), "w", newline="", encoding="utf-8")
    csvw = csv.DictWriter(csvf, fieldnames=FIELDS)
    csvw.writeheader()
    lock, t0 = threading.Lock(), time.time()

    workers = []
    for spec in args.ports:
        dev, sep, name = spec.rpartition(":")    # PORT:NAME; ohne Doppelpunkt gilt der Port auch als Name
        if not sep:
            dev, name = spec, spec
        workers.append(Port(dev, name, args, outdir, rawlog, csvw, lock, t0))
    for w in workers:
        w.start()
    print(f"Ausgabe: {outdir}  (Strg+C beendet)")
    try:
        while True:
            time.sleep(1)
            if args.minutes and time.time() - t0 >= args.minutes * 60:
                break
            if all(not w.is_alive() for w in workers):
                break
    except KeyboardInterrupt:
        pass
    for w in workers:
        w.stop.set()
    time.sleep(1)

    print("\n=== Zusammenfassung ===")
    for w in workers:
        if w.error:
            print(f"{w.name}: {w.error}")
            continue
        ff = f"{w.first_fix_s:.0f} s" if w.first_fix_s is not None else "KEIN FIX"
        print(f"{w.name}: erster Fix nach {ff}, max. Satelliten {w.max_sat}, GPS-Zeichen {w.last.get('gps_zeichen','?')}, "
              f"letzter Stand Sat {w.last.get('sat','?')} Fix {w.last.get('fix','?')}")
        if w.firmware:
            print(f"   {w.firmware}")
    rawlog.close()
    csvf.close()
    print(f"Dateien in {outdir}: roh.log, status.csv")


if __name__ == "__main__":
    main()
