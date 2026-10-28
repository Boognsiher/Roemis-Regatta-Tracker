(() => {
  'use strict';

  const map = L.map('map', { zoomControl: true }).setView([47.0, 8.3], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap Mitwirkende'
  }).addTo(map);

  const boatListEl = document.getElementById('boat-list');
  const MAX_CLIENT_TRAIL = 600; // so viele Spurpunkte pro Boot haelt der Browser hoechstens

  /** id -> { marker, line, data } */
  const boats = new Map();
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
      entry = { marker: null, line: null, data: t, trail: [] };
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
      if (!last || latest.ts > last.ts) entry.trail.push(latest);
      if (entry.trail.length > MAX_CLIENT_TRAIL) entry.trail.splice(0, entry.trail.length - MAX_CLIENT_TRAIL);
    }
    entry.line.setLatLngs(entry.trail.map((p) => [p.lat, p.lon]));

    if (!hasFitOnce) {
      hasFitOnce = true;
      map.setView(latlng, 14);
    }

    renderList();
  }

  function removeBoat(id) {
    const entry = boats.get(id);
    if (entry) {
      if (entry.marker) map.removeLayer(entry.marker);
      if (entry.line) map.removeLayer(entry.line);
      boats.delete(id);
    }
    renderList();
  }

  function renderList() {
    const items = [...boats.values()].sort((a, b) => a.data.name.localeCompare(b.data.name));
    if (items.length === 0) {
      boatListEl.innerHTML = '<p class="empty-state">Noch keine Tracker aktiv.</p>';
      return;
    }
    boatListEl.innerHTML = items.map(({ data: t }) => `
      <div class="boat-card ${t.stale ? 'stale' : ''}" data-id="${t.id}">
        <div class="boat-dot" style="background:${t.color}"></div>
        <div class="boat-info">
          <div class="boat-name">${escapeHtml(t.name)}</div>
          <div class="boat-meta">
            ${t.latest ? `${fmtAge(t.latest.ts)} · ${fmtSpeed(t.latest.speed)}` : 'noch keine Position'}
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
  function applyStatus(staleMap) {
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
      const data = await res.json();
      applySnapshot(data.trackers || []);
    } catch (err) {
      console.error('Konnte Tracker nicht laden', err);
    }
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') applySnapshot(msg.trackers);
      else if (msg.type === 'status') applyStatus(msg.stale);
      else if (msg.type === 'position' || msg.type === 'tracker-created' || msg.type === 'tracker-updated') {
        upsertBoat(msg.tracker);
      } else if (msg.type === 'tracker-deleted') {
        removeBoat(msg.id);
      }
    };
    ws.onclose = () => setTimeout(connectWs, 2000);
    ws.onerror = () => ws.close();
  }

  // Altersanzeige der Boote periodisch auffrischen, ohne auf neue Daten zu warten.
  setInterval(renderList, 5000);

  loadInitial();
  connectWs();
})();
