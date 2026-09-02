(() => {
  'use strict';

  const SEND_INTERVAL_MS = 5000; // wie oft maximal an den Server gesendet wird

  const pathMatch = location.pathname.match(/\/t\/([^/]+)/);
  const id = pathMatch ? pathMatch[1] : null;
  const params = new URLSearchParams(location.search);
  const storageKey = id ? `regatta-tracker:${id}:token` : null;
  let token = params.get('token') || (storageKey && localStorage.getItem(storageKey)) || '';
  if (id && token) localStorage.setItem(storageKey, token);

  const els = {
    name: document.getElementById('boat-name'),
    dot: document.getElementById('status-dot'),
    text: document.getElementById('status-text'),
    btn: document.getElementById('toggle-btn'),
    age: document.getElementById('stat-age'),
    acc: document.getElementById('stat-acc'),
    speed: document.getElementById('stat-speed'),
    count: document.getElementById('stat-count'),
    battery: document.getElementById('stat-battery'),
    error: document.getElementById('setup-error')
  };

  function showError(msg) {
    els.error.textContent = msg;
    els.error.style.display = 'block';
  }

  if (!id || !token) {
    showError(
      'Kein gueltiger Tracker-Link. Bitte den QR-Code / Link aus dem Admin-Bereich verwenden ' +
      '(enthaelt ?token=...).'
    );
    els.btn.disabled = true;
    return;
  }

  let watchId = null;
  let sending = false;
  let sentCount = 0;
  let lastSentAt = 0;
  let wakeLock = null;
  let batteryLevel = null;

  fetch(`/api/trackers/${id}`).then((r) => r.json()).then((t) => {
    if (t && t.name) els.name.textContent = t.name;
  }).catch(() => {});

  if ('getBattery' in navigator) {
    navigator.getBattery().then((b) => {
      batteryLevel = b.level;
      b.addEventListener('levelchange', () => { batteryLevel = b.level; });
    }).catch(() => {});
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // z.B. nicht unterstuetzt oder Tab im Hintergrund - kein Problem, einfach weitermachen.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sending) requestWakeLock();
  });

  function setStatus(state, text) {
    els.dot.className = `status-dot ${state}`;
    els.text.textContent = text;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  async function sendPosition(pos) {
    const coords = pos.coords;
    const body = {
      lat: coords.latitude,
      lon: coords.longitude,
      accuracy: coords.accuracy,
      speed: coords.speed,
      heading: coords.heading,
      battery: batteryLevel,
      ts: pos.timestamp
    };
    try {
      const res = await fetch(`/api/trackers/${id}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      sentCount += 1;
      els.count.textContent = String(sentCount);
      setStatus('live', 'Live - sende Position');
    } catch (err) {
      setStatus('error', `Fehler: ${err.message}`);
    }
  }

  function onPosition(pos) {
    const now = Date.now();
    els.age.textContent = 'gerade eben';
    els.acc.textContent = pos.coords.accuracy != null ? `${Math.round(pos.coords.accuracy)} m` : '–';
    els.speed.textContent = pos.coords.speed != null ? `${(pos.coords.speed * 1.94384).toFixed(1)} kn` : '–';
    els.battery.textContent = batteryLevel != null ? `${Math.round(batteryLevel * 100)}%` : '–';

    if (now - lastSentAt >= SEND_INTERVAL_MS) {
      lastSentAt = now;
      sendPosition(pos);
    }
  }

  function onError(err) {
    setStatus('error', `GPS-Fehler: ${err.message}`);
  }

  function start() {
    if (!('geolocation' in navigator)) {
      showError('Dieses Geraet/Browser unterstuetzt keine Standortermittlung.');
      return;
    }
    sending = true;
    els.btn.textContent = 'Stop';
    els.btn.classList.add('tracking');
    setStatus('', 'Suche GPS-Signal...');
    requestWakeLock();
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });
  }

  function stop() {
    sending = false;
    els.btn.textContent = 'Start';
    els.btn.classList.remove('tracking');
    setStatus('', 'Angehalten');
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  els.btn.addEventListener('click', () => (sending ? stop() : start()));
})();
