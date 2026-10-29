(() => {
  'use strict';
  const pw = document.getElementById('pw');
  const go = document.getElementById('go');
  const msg = document.getElementById('msg');

  // Nur interne Ziele erlauben (kein Weiterleiten auf fremde Seiten)
  function nextUrl() {
    const n = new URLSearchParams(location.search).get('next') || '/index.html';
    return n.startsWith('/') && !n.startsWith('//') ? n : '/index.html';
  }

  function show(text) { msg.textContent = text; msg.style.display = text ? 'block' : 'none'; }

  async function login() {
    show('');
    go.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { location.replace(nextUrl()); return; }
      if (res.status === 429) show('Zu viele Fehlversuche - bitte spaeter erneut versuchen.');
      else show(data.error || 'Anmeldung fehlgeschlagen');
    } catch {
      show('Keine Verbindung zum Server.');
    } finally {
      go.disabled = false;
    }
  }

  go.addEventListener('click', login);
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  // Schon angemeldet (oder keine Anmeldung noetig)? Dann gleich weiter.
  fetch('/api/session').then((r) => r.json()).then((s) => {
    if (!s.enabled || s.role) location.replace(nextUrl());
  }).catch(() => {});
})();
