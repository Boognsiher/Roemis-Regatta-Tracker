(() => {
  'use strict';
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  // Abmelden nur anzeigen, wenn eine Anmeldung gilt
  fetch('/api/session').then((r) => r.json()).then((s) => { if (s.enabled && s.role) btn.style.display = ''; }).catch(() => {});
  btn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.replace('/login.html');
  });
})();
