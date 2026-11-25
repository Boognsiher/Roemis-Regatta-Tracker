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
  let fullTrack = false;
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
  const trackRangeEl = document.getElementById('track-range');
  const trackInfoEl = document.getElementById('track-info');

  function redrawLine(entry) {
    if (!entry.line) return;
    const pts = fullTrack && entry.full ? entry.full : entry.trail;
    entry.line.setLatLngs(pts.map((p) => [p.lat, p.lon]));
  }

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
    const names = ['GPS-Modul stumm', 'keine Satelliten', 'Suche'];
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
