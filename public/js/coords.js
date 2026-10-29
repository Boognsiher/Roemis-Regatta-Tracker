/**
 * Koordinaten-Eingabe: erkennt die ueblichen Schreibweisen und liefert {lat, lon} in Dezimalgrad (oder null).
 *   46.8419, 10.5130          46.8419 10.5130         46,8419; 10,5130
 *   N 46.8419 E 10.5130       46.8419N 10.5130E       46°50.514' N, 10°30.780' E
 *   46°50'30.5"N 10°30'46.8"E (auch O fuer Ost, ′ ″ als Zeichen)
 * Reihenfolge ohne Buchstaben: Breite (lat), Laenge (lon) - wie bei Google Maps.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Coords = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (s) => parseFloat(String(s).replace(',', '.'));

  /** Eine Koordinate aus Grad[/Minuten[/Sekunden]] und Vorzeichen/Himmelsrichtung. */
  function toDecimal(parts) {
    const deg = Math.abs(parts.deg);
    const val = deg + (parts.min || 0) / 60 + (parts.sec || 0) / 3600;
    return parts.negative ? -val : val;
  }

  // Ein Teil: [Buchstabe] Grad [°] [Minuten ['] [Sekunden ["]] [Buchstabe]
  const PART = /([NSEWO])?\s*(-?\d+(?:[.,]\d+)?)\s*(?:[°º]|\s)?\s*(?:(\d+(?:[.,]\d+)?)\s*(?:['′’‘]|\s)?\s*(?:(\d+(?:[.,]\d+)?)\s*(?:["″”]|''|’’)?)?)?\s*([NSEWO])?/gi;

  function parsePart(m) {
    const letter = (m[1] || m[5] || '').toUpperCase();
    const deg = num(m[2]);
    if (!Number.isFinite(deg)) return null;
    const min = m[3] !== undefined ? num(m[3]) : 0;
    const sec = m[4] !== undefined ? num(m[4]) : 0;
    if (min >= 60 || sec >= 60) return null;
    const negative = deg < 0 || /^-/.test(m[2]) || letter === 'S' || letter === 'W';
    return { letter, value: toDecimal({ deg, min, sec, negative }) };
  }

  function parse(text) {
    if (typeof text !== 'string') return null;
    let s = text.replace(/[()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;

    let a;
    let b;
    let m;
    if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/))) {            // 46.8419, 10.5130
      a = { letter: '', value: num(m[1]) };
      b = { letter: '', value: num(m[2]) };
    } else if ((m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*;\s*(-?\d+(?:[.,]\d+)?)$/))) { // 46,8419; 10,5130
      a = { letter: '', value: num(m[1]) };
      b = { letter: '', value: num(m[2]) };
    } else if ((m = s.match(/^(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)$/))) {      // 46.8419 10.5130
      a = { letter: '', value: num(m[1]) };
      b = { letter: '', value: num(m[2]) };
    } else {
      // Grad/Minuten/Sekunden oder Himmelsrichtungen: zwei Teile suchen
      s = s.replace(/\s*[,;]\s*/g, ' ');
      const parts = [];
      PART.lastIndex = 0;
      let mm;
      while ((mm = PART.exec(s)) !== null && parts.length < 2) {
        if (mm[0].trim() === '') { PART.lastIndex += 1; continue; }
        const p = parsePart(mm);
        if (p) parts.push(p);
      }
      if (parts.length !== 2) return null;
      [a, b] = parts;
    }
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;

    // Himmelsrichtungen entscheiden, was Breite und was Laenge ist (E/W/O = Laenge, N/S = Breite)
    const isLonLetter = (l) => l === 'E' || l === 'W' || l === 'O';
    let lat = a.value;
    let lon = b.value;
    if (isLonLetter(a.letter) || b.letter === 'N' || b.letter === 'S') { lat = b.value; lon = a.value; }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  /** Mehrere Koordinaten, eine pro Zeile; leere Zeilen werden ignoriert. Liefert { points, errors:[Zeilennummer] }. */
  function parseLines(text) {
    const points = [];
    const errors = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const p = parse(line);
      if (p) points.push(p); else errors.push(i + 1);
    });
    return { points, errors };
  }

  function format(p, digits = 6) {
    return `${p.lat.toFixed(digits)}, ${p.lon.toFixed(digits)}`;
  }

  /** Grad und Dezimalminuten, z.B. 46°50.514' N, 10°30.780' E */
  function formatDM(p) {
    const f = (v, pos, neg) => {
      const d = Math.floor(Math.abs(v));
      const min = (Math.abs(v) - d) * 60;
      return `${d}°${min.toFixed(3)}' ${v >= 0 ? pos : neg}`;
    };
    return `${f(p.lat, 'N', 'S')}, ${f(p.lon, 'E', 'W')}`;
  }

  return { parse, parseLines, format, formatDM };
}));
