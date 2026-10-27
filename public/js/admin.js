(() => {
  'use strict';

  const STORAGE_KEY = 'regatta-tracker:admin-token';

  const els = {
    loginCard: document.getElementById('login-card'),
    mainCard: document.getElementById('main-card'),
    tokenInput: document.getElementById('admin-token'),
    loginBtn: document.getElementById('login-btn'),
    loginError: document.getElementById('login-error'),
    newName: document.getElementById('new-name'),
    createBtn: document.getElementById('create-btn'),
    createError: document.getElementById('create-error'),
    list: document.getElementById('tracker-list')
  };

  let adminToken = localStorage.getItem(STORAGE_KEY) || '';

  function api(path, options = {}) {
    return fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), 'x-admin-token': adminToken }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function tryLogin(token) {
    adminToken = token;
    const res = await api('/api/admin/trackers');
    if (!res.ok) {
      adminToken = '';
      if (res.status === 429) throw new Error('Zu viele Fehlversuche - bitte spaeter erneut versuchen.');
      throw new Error('Token abgelehnt - bitte pruefen.');
    }
    localStorage.setItem(STORAGE_KEY, token);
    els.loginCard.style.display = 'none';
    els.mainCard.style.display = 'block';
    const data = await res.json();
    renderList(data.trackers);
  }

  function trackerUrl(t) {
    return `${location.origin}/t/${t.id}?token=${t.token}`;
  }

  function renderList(trackers) {
    if (!trackers.length) {
      els.list.innerHTML = '<p class="hint">Noch keine Tracker angelegt.</p>';
      return;
    }
    els.list.innerHTML = trackers.map((t) => `
      <div class="tracker-row" data-id="${t.id}">
        <div class="qr-box"><img data-qr="${t.id}" alt="QR-Code" /></div>
        <div class="grow">
          <div style="font-weight:600">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${t.color};margin-right:6px"></span>
            ${escapeHtml(t.name)}
          </div>
          <div style="margin:4px 0"><label style="display:inline">LoRa-Nr</label>
            <input type="number" class="lora-id" min="1" max="250" value="${t.loraId ?? ''}" style="width:70px" /></div>
          <div class="mono" style="word-break:break-all">${trackerUrl(t)}</div>
        </div>
        <button class="secondary copy-btn">Link kopieren</button>
        <button class="secondary fw-btn">Firmware-Config kopieren</button>
        <button class="secondary reset-btn">Spur loeschen</button>
        <button class="danger delete-btn">Loeschen</button>
      </div>
    `).join('');

    // QR-Codes mit Token im Header laden (nicht in der URL) und als lokales Bild anzeigen
    els.list.querySelectorAll('img[data-qr]').forEach(async (img) => {
      try {
        const res = await api(`/api/admin/trackers/${img.dataset.qr}/qrcode.png`);
        if (res.ok) img.src = URL.createObjectURL(await res.blob());
      } catch { /* QR optional */ }
    });

    els.list.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.tracker-row').dataset.id;
        const t = trackers.find((x) => x.id === id);
        navigator.clipboard.writeText(trackerUrl(t)).then(() => {
          btn.textContent = 'Kopiert!';
          setTimeout(() => (btn.textContent = 'Link kopieren'), 1500);
        });
      });
    });

    els.list.querySelectorAll('.fw-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = trackers.find((x) => x.id === btn.closest('.tracker-row').dataset.id);
        const text = `#define SERVER_URL     "${location.origin}"\n#define TRACKER_ID     ${t.loraId ?? 1}\n` +
          `#define SERVER_ID      "${t.id}"\n#define TRACKER_TOKEN  "${t.token}"\n`;
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Kopiert!';
          setTimeout(() => (btn.textContent = 'Firmware-Config kopieren'), 1500);
        });
      });
    });

    els.list.querySelectorAll('.lora-id').forEach((inp) => {
      inp.addEventListener('change', async () => {
        const id = inp.closest('.tracker-row').dataset.id;
        const res = await api(`/api/admin/trackers/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loraId: inp.value === '' ? null : Number(inp.value) })
        });
        if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Fehler'); }
        refresh();
      });
    });

    els.list.querySelectorAll('.reset-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.tracker-row').dataset.id;
        await api(`/api/admin/trackers/${id}/reset-trail`, { method: 'POST' });
      });
    });

    els.list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.tracker-row').dataset.id;
        const t = trackers.find((x) => x.id === id);
        if (!confirm(`Tracker "${t.name}" wirklich loeschen?`)) return;
        const res = await api(`/api/admin/trackers/${id}`, { method: 'DELETE' });
        if (res.ok) refresh();
      });
    });
  }

  async function refresh() {
    const res = await api('/api/admin/trackers');
    if (!res.ok) return;
    const data = await res.json();
    renderList(data.trackers);
  }

  els.loginBtn.addEventListener('click', async () => {
    els.loginError.style.display = 'none';
    try {
      await tryLogin(els.tokenInput.value.trim());
    } catch (err) {
      els.loginError.textContent = err.message;
      els.loginError.style.display = 'block';
    }
  });

  els.tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.loginBtn.click();
  });

  els.createBtn.addEventListener('click', async () => {
    els.createError.style.display = 'none';
    const name = els.newName.value.trim();
    const res = await api('/api/admin/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      els.createError.textContent = data.error || 'Fehler beim Anlegen';
      els.createError.style.display = 'block';
      return;
    }
    els.newName.value = '';
    refresh();
  });

  if (adminToken) {
    tryLogin(adminToken).catch(() => {
      els.loginCard.style.display = 'block';
      els.mainCard.style.display = 'none';
    });
  }
})();
