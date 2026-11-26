(() => {
  'use strict';

  const map = L.map('map', { zoomControl: true }).setView([47.0, 8.3], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap Mitwirkende'
  }).addTo(map);

  const boatListEl = document.getElementById('boat-list');
  const MAX_CLIENT_TRAIL = 600; // so viele Spurpunkte pro Boot haelt der Browser hoechstens

  /** id -> { marker, line, data, trail, full } ; full = ganze Spur aus der Historie (nur im Modus "Ganze Spur anzeigen") */
  const boats = new Map();
  const MAX_FULL_TRAIL = 20000;   // Obergrenze, falls der Browser lange offen bleibt und live weitere Punkte anhaengt
  // Standard: ganze Spur an (die Wahl wird pro Browser gemerkt)
  let fullTrack = true;
  try { fullTrack = localStorage.getItem('fullTrack') !== '0'; } catch (e) { /* Standard an */ }
  let hasFitOnce = false;

  function fmtAge(ts) {
    if (!ts) return 'nie';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `vor ${s}s`;
    if (s < 3600) return `vor ${Math.round(s / 60)}min`;
    return `vor ${Math.round(s / 3600)}h`;
  }

  function fmtSpeed(mps) {
    if (mps == null) return '–';
    return `${(mps * 1.94384).toFixed(1)} kn`;
  }

  function boatIcon(color, stale) {
    return L.divIcon({
      className: '',
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:${color};
        border:2px solid ${stale ? '#888' : '#fff'};
        opacity:${stale ? 0.55 : 1};
        box-shadow:0 0 0 2px rgba(0,0,0,0.35);
      "></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
  }

  function upsertBoat(t) {
    const latest = t.latest;
    let entry = boats.get(t.id);

    if (!entry) {
      entry = { marker: null, line: null, data: t, trail: [], full: null, fullInfo: null };
      boats.set(t.id, entry);
    }
    entry.data = t;

    if (!latest) {
      renderList();
      return;
    }

    const latlng = [latest.lat, latest.lon];

    if (!entry.marker) {
      entry.marker = L.marker(latlng, { icon: boatIcon(t.color, t.stale) })
        .addTo(map)
        .bindTooltip(t.name, { permanent: true, direction: 'right', offset: [10, 0], className: 'boat-label' });
      entry.line = L.polyline([], { color: t.color, weight: 3, opacity: 0.7 }).addTo(map);
    } else {
      entry.marker.setLatLng(latlng);
      entry.marker.setIcon(boatIcon(t.color, t.stale));
      entry.marker.setTooltipContent(t.name);
    }

    // Spur: komplette (ausgeduennte) Spur beim Laden, danach haengt der Browser jede neue Position selbst an.
    if (Array.isArray(t.trail)) {
      entry.trail = t.trail.slice();
    } else {
      const last = entry.trail[entry.trail.length - 1];
      // GPS-Rauschen im Stillstand nicht in die Spur zeichnen (Tempo ~0, Position springt wenige Meter)
      const still = last && Number.isFinite(latest.speed) && latest.speed < 0.5 && Number.isFinite(last.speed) && last.speed < 0.5
        && Math.hypot((latest.lon - last.lon) * 111320 * Math.cos((last.lat * Math.PI) / 180), (latest.lat - last.lat) * 110574) < 30;
      if ((!last || latest.ts > last.ts) && !still) entry.trail.push(latest);
      if (entry.trail.length > MAX_CLIENT_TRAIL) entry.trail.splice(0, entry.trail.length - MAX_CLIENT_TRAIL);
    }
    if (fullTrack) {
      if (!entry.full) loadFullTrack(entry);
      else {
        const lastF = entry.full[entry.full.length - 1];
        if (!lastF || latest.ts > lastF.ts) entry.full.push(latest);
        if (entry.full.length > MAX_FULL_TRAIL) entry.full.splice(0, entry.full.length - MAX_FULL_TRAIL);
      }
    }
    redrawLine(entry);

    if (!hasFitOnce) {
      hasFitOnce = true;
      map.setView(latlng, 14);
    }

    renderList();
  }

  // ---- Ganze Spur aus der Historie (zum Testen, 17.11.2026) ----
  const fullTrackEl = document.getElementById('full-track');
  if (fullTrackEl) fullTrackEl.checked = fullTrack;
  const trackRangeEl = document.getElementById('track-range');
  const trackInfoEl = document.getElementById('track-info');

  // Nur die Darstellung wird geglaettet; Zeitnahme und Daten bleiben unveraendert.
  const smoothEl = document.getElementById('smooth-track');
  let smoothOn = true;
  try { smoothOn = localStorage.getItem('smoothTrack') !== '0'; } catch (e) { /* ohne Speicher: Standard an */ }
  if (smoothEl) smoothEl.checked = smoothOn;

  /**
   * Spur fuer die Anzeige glaetten: (1) Punkte, die weniger als MIN_STEP_M vom letzten behaltenen liegen, entfallen (GPS-Zittern im Stand,
   * Kreisel beim Warten); (2) Eckenschneiden nach Chaikin (2 Durchgaenge) rundet die Zickzacks. Anfangs- und Endpunkt bleiben exakt.
   */
  const MIN_STEP_M = 3;
  function smoothTrack(pts) {
    if (pts.length < 3) return pts.map((p) => [p.lat, p.lon]);
    const k = Math.cos((pts[0].lat * Math.PI) / 180);
    const dist = (a, b) => Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * k);
    const kept = [pts[0]];
    for (let i = 1; i < pts.length - 1; i += 1) if (dist(kept[kept.length - 1], pts[i]) >= MIN_STEP_M) kept.push(pts[i]);
    kept.push(pts[pts.length - 1]);
    let line = kept.map((p) => [p.lat, p.lon]);
    for (let it = 0; it < 2 && line.length > 2; it += 1) {
      const out = [line[0]];
      for (let i = 0; i < line.length - 1; i += 1) {
        const [a, b] = [line[i], line[i + 1]];
        out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      out.push(line[line.length - 1]);
      line = out;
    }
    return line;
  }

  function redrawLine(entry) {
    if (!entry.line) return;
    const pts = fullTrack && entry.full ? entry.full : entry.trail;
    entry.line.setLatLngs(smoothOn ? smoothTrack(pts) : pts.map((p) => [p.lat, p.lon]));
  }
  if (smoothEl) smoothEl.addEventListener('change', () => {
    smoothOn = smoothEl.checked;
    try { localStorage.setItem('smoothTrack', smoothOn ? '1' : '0'); } catch (e) { /* egal */ }
    for (const entry of boats.values()) redrawLine(entry);
  });

  function fmtClock(ts) {
    return new Date(ts).toLocaleString('de-CH', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderTrackInfo() {
    if (!trackInfoEl) return;
    if (!fullTrack) { trackInfoEl.textContent = ''; return; }
    const lines = [];
    for (const entry of boats.values()) {
      const i = entry.fullInfo;
      if (!i) { lines.push(`${entry.data.name}: laedt ...`); continue; }
      lines.push(i.total ? `${entry.data.name}: ${i.total} Punkte, ${fmtClock(i.from)} bis ${fmtClock(i.to)}${i.shown < i.total ? ` (angezeigt ${i.shown})` : ''}` : `${entry.data.name}: keine Daten`);
    }
    trackInfoEl.innerHTML = lines.map((l) => l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))).join('<br>');
  }

  async function loadFullTrack(entry) {
    entry.fullInfo = null;
    try {
      const res = await fetch(`/api/trackers/${encodeURIComponent(entry.data.id)}/track?mode=${trackRangeEl.value}&hours=24&max=3000`);
      if (res.status === 401) { location.replace('/login.html?next=/index.html'); return; }
      const data = await res.json();
      if (!fullTrack) return;   // zwischenzeitlich wieder ausgeschaltet
      entry.full = data.points || [];
      entry.fullInfo = { total: data.total, shown: data.shown, from: data.from, to: data.to };
      redrawLine(entry);
    } catch (err) {
      console.error('Ganze Spur nicht geladen', err);
      entry.full = null;
    }
    renderTrackInfo();
  }

  async function applyFullTrackMode() {
    fullTrack = !!(fullTrackEl && fullTrackEl.checked);
    try { localStorage.setItem('fullTrack', fullTrack ? '1' : '0'); } catch (e) { /* egal */ }
    for (const entry of boats.values()) entry.full = null;
    if (!fullTrack) { for (const entry of boats.values()) redrawLine(entry); renderTrackInfo(); return; }
    renderTrackInfo();
    await Promise.all([...boats.values()].map(loadFullTrack));
  }
  if (fullTrackEl) fullTrackEl.addEventListener('change', applyFullTrackMode);
  if (trackRangeEl) trackRangeEl.addEventListener('change', () => { if (fullTrack) applyFullTrackMode(); });

  function removeBoat(id) {
    const entry = boats.get(id);
    if (entry) {
      if (entry.marker) map.removeLayer(entry.marker);
      if (entry.line) map.removeLayer(entry.line);
      boats.delete(id);
    }
    renderList();
  }

  function gpsStateText(st) {
    if (!st || st.gpsState == null) return '';
    const names = ['GPS-Modul stumm', 'keine Satelliten', 'Suche', 'Fix da, GPS-Zeit wird noch abgeglichen'];
    return ` (${names[st.gpsState] || '?'}${st.sats ? `, ${st.sats} Sat.` : ''})`;
  }

  function renderList() {
    const items = [...boats.values()].sort((a, b) => a.data.name.localeCompare(b.data.name));
    if (items.length === 0) {
      boatListEl.innerHTML = '<p class="empty-state">Noch keine Tracker aktiv.</p>';
      return;
    }
    const total = items.length;
    const onlineCount = items.filter(({ data: t }) => t.online).length;
    const withFix = items.filter(({ data: t }) => t.online && !t.noFix && !t.stale).length;
    const summary = `<div class="hint" style="margin-bottom:0.5rem"><b>${onlineCount} von ${total}</b> Trackern online · ${withFix} mit GPS-Fix</div>`;
    const sumEl = document.getElementById('sidebar-summary');
    if (sumEl) sumEl.textContent = `${onlineCount} von ${total} Trackern online`;
    boatListEl.innerHTML = summary + items.map(({ data: t }) => `
      <div class="boat-card ${t.stale ? 'stale' : ''}" data-id="${t.id}">
        <div class="boat-dot" style="background:${t.color}"></div>
        <div class="boat-info">
          <div class="boat-name">${escapeHtml(t.name)}</div>
          <div class="boat-meta">
            ${t.noFix ? `online, kein GPS-Fix${gpsStateText(t.status)}${t.status && t.status.battery != null ? ` · Akku ${Math.round(t.status.battery * 100)}%` : ''}${t.latest ? ` · letzte Position ${fmtAge(t.latest.ts)}` : ''}`
              : t.latest ? `${fmtAge(t.latest.ts)} · ${fmtSpeed(t.latest.speed)}${t.online ? '' : ' · offline'}` : (t.online ? 'online, noch keine Position' : 'offline')}
          </div>
        </div>
      </div>
    `).join('');

    boatListEl.querySelectorAll('.boat-card').forEach((el) => {
      el.addEventListener('click', () => {
        const entry = boats.get(el.dataset.id);
        if (entry && entry.marker) map.setView(entry.marker.getLatLng(), 15);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Kleine Statusmeldung des Servers: nur Online/Offline je Boot
  function applyStatus(staleMap, onlineMap) {
    for (const [id, online] of Object.entries(onlineMap || {})) {
      const e = boats.get(id);
      if (e) e.data.online = online;
    }
    for (const [id, stale] of Object.entries(staleMap || {})) {
      const entry = boats.get(id);
      if (!entry || entry.data.stale === stale) continue;
      entry.data.stale = stale;
      if (entry.marker && entry.data.latest) entry.marker.setIcon(boatIcon(entry.data.color, stale));
    }
    renderList();
  }

  function applySnapshot(trackers) {
    const ids = new Set(trackers.map((t) => t.id));
    for (const id of [...boats.keys()]) {
      if (!ids.has(id)) removeBoat(id);
    }
    trackers.forEach(upsertBoat);
  }

  // ---- Wettfahrtkurs auf der Karte (Start-/Ziellinie, Bojen, Tore des aktiven Kurses) ----
  const courseEl = document.getElementById('show-course');
  const courseLayer = L.layerGroup().addTo(map);
  let showCourse = true;
  let courseBounds = [];
  const zoomBtn = document.getElementById('zoom-course');
  if (zoomBtn) zoomBtn.addEventListener('click', async () => {
    if (!courseBounds.length) await drawCourse();
    if (courseBounds.length) map.fitBounds(courseBounds, { maxZoom: 16, padding: [30, 30] });
    else zoomBtn.textContent = 'Kein Kurs aufgeschaltet';
  });
  try { showCourse = localStorage.getItem('showCourse') !== '0'; } catch (e) { /* Standard: an */ }
  if (courseEl) courseEl.checked = showCourse;
  const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const SIDE_TXT = { port: ' (Backbord)', starboard: ' (Steuerbord)' };
  async function drawCourse() {
    courseLayer.clearLayers();
    if (!showCourse) return;
    let reg;
    try {
      const res = await fetch('/api/regatta');
      if (res.status === 401) return;
      reg = await res.json();
    } catch (err) { return; }
    courseBounds = [];
    const live = reg.liveCourse;                   // nur der von der Wettfahrtleitung aufgeschaltete Kurs
    const statusEl = document.getElementById('course-status');
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
    if (!live) { setStatus('Kein Kurs aufgeschaltet (die Wettfahrtleitung schaltet ihn auf).'); return; }
    if (!(live.line && live.line.a) && !(live.marks && live.marks.length)) { setStatus(`Kurs "${live.name}" ist aufgeschaltet, hat aber noch keine Linie und keine Bojen.`); return; }
    setStatus(`Aufgeschaltet: ${live.name} (${live.line ? 'Linie' : 'ohne Linie'}, ${(live.marks || []).length} Boje(n)/Tor(e))`);
    const ll = (q) => [q.lat, q.lon];
    const line = live.line;
    if (line && line.a && line.b) {
      L.polyline([ll(line.a), ll(line.b)], { color: '#e6194b', weight: 4 }).bindTooltip('Start' + (reg.finishLine ? '' : ' / Ziel'), { permanent: true, direction: 'top' }).addTo(courseLayer);
    }
    const f = live.finishLine;
    if (f && f.a && f.b) L.polyline([ll(f.a), ll(f.b)], { color: '#3cb44b', weight: 4 }).bindTooltip('Ziel', { permanent: true, direction: 'bottom' }).addTo(courseLayer);
    const marks = live.marks || [];
    const centers = [];
    marks.forEach((m, i) => {
      if (m.a && m.b) {
        L.polyline([ll(m.a), ll(m.b)], { color: '#f58231', weight: 4 }).addTo(courseLayer);
        L.circleMarker(ll(m.a), { radius: 6, color: '#f58231', fillOpacity: 0.8 }).bindTooltip(`Tor ${i + 1}`, { permanent: true, direction: 'top' }).addTo(courseLayer);
        L.circleMarker(ll(m.b), { radius: 6, color: '#f58231', fillOpacity: 0.8 }).addTo(courseLayer);
        centers.push([(m.a.lat + m.b.lat) / 2, (m.a.lon + m.b.lon) / 2]);
      } else {
        L.circleMarker(ll(m), { radius: 9, color: '#f58231', fillOpacity: 0.7 }).bindTooltip(escHtml(`Boje ${i + 1}${SIDE_TXT[m.rounding] || ''}`), { permanent: true, direction: 'top' }).addTo(courseLayer);
        centers.push(ll(m));
      }
    });
    if (centers.length > 1) L.polyline(centers, { color: '#f58231', weight: 2, dashArray: '6 6', opacity: 0.8 }).addTo(courseLayer);
    // Punkte des Kurses merken (fuer den Knopf "Zum Kurs zoomen"); beim ersten Laden auf den Kurs zoomen, falls noch kein Boot die Karte bestimmt hat
    courseBounds = [line && line.a, line && line.b, f && f.a, f && f.b, ...marks.flatMap((m) => (m.a ? [m.a, m.b] : [m]))].filter(Boolean).map(ll);
    if (!drawCourse.fitted && !boats.size && courseBounds.length) {
      drawCourse.fitted = true;
      map.fitBounds(courseBounds, { maxZoom: 16, padding: [30, 30] });
    }
  }
  if (courseEl) courseEl.addEventListener('change', () => {
    showCourse = courseEl.checked;
    try { localStorage.setItem('showCourse', showCourse ? '1' : '0'); } catch (e) { /* egal */ }
    drawCourse();
  });
  drawCourse();
  setInterval(drawCourse, 30000);

  // ---- Ranglisten-Overlay auf der Karte: die ersten 5 Boote nach berechneter Zeit (Yardstick) der laufenden bzw. letzten Wettfahrt ----
  const rankToggleEl = document.getElementById('show-rank');
  let showRank = true;
  let rankCollapsed = false;
  try { showRank = localStorage.getItem('showRank') !== '0'; rankCollapsed = localStorage.getItem('rankCollapsed') === '1'; } catch (e) { /* Standard: an */ }
  if (rankToggleEl) rankToggleEl.checked = showRank;
  const rankBox = document.createElement('div');
  rankBox.id = 'rank-overlay';
  rankBox.style.display = 'none';
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.appendChild(rankBox);
  rankBox.addEventListener('click', (ev) => {                         // Klick auf die Ueberschrift klappt die Liste ein/aus
    if (!ev.target.closest('.rank-head')) return;
    rankCollapsed = !rankCollapsed;
    try { localStorage.setItem('rankCollapsed', rankCollapsed ? '1' : '0'); } catch (e) { /* egal */ }
    rankBox.classList.toggle('collapsed', rankCollapsed);
  });
  ['mousedown', 'dblclick', 'wheel', 'touchstart'].forEach((n) => rankBox.addEventListener(n, (ev) => ev.stopPropagation()));
  const fmtRankTime = (s) => {
    if (s == null || !Number.isFinite(s)) return '–';
    const t = Math.round(s);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const fmtRankGap = (s) => {
    const t = Math.round(Math.abs(s));
    return `+${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  let lastLive = null;          // zuletzt geladene Live-Rangliste (fuer Neuzeichnen beim Klick)
  let selectedRankId = null;    // Boot, dessen Details gezeigt werden
  const fmtDist = (m) => (m == null ? '–' : m >= 1000 ? `${(m / 1000).toFixed(2).replace('.', ',')} km` : `${Math.round(m)} m`);
  const fmtKn = (v) => (v == null ? '–' : `${v.toFixed(1).replace('.', ',')} kn`);
  const fmtGapSec = (s) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.round(Math.abs(s)) % 60).padStart(2, '0')}`;

  /** Detailblock zu einem Boot: Tempo, Kurs, VMG, naechste Boje, Boot davor/dahinter. */
  function rankDetailHtml(e) {
    const rows = [];
    const row = (k, v) => rows.push(`<div class="rank-kv"><span>${k}</span><b>${v}</b></div>`);
    const name = escHtml([e.sailNo, e.name].filter(Boolean).join(' '));
    if (e.status === 'FIN') {
      row('Gesegelt', fmtRankTime(e.elapsedSec));
      row('Berechnet (Yardstick)', fmtRankTime(e.correctedSec));
    } else {
      row('Geschwindigkeit', fmtKn(e.speedKn));
      row('Kurs', e.headingDeg != null ? `${e.headingDeg}°` : '–');
      if (e.nextMark) {
        row(`Naechste: ${escHtml(e.nextMark.label)}`, `${fmtDist(e.nextMark.distM)} · Peilung ${e.nextMark.bearingDeg}°`);
        row('VMG zur Marke', e.vmgKn != null ? `${fmtKn(e.vmgKn)}${e.vmgKn < 0 ? ' (faehrt weg)' : ''}` : '–');
      }
      row('Fortschritt', `${Math.round(e.progressPct || 0)} % · Runde ${e.lapNow}`);
      if (e.elapsedSec != null) row('Zeit seit Start', fmtRankTime(e.elapsedSec));
      row('Vor mir (Kurs)', e.ahead ? `${escHtml(e.ahead.name)} · ${fmtDist(e.ahead.courseM)} (Luftlinie ${fmtDist(e.ahead.directM)})` : 'niemand – ich fuehre');
      row('Hinter mir (Kurs)', e.behind ? `${escHtml(e.behind.name)} · ${fmtDist(e.behind.courseM)} (Luftlinie ${fmtDist(e.behind.directM)})` : 'niemand');
    }
    if (e.rankAhead) row('Wertung: Vordermann', `${escHtml(e.rankAhead.name)} · ${fmtGapSec(e.rankAhead.gapSec)} vorn`);
    if (e.rankBehind) row('Wertung: Hintermann', `${escHtml(e.rankBehind.name)} · ${fmtGapSec(e.rankBehind.gapSec)} zurueck`);
    if (e.lastFixAgeSec != null && e.lastFixAgeSec > 15) row('Letzte Position', `vor ${Math.round(e.lastFixAgeSec)} s`);
    return `<div class="rank-detail"><div class="rank-dhead"><b>${name}</b> <span class="hint">${escHtml(e.className || '')} · Platz ${e.rank ?? '–'}</span><button type="button" class="rank-close" aria-label="Details schliessen">&times;</button></div>${rows.join('')}</div>`;
  }

  function renderRankBox() {
    const live = lastLive;
    if (!live) return;
    const rows = (live.entries || []).filter((e) => e.rank != null).slice(0, 5);
    const state = !live.race || live.race.startTs == null ? 'wartet auf Start' : live.race.official ? 'offiziell' : live.race.running ? 'laeuft' : 'beendet';
    const sel = rows.find((e) => e.trackerId === selectedRankId);
    rankBox.innerHTML = `<div class="rank-head"><b>${escHtml(live.race ? live.race.name : '')}</b> <span class="hint">${state} · Yardstick</span><span class="rank-arrow">${rankCollapsed ? '&#9662;' : '&#9652;'}</span></div>`
      + `<div class="rank-body">${rows.length ? rows.map((e) => `<div class="rank-row${e.trackerId === selectedRankId ? ' sel' : ''}" data-id="${escHtml(e.trackerId)}" title="Klick: Details"><span class="rank-n">${e.rank}</span><span class="rank-boat">${escHtml([e.sailNo, e.name].filter(Boolean).join(' '))}<span class="hint"> ${escHtml(e.className || '')}</span></span><span class="rank-t">${e.status === 'FIN' ? fmtRankTime(e.correctedSec) : (e.gapCorrectedSec ? fmtRankGap(e.gapCorrectedSec) : 'vorn')}${e.status === 'FIN' ? '' : `<span class="hint"> ${Math.round(e.progressPct || 0)}%</span>`}</span></div>`).join('') : '<div class="hint">Noch keine Wertung.</div>'}${sel ? rankDetailHtml(sel) : '<div class="hint" style="margin-top:0.2rem">berechnete Zeit (Yardstick); unterwegs: Rueckstand auf den Ersten. Boot anklicken fuer Details.</div>'}</div>`;
    rankBox.classList.toggle('collapsed', rankCollapsed);
    rankBox.style.display = 'block';
  }
  rankBox.addEventListener('click', (ev) => {
    if (ev.target.closest('.rank-close')) { selectedRankId = null; renderRankBox(); return; }
    const row = ev.target.closest('.rank-row');
    if (row) { selectedRankId = selectedRankId === row.dataset.id ? null : row.dataset.id; renderRankBox(); }
  });

  async function refreshRanking() {
    if (!showRank) { rankBox.style.display = 'none'; return; }
    try {
      const res = await fetch('/api/regatta');
      if (res.status === 401) return;
      const reg = await res.json();
      const now = Date.now();
      const started = (reg.races || []).filter((r) => r.startTs != null);
      const running = started.filter((r) => !r.official && now < r.startTs + (r.cutoffMinutes || 180) * 60000);
      const race = (running.length ? running : started).sort((a, b) => b.startTs - a.startTs)[0] || (reg.races || []).filter((r) => r.auto && !r.official)[0];
      if (!race) { rankBox.style.display = 'none'; return; }
      lastLive = await (await fetch(`/api/races/${race.id}/live`)).json();
      renderRankBox();
    } catch (err) { /* keine Daten: Overlay bleibt wie es ist */ }
  }
  if (rankToggleEl) rankToggleEl.addEventListener('change', () => {
    showRank = rankToggleEl.checked;
    try { localStorage.setItem('showRank', showRank ? '1' : '0'); } catch (e) { /* egal */ }
    refreshRanking();
  });
  refreshRanking();
  setInterval(refreshRanking, 10000);

  async function loadInitial() {
    try {
      const res = await fetch('/api/trackers');
      if (res.status === 401) { location.replace('/login.html?next=/index.html'); return; }
      const data = await res.json();
      applySnapshot(data.trackers || []);
    } catch (err) {
      console.error('Konnte Tracker nicht laden', err);
    }
  }

  let opened = false;
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') applySnapshot(msg.trackers);
      else if (msg.type === 'status') applyStatus(msg.stale, msg.online);
      else if (msg.type === 'position' || msg.type === 'tracker-created' || msg.type === 'tracker-updated') {
        upsertBoat(msg.tracker);
      } else if (msg.type === 'tracker-deleted') {
        removeBoat(msg.id);
      }
    };
    ws.onclose = () => setTimeout(connectWs, 2000);
    // Verbindung abgelehnt (Anmeldung abgelaufen)? Dann zur Anmeldung.
    ws.onopen = () => { opened = true; };
    ws.onerror = () => {
      if (!opened) {
        // Nie verbunden: pruefen, ob die Anmeldung fehlt
        fetch('/api/session').then((r) => r.json()).then((st) => {
          if (st.enabled && !st.role) location.replace('/login.html?next=/index.html');
        }).catch(() => {});
      }
      ws.close();
    };
  }

  // Handy: Bootliste ein-/ausklappen (die Karte soll den Bildschirm fuellen); nach der Groessenaenderung die Karte neu vermessen
  const sidebarEl = document.getElementById('sidebar');
  const toggleEl = document.getElementById('sidebar-toggle');
  if (sidebarEl && toggleEl) {
    toggleEl.addEventListener('click', () => {
      const collapsed = sidebarEl.classList.toggle('collapsed');
      toggleEl.setAttribute('aria-expanded', String(!collapsed));
      document.getElementById('sidebar-arrow').innerHTML = collapsed ? '&#9650;' : '&#9660;';
      setTimeout(() => map.invalidateSize(), 250);
    });
    window.addEventListener('resize', () => map.invalidateSize());
  }

  // Altersanzeige der Boote periodisch auffrischen, ohne auf neue Daten zu warten.
  setInterval(renderList, 5000);

  loadInitial();
  connectWs();
})();
