(() => {
  'use strict';

  const SAMPLE_INTERVAL_MS = 2000; // GPS-Fixes werden hoechstens alle 2s aufgezeichnet
  const FLUSH_INTERVAL_MS = 4000; // und gebuendelt an den Server gesendet
  const MAX_QUEUE = 5000; // Puffer bei Funkloch (~3 h bei 2s-Takt)
  const BATCH_SIZE = 500;

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
    queue: document.getElementById('stat-queue'),
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
  let lastFlushAt = 0;
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
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Fixes werden zuerst gepuffert (auch in localStorage) und dann gebuendelt gesendet. Bei Funkloch
  // bleiben sie im Puffer und werden nachgesendet - die Zeitstempel sind GPS-Zeit, also bleibt
  // die Zeitmessung korrekt.
  const queueKey = `regatta-tracker:${id}:queue`;
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(queueKey) || '[]'); } catch { queue = []; }
  let flushing = false;
  let lastSampleAt = 0;

  function persistQueue() {
    try { localStorage.setItem(queueKey, JSON.stringify(queue)); } catch { /* Speicher voll - egal */ }
  }

  function showQueue() {
    els.queue.textContent = queue.length ? `${queue.length} wartend` : '0';
  }

  async function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    const batch = queue.slice(0, BATCH_SIZE);
    try {
      const res = await fetch(`/api/trackers/${id}/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ positions: batch })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      queue.splice(0, batch.length);
      persistQueue();
      sentCount += batch.length;
      els.count.textContent = String(sentCount);
      setStatus('live', 'Live - sende Position');
    } catch (err) {
      setStatus('error', `Kein Netz - ${queue.length} Positionen gepuffert`);
    } finally {
      flushing = false;
      showQueue();
    }
  }

  function onPosition(pos) {
    const now = Date.now();
    const c = pos.coords;
    els.age.textContent = 'gerade eben';
    els.acc.textContent = c.accuracy != null ? `${Math.round(c.accuracy)} m` : '–';
    els.speed.textContent = c.speed != null ? `${(c.speed * 1.94384).toFixed(1)} kn` : '–';
    els.battery.textContent = batteryLevel != null ? `${Math.round(batteryLevel * 100)}%` : '–';

    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
    lastSampleAt = now;
    queue.push({
      lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed,
      heading: c.heading, battery: batteryLevel, ts: pos.timestamp
    });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    persistQueue();
    showQueue();
    if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
      lastFlushAt = now;
      flush();
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
    flush();
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  setInterval(() => { if (sending || queue.length) flush(); }, FLUSH_INTERVAL_MS);
  window.addEventListener('online', flush);
  showQueue();

  // ---- Registrierung (Segelnummer, Steuermann, Yardstick-Klasse) ----
  const reg = {
    sail: document.getElementById('reg-sail'),
    helm: document.getElementById('reg-helm'),
    cls: document.getElementById('reg-class'),
    btn: document.getElementById('reg-btn'),
    msg: document.getElementById('reg-msg')
  };
  fetch('/api/regatta').then((r) => r.json()).then((data) => {
    reg.cls.innerHTML = '<option value="">Klasse waehlen...</option>' + data.classes
      .map((c) => `<option value="${c.id}">${c.name} (YS ${c.yardstick})</option>`).join('');
    const mine = data.boats[id];
    if (mine) {
      reg.sail.value = mine.sailNo;
      reg.helm.value = mine.helm;
      reg.cls.value = mine.classId;
      reg.msg.textContent = 'Registriert';
    }
  }).catch(() => {});
  reg.btn.addEventListener('click', async () => {
    reg.msg.textContent = '';
    const res = await fetch(`/api/trackers/${id}/registration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sailNo: reg.sail.value, helm: reg.helm.value, classId: reg.cls.value })
    });
    const data = await res.json().catch(() => ({}));
    reg.msg.textContent = res.ok ? 'Gespeichert' : (data.error || 'Fehler');
  });

  els.btn.addEventListener('click', () => (sending ? stop() : start()));
})();
