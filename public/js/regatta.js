(() => {
  'use strict';

  const adminToken = localStorage.getItem('regatta-tracker:admin-token') || '';
  const $ = (id) => document.getElementById(id);
  if (!adminToken) { $('no-login').style.display = 'block'; return; }
  $('main').style.display = 'block';
  // Zusaetzlich per Cookie anmelden, damit Downloads (CSV) ohne Header funktionieren
  fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminToken }) }).catch(() => {});

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = ['DNS', 'DNF', 'DSQ', 'OCS', 'RET', 'DNC'];

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: { 'x-admin-token': adminToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { alert(e.message); } };

  const fmtDur = (s) => {
    if (s == null) return '–';
    const t = Math.round(s);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString('de-CH', { hour12: false }) : '–');
  // datetime-local <-> ms (lokale Zeit, sekundengenau)
  const toLocalInput = (ts) => {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 19);
  };
  const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

  let trackers = [];
  let regatta = { classes: [], boats: {}, line: null, races: [] };
  const lineDraft = { a: null, b: null, mark: null };
  const courseDraft = { marks: [], radiusM: 250, exact: false };
  let detectedMarks = [];   // von der Auswertung gefundene Bojen (blau)

  // ---------- Yardstick ----------
  function renderClasses() {
    $('ys-list').innerHTML = regatta.classes.length
      ? regatta.classes.map((c) => `<span class="badge" style="margin:2px">${esc(c.name)} ${c.yardstick}
          <a href="#" data-del="${c.id}" style="color:var(--danger);text-decoration:none">✕</a></span>`).join(' ')
      : 'Noch keine Klassen.';
    $('ys-list').querySelectorAll('[data-del]').forEach((a) => a.addEventListener('click', guard(async (e) => {
      e.preventDefault();
      await api(`/api/admin/classes/${a.dataset.del}`, 'DELETE');
      await load();
    })));
  }
  $('ys-import').addEventListener('click', guard(async () => {
    const r = await api('/api/admin/classes/import', 'POST', { text: $('ys-text').value, replace: $('ys-replace').checked });
    $('ys-msg').textContent = `${r.added} importiert` + (r.skipped.length ? `, ${r.skipped.length} uebersprungen (${r.skipped.slice(0, 3).join(' | ')})` : '');
    $('ys-text').value = '';
    await load();
  }));
  $('ys-add').addEventListener('click', guard(async () => {
    await api('/api/admin/classes', 'POST', { name: $('ys-name').value, yardstick: $('ys-num').value });
    $('ys-name').value = ''; $('ys-num').value = '';
    await load();
  }));

  // ---------- Boote ----------
  function renderBoats() {
    if (!trackers.length) { $('boats').innerHTML = '<p class="hint">Noch keine Tracker angelegt.</p>'; return; }
    const opts = (sel) => '<option value="">–</option>' + regatta.classes
      .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)} (${c.yardstick})</option>`).join('');
    $('boats').innerHTML = trackers.map((t) => {
      const b = regatta.boats[t.id] || {};
      return `<div class="row" data-id="${t.id}">
        <div style="min-width:130px;font-weight:600"><span class="boat-dot" style="display:inline-block;width:10px;height:10px;background:${t.color};margin-right:6px"></span>${esc(t.name)}</div>
        <div class="field"><label>Segelnr.</label><input type="text" class="sail" value="${esc(b.sailNo)}" style="width:90px" /></div>
        <div class="field"><label>Steuermann</label><input type="text" class="helm" value="${esc(b.helm)}" style="width:150px" /></div>
        <div class="field"><label>Klasse</label><select class="cls">${opts(b.classId)}</select></div>
        <button class="secondary save">Speichern</button>
        ${b.classId ? '<button class="danger unreg">Abmelden</button>' : ''}
      </div>`;
    }).join('');
    $('boats').querySelectorAll('.row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.save').addEventListener('click', guard(async () => {
        await api(`/api/admin/trackers/${id}/registration`, 'PUT', {
          sailNo: row.querySelector('.sail').value, helm: row.querySelector('.helm').value, classId: row.querySelector('.cls').value
        });
        await load();
      }));
      const un = row.querySelector('.unreg');
      if (un) un.addEventListener('click', guard(async () => { await api(`/api/admin/trackers/${id}/registration`, 'DELETE'); await load(); }));
    });
  }

  // ---------- Linie ----------
  const HAS_MAP = typeof L !== 'undefined';
  if (!HAS_MAP) $('line-map').innerHTML = '<p class="hint" style="padding:1rem">Karte nicht ladbar (kein Internet?). Linie kann trotzdem ueber Tracker-Positionen gesetzt werden.</p>';
  const map = HAS_MAP ? L.map('line-map') : { setView() { return this; }, on() {}, fitBounds() {} };
  const layer = HAS_MAP ? L.layerGroup() : { clearLayers() {} };
  if (HAS_MAP) {
    map.setView([47.0, 8.3], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    layer.addTo(map);
  }
  let picking = null;
  const LABEL = { a: 'Linie A (Startschiff)', b: 'Linie B (Pin)', mark: 'Referenz-Tonne (Kursseite)' };

  function drawLine() {
    layer.clearLayers();
    const pts = ['a', 'b', 'mark'].filter((k) => lineDraft[k]);
    if (!HAS_MAP) return;
    pts.forEach((k) => L.marker([lineDraft[k].lat, lineDraft[k].lon]).bindTooltip(LABEL[k], { permanent: true }).addTo(layer));
    if (lineDraft.a && lineDraft.b) {
      L.polyline([[lineDraft.a.lat, lineDraft.a.lon], [lineDraft.b.lat, lineDraft.b.lon]], { color: '#e6194b', weight: 4 }).addTo(layer);
    }
    courseDraft.marks.forEach((m, i) => {
      if (m.a) {
        L.polyline([[m.a.lat, m.a.lon], [m.b.lat, m.b.lon]], { color: '#f58231', weight: 4 }).addTo(layer);
        [m.a, m.b].forEach((q, j) => L.circleMarker([q.lat, q.lon], { radius: 7, color: '#f58231', fillOpacity: 0.8 })
          .bindTooltip(j === 0 ? `Tor ${i + 1}` : 'B', { permanent: j === 0, direction: 'top' }).addTo(layer));
      } else {
        L.circleMarker([m.lat, m.lon], { radius: 9, color: '#f58231', fillOpacity: 0.7 }).bindTooltip(`Boje ${i + 1}${courseDraft.exact ? '' : ' (grob)'}`, { permanent: true, direction: 'top' }).addTo(layer);
      }
    });
    const centers = courseDraft.marks.map((m) => (m.a ? { lat: (m.a.lat + m.b.lat) / 2, lon: (m.a.lon + m.b.lon) / 2 } : m));
    if (centers.length > 1) {
      L.polyline(centers.map((m) => [m.lat, m.lon]), { color: '#f58231', weight: 2, dashArray: '6 6' }).addTo(layer);
    }
    detectedMarks.filter((m) => !m.approx && !m.exact).forEach((m, i) => {
      L.circleMarker([m.lat, m.lon], { radius: 6, color: '#3ba7ff', fillOpacity: 0.9 }).bindTooltip(`erkannt (${m.n} Rundungen)`, { direction: 'bottom' }).addTo(layer);
    });
    const all = pts.map((k) => [lineDraft[k].lat, lineDraft[k].lon]).concat(courseDraft.marks.map((m) => (m.a ? [m.a.lat, m.a.lon] : [m.lat, m.lon])));
    if (all.length && !drawLine.fitted) { drawLine.fitted = true; map.fitBounds(all, { maxZoom: 17, padding: [30, 30] }); }
  }
  function renderLineControls() {
    const opts = '<option value="">Tracker-Position...</option>' + trackers
      .filter((t) => t.latest).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('line-controls').innerHTML = ['a', 'b', 'mark'].map((k) => `
      <div class="row" data-k="${k}">
        <div style="min-width:190px">${LABEL[k]}</div>
        <input type="text" class="coord line-c" value="${lineDraft[k] ? esc(Coords.format(lineDraft[k])) : ''}"
          placeholder="${k === 'mark' ? 'leer = erste Boje des Kurses' : '46.8419, 10.5130'}" style="min-width:250px;flex:1" />
        <button class="secondary pick">Auf Karte klicken</button>
        <select class="from-tracker">${opts}</select>
      </div>`).join('');
    $('line-controls').querySelectorAll('.row').forEach((row) => {
      const k = row.dataset.k;
      const input = row.querySelector('.line-c');
      input.addEventListener('change', () => {
        if (!input.value.trim()) { lineDraft[k] = null; input.style.borderColor = ''; drawLine(); return; }
        const c = Coords.parse(input.value);
        if (!c) { input.style.borderColor = 'var(--danger)'; $('line-msg').textContent = 'Koordinate nicht lesbar - Beispiele: 46.8419, 10.5130 oder 46°50.514\' N, 10°30.780\' E'; return; }
        input.style.borderColor = '';
        $('line-msg').textContent = '';
        lineDraft[k] = c;
        input.value = Coords.format(c);
        drawLine();
      });
      row.querySelector('.pick').addEventListener('click', () => { picking = k; $('line-msg').textContent = `Klick auf die Karte setzt: ${LABEL[k]}`; });
      row.querySelector('.from-tracker').addEventListener('change', (e) => {
        const t = trackers.find((x) => x.id === e.target.value);
        if (t && t.latest) { lineDraft[k] = { lat: t.latest.lat, lon: t.latest.lon }; renderLineControls(); drawLine(); }
      });
    });
  }
  map.on('click', (e) => {
    if (picking === 'course') {
      courseDraft.marks.push({ lat: e.latlng.lat, lon: e.latlng.lng });
      renderCourse(); drawLine();   // Modus bleibt aktiv: weitere Boje setzen, "Boje auf Karte setzen" nochmals klicken beendet ihn
      return;
    }
    if (!picking) return;
    lineDraft[picking] = { lat: e.latlng.lat, lon: e.latlng.lng };
    picking = null;
    $('line-msg').textContent = '';
    renderLineControls(); drawLine();
  });

  // ---------- Kurs (Bojen) ----------
  function renderCourse() {
    const list = $('course-list');
    const n = courseDraft.marks.length;
    const ctl = (i) => `
          <button class="secondary up" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
          <button class="secondary down" ${i === n - 1 ? 'disabled' : ''}>&darr;</button>
          <button class="danger del">&times;</button>`;
    list.innerHTML = n
      ? courseDraft.marks.map((m, i) => (m.a ? `
        <div class="row" data-i="${i}">
          <div style="min-width:70px"><b>Tor ${i + 1}</b></div>
          <input type="text" class="coord gate-c" data-end="a" value="${esc(Coords.format(m.a))}" style="min-width:210px;flex:1" />
          <input type="text" class="coord gate-c" data-end="b" value="${esc(Coords.format(m.b))}" style="min-width:210px;flex:1" />
          ${ctl(i)}
          <span class="hint">Durchfahrt zwischen A und B zaehlt</span>
        </div>` : `
        <div class="row" data-i="${i}">
          <div style="min-width:70px"><b>Boje ${i + 1}</b></div>
          <input type="text" class="coord course-c" value="${esc(Coords.format(m))}" style="min-width:250px;flex:1" />
          ${ctl(i)}
          <span class="hint">${esc(Coords.formatDM(m))}</span>
        </div>`)).join('')
      : '<p class="hint">Noch keine Boje.</p>';
    list.querySelectorAll('.row').forEach((row) => {
      const i = Number(row.dataset.i);
      const bad = (input, label) => { input.style.borderColor = 'var(--danger)'; $('course-msg').textContent = `${label}: Koordinate nicht lesbar.`; };
      const single = row.querySelector('.course-c');
      if (single) {
        single.addEventListener('change', () => {
          const c = Coords.parse(single.value);
          if (!c) return bad(single, `Boje ${i + 1}`);
          courseDraft.marks[i] = c; courseDraft.exact = true;
          $('course-msg').textContent = '';
          renderCourse(); drawLine();
        });
      }
      row.querySelectorAll('.gate-c').forEach((input) => {
        input.addEventListener('change', () => {
          const c = Coords.parse(input.value);
          if (!c) return bad(input, `Tor ${i + 1}`);
          courseDraft.marks[i] = { ...courseDraft.marks[i], [input.dataset.end]: c }; courseDraft.exact = true;
          $('course-msg').textContent = '';
          renderCourse(); drawLine();
        });
      });
      row.querySelector('.up').addEventListener('click', () => { [courseDraft.marks[i - 1], courseDraft.marks[i]] = [courseDraft.marks[i], courseDraft.marks[i - 1]]; renderCourse(); drawLine(); });
      row.querySelector('.down').addEventListener('click', () => { [courseDraft.marks[i + 1], courseDraft.marks[i]] = [courseDraft.marks[i], courseDraft.marks[i + 1]]; renderCourse(); drawLine(); });
      row.querySelector('.del').addEventListener('click', () => { courseDraft.marks.splice(i, 1); renderCourse(); drawLine(); });
    });
    $('course-radius').value = courseDraft.radiusM;
    $('course-exact').checked = courseDraft.exact;
    // Erkannte Bojen koennen uebernommen werden, wenn es genau so viele gibt wie gezeichnete (und kein Tor dabei ist)
    const found = detectedMarks.filter((m) => !m.approx && !m.exact);
    $('course-adopt').style.display = found.length && found.length === n && !courseDraft.marks.some((m) => m.a) ? '' : 'none';
  }
  $('gate-add').addEventListener('click', () => {
    const a = Coords.parse($('gate-a').value);
    const b = Coords.parse($('gate-b').value);
    if (!a || !b) { $('course-msg').textContent = 'Tor: beide Koordinaten (Marke A und B) eingeben - Beispiel: 46.8419, 10.5130'; return; }
    if (courseDraft.marks.length >= 20) { $('course-msg').textContent = 'Hoechstens 20 Eintraege.'; return; }
    courseDraft.marks.push({ a, b });
    courseDraft.exact = true;
    $('gate-a').value = ''; $('gate-b').value = '';
    $('course-msg').textContent = '';
    renderCourse(); drawLine();
  });
  $('course-coord-add').addEventListener('click', () => {
    const c = Coords.parse($('course-coord').value);
    if (!c) { $('course-msg').textContent = 'Koordinate nicht lesbar - Beispiele: 46.8419, 10.5130 oder 46°50.514\' N, 10°30.780\' E'; return; }
    if (courseDraft.marks.length >= 20) { $('course-msg').textContent = 'Hoechstens 20 Bojen.'; return; }
    courseDraft.marks.push(c);
    courseDraft.exact = true;         // von Hand eingegebene Koordinaten gelten als exakt (Haekchen kann entfernt werden)
    $('course-coord').value = '';
    $('course-msg').textContent = '';
    renderCourse(); drawLine();
  });
  $('course-coord').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('course-coord-add').click(); });
  $('course-bulk-btn').addEventListener('click', () => {
    const marks = [];
    const errors = [];
    $('course-bulk').value.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      if (line.includes('|')) {                       // Tor: "Marke A | Marke B"
        const [pa, pb] = line.split('|').map((x) => Coords.parse(x));
        if (pa && pb) marks.push({ a: pa, b: pb }); else errors.push(i + 1);
      } else {
        const c = Coords.parse(line);
        if (c) marks.push(c); else errors.push(i + 1);
      }
    });
    if (errors.length) { $('course-msg').textContent = `Zeile(n) nicht lesbar: ${errors.join(', ')}`; return; }
    if (!marks.length) { $('course-msg').textContent = 'Keine Koordinaten gefunden.'; return; }
    courseDraft.marks = marks.slice(0, 20);
    courseDraft.exact = true;
    $('course-bulk').value = '';
    $('course-msg').textContent = `${courseDraft.marks.length} Eintrag/Eintraege uebernommen - bitte pruefen und "Kurs speichern" klicken.`;
    renderCourse(); drawLine();
  });
  $('course-exact').addEventListener('change', () => { courseDraft.exact = $('course-exact').checked; });
  $('course-adopt').addEventListener('click', () => {
    const found = detectedMarks.filter((m) => !m.approx && !m.exact);
    courseDraft.marks = found.map((m) => ({ lat: m.lat, lon: m.lon }));
    courseDraft.exact = true;
    $('course-msg').textContent = 'Erkannte Positionen uebernommen - bitte pruefen und "Kurs speichern" klicken.';
    renderCourse(); drawLine();
  });
  $('course-add').addEventListener('click', () => {
    picking = picking === 'course' ? null : 'course';
    $('course-msg').textContent = picking === 'course' ? 'Klicke nacheinander auf die Karte: eine Boje pro Klick (Fahrtreihenfolge). Nochmals klicken beendet.' : '';
  });
  $('course-undo').addEventListener('click', () => { courseDraft.marks.pop(); renderCourse(); drawLine(); });
  $('course-clear').addEventListener('click', () => { courseDraft.marks = []; renderCourse(); drawLine(); });
  $('course-radius').addEventListener('change', () => { courseDraft.radiusM = parseFloat($('course-radius').value) || 250; });
  $('course-save').addEventListener('click', guard(async () => {
    courseDraft.radiusM = parseFloat($('course-radius').value) || 250;
    await api('/api/admin/course', 'PUT', { marks: courseDraft.marks.length ? courseDraft.marks : null, radiusM: courseDraft.radiusM, exact: courseDraft.exact });
    $('course-msg').textContent = courseDraft.marks.length ? 'Kurs gespeichert. Gilt fuer neue Wettfahrten bzw. nach "Linie & Kurs uebernehmen".' : 'Kurs geloescht.';
    await load();
  }));

  // Import: GPX oder GeoJSON -> Punkte; Strecken werden auf die Eckpunkte vereinfacht (Douglas-Peucker, 20 m)
  function simplify(points, epsM) {
    if (points.length < 3) return points;
    const k = Math.cos((points[0].lat * Math.PI) / 180);
    const xy = points.map((p) => ({ x: p.lon * 111320 * k, y: p.lat * 110574 }));
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0; let idx = -1;
      for (let i = a + 1; i < b; i += 1) {
        const dx = xy[b].x - xy[a].x; const dy = xy[b].y - xy[a].y;
        const len = Math.hypot(dx, dy) || 1;
        const d = Math.abs(dx * (xy[a].y - xy[i].y) - (xy[a].x - xy[i].x) * dy) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > epsM && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return points.filter((_, i) => keep[i]);
  }
  function parsePoints(text, name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.gpx') || text.trim().startsWith('<')) {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const pick = (sel) => [...doc.querySelectorAll(sel)].map((n) => ({ lat: parseFloat(n.getAttribute('lat')), lon: parseFloat(n.getAttribute('lon')) }));
      const rte = pick('rtept'); if (rte.length) return { points: rte, path: true };
      const trk = pick('trkpt'); if (trk.length) return { points: trk, path: true };
      return { points: pick('wpt'), path: false };
    }
    const gj = JSON.parse(text);
    const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ geometry: gj }];
    const line = []; const pts = [];
    for (const f of feats) {
      const g = f.geometry || {};
      if (g.type === 'LineString') g.coordinates.forEach((c) => line.push({ lat: c[1], lon: c[0] }));
      else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => l.forEach((c) => line.push({ lat: c[1], lon: c[0] })));
      else if (g.type === 'Point') pts.push({ lat: g.coordinates[1], lon: g.coordinates[0] });
      else if (g.type === 'MultiPoint') g.coordinates.forEach((c) => pts.push({ lat: c[1], lon: c[0] }));
    }
    return line.length ? { points: line, path: true } : { points: pts, path: false };
  }
  $('course-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { points, path } = parsePoints(await file.text(), file.name);
      let marks = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (path) {
        marks = simplify(marks, 20);
        if ($('course-trim').checked && marks.length > 2) marks = marks.slice(1, -1);
      }
      if (!marks.length) throw new Error('Keine Punkte gefunden');
      courseDraft.marks = marks.slice(0, 20);
      renderCourse(); drawLine();
      $('course-msg').textContent = `${courseDraft.marks.length} Boje(n) aus der Datei uebernommen - bitte pruefen und "Kurs speichern" klicken.`;
    } catch (err) {
      $('course-msg').textContent = `Import fehlgeschlagen: ${err.message}`;
    }
    e.target.value = '';
  });
  $('line-save').addEventListener('click', guard(async () => {
    // Ohne eigene Referenz-Tonne bestimmt die erste Boje des Kurses die Kursseite
    const payload = { a: lineDraft.a, b: lineDraft.b, mark: lineDraft.mark || courseDraft.marks[0] };
    await api('/api/admin/line', 'PUT', payload);
    $('line-msg').textContent = 'Gespeichert. Gilt fuer Wettfahrten ab dem naechsten Start.' + (lineDraft.mark ? '' : ' (Kursseite = erste Boje des Kurses)');
    await load();
  }));

  // ---------- Wettfahrten ----------
  $('race-create').addEventListener('click', guard(async () => {
    const startTs = fromLocalInput($('race-start').value);
    await api('/api/admin/races', 'POST', {
      name: $('race-name').value, laps: $('race-laps').value, cutoffMinutes: $('race-cutoff').value, lapMode: $('race-mode').value, startOnExtension: $('race-ext').checked, startTs: startTs || undefined
    });
    $('race-name').value = '';
    $('race-start').value = '';
    await load();
  }));

  let results = {};
  const openRows = new Set(); // aufgeklappte Korrektur-Formulare bleiben beim Auto-Refresh offen

  function raceCard(r) {
    const res = results[r.id];
    const started = r.startTs != null;
    const head = `
      <div class="row">
        <div style="font-weight:700;font-size:1.05rem">${esc(r.name)}</div>
        <span class="badge">${r.laps} Runden</span>
        ${r.official ? '<span class="badge official">OFFIZIELL</span>' : '<span class="badge warn">vorlaeufig</span>'}
        ${started ? `<span class="badge">Start ${fmtClock(r.startTs)}</span>` : '<span class="badge">nicht gestartet</span>'}
      </div>`;
    const controls = r.official ? '' : `
      <div class="row">
        <button class="start-now">Startsignal JETZT</button>
        <div class="field"><label>oder Startzeit (sekundengenau)</label>
          <input type="datetime-local" step="1" class="start-at" value="${started ? toLocalInput(r.startTs) : ''}" /></div>
        <button class="secondary start-set">Startzeit setzen</button>
        ${started ? '<button class="secondary start-clear">Start loeschen</button>' : ''}
        <button class="danger race-del">Wettfahrt loeschen</button>
      </div>`;
    const settings = r.official ? '' : `
      <div class="row">
        <div class="field"><label>Runden</label><input type="number" class="rc-laps" min="1" max="10" value="${r.laps}" style="width:70px" /></div>
        <div class="field"><label>Zielschluss (Min. nach Start)</label><input type="number" class="rc-cutoff" min="10" max="1440" value="${r.cutoffMinutes}" style="width:90px" /></div>
        <div class="field"><label>Linie pro Runde</label>
          <select class="rc-mode" style="width:auto"><option value="bounce" ${r.lapMode === 'loop' ? '' : 'selected'}>2x kreuzen (hin/zurueck)</option>
            <option value="loop" ${r.lapMode === 'loop' ? 'selected' : ''}>1x, gleiche Richtung (Rundkurs)</option></select></div>
        <label style="margin:0"><input type="checkbox" class="rc-ext" ${r.startOnExtension === false ? '' : 'checked'} /> Start der 1. Runde auch in der Verlaengerung der Linie</label>
        <button class="secondary rc-save">Speichern</button>
        <button class="secondary rc-geo" title="Setzt Linie und Kurs dieser Wettfahrt auf die aktuell gespeicherten Werte">Linie &amp; Kurs aktuell uebernehmen</button>
        ${r.hasLine ? '' : '<span class="warn-text">keine Linie gespeichert</span>'}
        ${r.hasCourse ? '' : '<span class="warn-text">kein Kurs: keine Live-Rangliste</span>'}
      </div>`;
    const links = started ? `<div class="row" style="margin-top:0.4rem"><span class="hint">Positionen dieser Wettfahrt:</span>
        <a href="/api/admin/export/tracks.csv?race=${r.id}" style="color:var(--accent)">CSV</a>
        <a href="/api/admin/export/tracks.gpx?race=${r.id}" style="color:var(--accent)">GPX</a>
        <a href="/live.html?race=${r.id}" style="color:var(--accent)">Live-Rangliste</a></div>` : '';
    let table = '';
    if (res && res.entries.length) {
      table = `<table class="results"><thead><tr><th>Rang</th><th>Boot</th><th>Klasse / YS</th><th>Status</th>
        <th>Runden</th><th>Gesegelt</th><th>Berechnet</th><th></th></tr></thead><tbody>
        ${res.entries.map((e) => entryRows(r, e)).join('')}</tbody></table>`;
    } else if (started) {
      table = '<p class="hint">Keine registrierten Boote.</p>';
    }
    const footer = `<div class="row" style="margin-top:0.6rem">
        ${started ? `<button class="${r.official ? 'secondary' : ''} official-toggle">${r.official ? 'Freigabe zuruecknehmen' : 'Ergebnis offiziell freigeben'}</button>
        <a href="/api/races/${r.id}/results.csv" style="color:var(--accent)">CSV</a>` : ''}
      </div>`;
    return `<div class="card" data-race="${r.id}" style="background:var(--panel-2)">${head}${controls}${settings}${table}${footer}${links}</div>`;
  }

  function entryRows(r, e) {
    const unc = e.uncertaintyMs != null ? ` ±${(e.uncertaintyMs / 2000).toFixed(1)}s` : '';
    const key = `${r.id}:${e.trackerId}`;
    const lapTxt = e.laps.length ? e.laps.map((l) => fmtDur(l.lapSeconds)).join(' / ') : '–';
    const warn = e.warnings.length ? `<div class="warn-text">${e.warnings.map(esc).join('<br>')}</div>` : '';
    const note = e.note ? `<div class="hint">${esc(e.note)}</div>` : '';
    const edit = r.official ? '' : `<a href="#" class="edit" data-key="${key}" style="color:var(--accent)">korrigieren</a>`;
    const ov = r.overrides[e.trackerId] || {};
    const form = openRows.has(key) && !r.official ? `<tr><td colspan="8"><div class="row" data-t="${e.trackerId}">
        <div class="field"><label>Status</label><select class="ov-status"><option value="">(automatisch)</option>
          ${STATUS.map((s) => `<option ${ov.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Zielzeit manuell</label><input type="datetime-local" step="1" class="ov-finish" value="${ov.finishTs ? toLocalInput(ov.finishTs) : ''}" /></div>
        <div class="field"><label>Zeitstrafe (s, auf berechnete Zeit)</label><input type="number" class="ov-pen" min="0" value="${ov.penaltySec || ''}" style="width:90px" /></div>
        <div class="field"><label>Bemerkung</label><input type="text" class="ov-note" value="${esc(ov.note)}" /></div>
        <button class="ov-save">Speichern</button></div></td></tr>` : '';
    return `<tr>
      <td class="num"><b>${e.rank ?? ''}</b></td>
      <td>${esc(e.sailNo)} ${esc(e.name)}<div class="hint">${esc(e.helm)}</div>${warn}${note}</td>
      <td>${esc(e.className)} / ${e.yardstick}</td>
      <td><span class="badge">${e.status}</span></td>
      <td class="num hint">${lapTxt}</td>
      <td class="num">${fmtDur(e.elapsedSec)}<span class="hint">${unc}</span></td>
      <td class="num"><b>${fmtDur(e.correctedSec)}</b>${e.penaltySec ? `<div class="hint">+${e.penaltySec}s Strafe</div>` : ''}</td>
      <td>${edit}</td></tr>${form}`;
  }

  function renderRaces() {
    $('races').innerHTML = regatta.races.length ? regatta.races.slice().reverse().map(raceCard).join('') : '<p class="hint">Noch keine Wettfahrt.</p>';
    $('races').querySelectorAll('[data-race]').forEach((card) => {
      const id = card.dataset.race;
      const on = (sel, fn) => { const el = card.querySelector(sel); if (el) el.addEventListener('click', guard(fn)); };
      on('.start-now', async () => { await api(`/api/admin/races/${id}/start`, 'POST', {}); await load(); });
      on('.start-set', async () => {
        const ts = fromLocalInput(card.querySelector('.start-at').value);
        if (!ts) throw new Error('Startzeit waehlen');
        await api(`/api/admin/races/${id}/start`, 'POST', { ts }); await load();
      });
      on('.start-clear', async () => { await api(`/api/admin/races/${id}/clear-start`, 'POST'); await load(); });
      on('.rc-save', async () => {
        await api(`/api/admin/races/${id}`, 'PATCH', { laps: card.querySelector('.rc-laps').value, cutoffMinutes: card.querySelector('.rc-cutoff').value, lapMode: card.querySelector('.rc-mode').value, startOnExtension: card.querySelector('.rc-ext').checked });
        await load();
      });
      on('.rc-geo', async () => {
        if (!confirm('Linie und Kurs dieser Wettfahrt auf die aktuell gespeicherten Werte setzen?')) return;
        await api(`/api/admin/races/${id}/apply-geometry`, 'POST', {});
        await load();
      });
      on('.race-del', async () => { if (confirm('Wettfahrt wirklich loeschen?')) { await api(`/api/admin/races/${id}`, 'DELETE'); await load(); } });
      on('.official-toggle', async () => {
        const r = regatta.races.find((x) => x.id === id);
        if (!r.official && !confirm('Ergebnis offiziell freigeben? Danach ist es gesperrt.')) return;
        await api(`/api/admin/races/${id}/official`, 'POST', { official: !r.official }); await load();
      });
      card.querySelectorAll('.edit').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        openRows.has(a.dataset.key) ? openRows.delete(a.dataset.key) : openRows.add(a.dataset.key);
        renderRaces();
      }));
      card.querySelectorAll('.ov-save').forEach((b) => b.addEventListener('click', guard(async () => {
        const row = b.closest('.row');
        await api(`/api/admin/races/${id}/override/${row.dataset.t}`, 'PUT', {
          status: row.querySelector('.ov-status').value || undefined,
          finishTs: fromLocalInput(row.querySelector('.ov-finish').value) || undefined,
          penaltySec: parseFloat(row.querySelector('.ov-pen').value) || undefined,
          note: row.querySelector('.ov-note').value || undefined
        });
        openRows.delete(`${id}:${row.dataset.t}`);
        await load();
      })));
    });
  }

  async function load() {
    const [tr, rg] = await Promise.all([api('/api/trackers'), api('/api/regatta')]);
    trackers = tr.trackers;
    regatta = rg;
    results = {};
    await Promise.all(regatta.races.filter((r) => r.startTs != null).map(async (r) => {
      results[r.id] = await api(`/api/races/${r.id}/results`);
    }));
    renderClasses(); renderBoats(); renderRaces();
    await loadHistory();
    await loadDetectedMarks();
  }

  // ---------- Aufzeichnungen und Export ----------
  const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString('de-CH', { hour12: false }) : '–');
  async function loadHistory() {
    const h = await api('/api/admin/history/summary');
    $('history').innerHTML = h.trackers.length
      ? `<table class="results"><thead><tr><th>Boot</th><th>LoRa-Nr</th><th>Positionen</th><th>Erste</th><th>Letzte</th></tr></thead><tbody>
          ${h.trackers.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.loraId ?? ''}</td><td class="num">${t.count}</td>
            <td class="num">${fmtDateTime(t.firstTs)}</td><td class="num">${fmtDateTime(t.lastTs)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="hint">Noch keine Tracker.</p>';
  }
  function exportLinks() {
    const q = new URLSearchParams();
    const f = fromLocalInput($('ex-from').value);
    const t = fromLocalInput($('ex-to').value);
    if (f) q.set('from', f);
    if (t) q.set('to', t);
    const qs = q.toString() ? `?${q}` : '';
    $('ex-csv').href = `/api/admin/export/tracks.csv${qs}`;
    $('ex-gpx').href = `/api/admin/export/tracks.gpx${qs}`;
  }
  $('ex-from').addEventListener('change', exportLinks);
  $('ex-to').addEventListener('change', exportLinks);
  exportLinks();

  // Bojen, die das System aus den Logs der zuletzt gestarteten Wettfahrt mit Kurs erkannt hat (blau auf der Karte)
  async function loadDetectedMarks() {
    const race = regatta.races.filter((r) => r.startTs != null && r.hasCourse).sort((a, b) => b.startTs - a.startTs)[0];
    detectedMarks = [];
    if (race) {
      try { detectedMarks = (await api(`/api/races/${race.id}/live`)).marks || []; } catch { /* keine Daten */ }
    }
    drawLine();
  }

  let firstLoad = true;
  load().then(() => {
    if (regatta.line) Object.assign(lineDraft, regatta.line);
    if (regatta.course) { courseDraft.marks = regatta.course.marks.slice(); courseDraft.radiusM = regatta.course.radiusM; courseDraft.exact = !!regatta.course.exact; }
    renderLineControls(); renderCourse(); drawLine();
    firstLoad = false;
  }).catch((e) => alert(e.message));
  // Auto-Refresh der Ergebnisse (nicht waehrend ein Korrektur-Formular offen ist)
  setInterval(() => { if (!firstLoad && !openRows.size && !document.activeElement.closest('#races')) load().catch(() => {}); }, 10000);
})();
