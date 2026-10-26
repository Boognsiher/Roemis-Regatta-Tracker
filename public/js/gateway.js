(() => {
  'use strict';

  // Muss mit firmware/include/config.h (BLE_SERVICE_UUID / BLE_CHAR_UUID) uebereinstimmen.
  const SERVICE = 'a7d0c001-5e1b-4f6a-9a53-2d4f7b6c9e10';
  const CHAR = 'a7d0c002-5e1b-4f6a-9a53-2d4f7b6c9e10';
  const FLUSH_MS = 4000;
  const MAX_QUEUE = 20000;
  const BATCH = 500;
  const KEY = 'regatta-tracker:gateway-token';
  const QKEY = 'regatta-tracker:gateway-queue';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  $('token').value = localStorage.getItem(KEY) || '';

  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { queue = []; }
  let rx = 0; let tx = 0; let bad = 0;
  const heard = new Map(); // loraId -> {last, count, rssi, snr, battery}
  let trackers = [];
  let flushing = false;
  let device = null;
  let wakeLock = null;

  function showError(m) { $('msg').textContent = m || ''; $('msg').style.display = m ? 'block' : 'none'; }
  function persist() { try { localStorage.setItem(QKEY, JSON.stringify(queue)); } catch { /* voll */ } }
  function counters() {
    $('c-rx').textContent = rx; $('c-tx').textContent = tx; $('c-queue').textContent = queue.length; $('c-bad').textContent = bad;
  }

  function renderHeard() {
    const rows = [...heard.entries()].sort((a, b) => a[0] - b[0]).map(([id, h]) => {
      const t = trackers.find((x) => x.loraId === id);
      const age = Math.round((Date.now() - h.seen) / 1000);
      return `<tr><td>${id}</td><td>${t ? esc(t.name) : '<span class="warn-text">unbekannt</span>'}</td>
        <td class="num">${age < 60 ? `${age}s` : `${Math.round(age / 60)}min`}</td><td class="num">${h.count}</td>
        <td class="num">${h.rssi ?? '–'}</td><td class="num">${h.snr ?? '–'}</td>
        <td class="num">${h.battery != null ? Math.round(h.battery * 100) + '%' : '–'}</td></tr>`;
    });
    $('heard').innerHTML = rows.join('') || '<tr><td colspan="7" class="hint">Noch nichts empfangen.</td></tr>';
  }

  function enqueue(p) {
    queue.push(p);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  }

  function onNotify(ev) {
    const p = LoraPacket.decode(ev.target.value);
    if (!p) { bad += 1; counters(); return; }
    rx += 1;
    const h = heard.get(p.id) || { count: 0 };
    Object.assign(h, { seen: Date.now(), count: h.count + 1, rssi: p.rssi, snr: p.snr, battery: p.battery });
    heard.set(p.id, h);
    enqueue({
      id: p.id, lat: p.lat, lon: p.lon, ts: p.ts, speed: p.speed, heading: p.heading,
      battery: p.battery, accuracy: p.hdop != null ? p.hdop * 5 : null // grob: HDOP * ~5 m
    });
    persist(); counters();
  }

  async function flush() {
    if (flushing || !queue.length) return;
    const token = $('token').value.trim();
    if (!token) return;
    flushing = true;
    const batch = queue.slice(0, BATCH);
    try {
      const res = await fetch('/api/gateway/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-gateway-token': token, 'x-admin-token': token },
        body: JSON.stringify({ positions: batch })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      queue.splice(0, batch.length);
      tx += batch.length;
      persist();
      $('srv-status').textContent = 'Server: OK';
      $('srv-status').className = 'badge official';
      showError(data.unknown && data.unknown.length ? `Unbekannte LoRa-Nr: ${data.unknown.join(', ')} (im Admin zuweisen)` : '');
      if (res.ok) localStorage.setItem(KEY, token);
    } catch (e) {
      $('srv-status').textContent = 'Server: Fehler';
      $('srv-status').className = 'badge warn';
      if (/Token/.test(e.message)) showError(e.message);
    } finally {
      flushing = false;
      counters();
    }
  }

  // ---------- Bluetooth ----------
  function setBle(text, cls) { $('ble-status').textContent = text; $('ble-status').className = `badge ${cls || ''}`; }

  async function connectGatt() {
    setBle('verbinde...', 'warn');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    const ch = await svc.getCharacteristic(CHAR);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', onNotify);
    setBle('verbunden', 'official');
  }

  async function reconnectLoop() {
    // Nach Abbruch (Reichweite, Handy-Energiesparen) automatisch neu verbinden; der Master puffert solange.
    for (;;) {
      if (!device || device.gatt.connected) return;
      try { await connectGatt(); return; } catch { setBle('getrennt - versuche erneut', 'warn'); }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  $('connect').addEventListener('click', async () => {
    showError('');
    if (!navigator.bluetooth) { showError('Web Bluetooth fehlt: Android + Chrome verwenden (und https://).'); return; }
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
      device.addEventListener('gattserverdisconnected', () => { setBle('getrennt', 'warn'); reconnectLoop(); });
      await connectGatt();
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    } catch (e) {
      setBle('nicht verbunden', '');
      showError(`Bluetooth: ${e.message}`);
    }
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && device && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    }
  });

  // ---------- Eigenes Boot per Handy-GPS ----------
  let watchId = null;
  let lastOwn = 0;
  function startOwn() {
    const trackerId = $('own-tracker').value;
    if (!trackerId || !('geolocation' in navigator)) return;
    watchId = navigator.geolocation.watchPosition((pos) => {
      if (Date.now() - lastOwn < 2000) return;
      lastOwn = Date.now();
      const c = pos.coords;
      enqueue({ trackerId, lat: c.latitude, lon: c.longitude, ts: pos.timestamp, accuracy: c.accuracy, speed: c.speed, heading: c.heading });
      persist(); counters();
    }, (e) => showError(`GPS: ${e.message}`), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function stopOwn() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }
  $('own-on').addEventListener('change', (e) => (e.target.checked ? startOwn() : stopOwn()));

  async function loadTrackers() {
    try {
      trackers = (await (await fetch('/api/trackers')).json()).trackers;
      $('own-tracker').innerHTML = trackers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    } catch { /* offline: spaeter erneut */ }
  }
  // loraId ist nur im Admin-Endpunkt sichtbar; fuer die Anzeige holen wir es, wenn das Token passt.
  async function loadLoraNames() {
    const token = $('token').value.trim();
    if (!token) return;
    try {
      const r = await fetch('/api/admin/trackers', { headers: { 'x-admin-token': token } });
      if (r.ok) trackers = (await r.json()).trackers;
    } catch { /* ignorieren */ }
  }

  loadTrackers().then(loadLoraNames);
  setInterval(() => { flush(); renderHeard(); }, FLUSH_MS);
  window.addEventListener('online', flush);
  counters(); renderHeard();
})();
