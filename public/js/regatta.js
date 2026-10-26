(() => {
  'use strict';

  const adminToken = localStorage.getItem('regatta-tracker:admin-token') || '';
  const $ = (id) => document.getElementById(id);
  if (!adminToken) { $('no-login').style.display = 'block'; return; }
  $('main').style.display = 'block';

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
    if (pts.length) map.fitBounds(pts.map((k) => [lineDraft[k].lat, lineDraft[k].lon]), { maxZoom: 17, padding: [30, 30] });
  }
  function renderLineControls() {
    const opts = '<option value="">Tracker-Position...</option>' + trackers
      .filter((t) => t.latest).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('line-controls').innerHTML = ['a', 'b', 'mark'].map((k) => `
      <div class="row" data-k="${k}">
        <div style="min-width:190px">${LABEL[k]}: <span class="mono">${lineDraft[k] ? `${lineDraft[k].lat.toFixed(6)}, ${lineDraft[k].lon.toFixed(6)}` : 'nicht gesetzt'}</span></div>
        <button class="secondary pick">Auf Karte klicken</button>
        <select class="from-tracker">${opts}</select>
      </div>`).join('');
    $('line-controls').querySelectorAll('.row').forEach((row) => {
      const k = row.dataset.k;
      row.querySelector('.pick').addEventListener('click', () => { picking = k; $('line-msg').textContent = `Klick auf die Karte setzt: ${LABEL[k]}`; });
      row.querySelector('.from-tracker').addEventListener('change', (e) => {
        const t = trackers.find((x) => x.id === e.target.value);
        if (t && t.latest) { lineDraft[k] = { lat: t.latest.lat, lon: t.latest.lon }; renderLineControls(); drawLine(); }
      });
    });
  }
  map.on('click', (e) => {
    if (!picking) return;
    lineDraft[picking] = { lat: e.latlng.lat, lon: e.latlng.lng };
    picking = null;
    $('line-msg').textContent = '';
    renderLineControls(); drawLine();
  });
  $('line-save').addEventListener('click', guard(async () => {
    await api('/api/admin/line', 'PUT', lineDraft);
    $('line-msg').textContent = 'Gespeichert. Gilt fuer Wettfahrten ab dem naechsten Start.';
    await load();
  }));

  // ---------- Wettfahrten ----------
  $('race-create').addEventListener('click', guard(async () => {
    await api('/api/admin/races', 'POST', { name: $('race-name').value, laps: $('race-laps').value });
    $('race-name').value = '';
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
    return `<div class="card" data-race="${r.id}" style="background:var(--panel-2)">${head}${controls}${table}${footer}</div>`;
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
      results[r.id] = await (await fetch(`/api/races/${r.id}/results`)).json();
    }));
    renderClasses(); renderBoats(); renderRaces();
  }

  let firstLoad = true;
  load().then(() => {
    if (regatta.line) Object.assign(lineDraft, regatta.line);
    renderLineControls(); drawLine();
    firstLoad = false;
  }).catch((e) => alert(e.message));
  // Auto-Refresh der Ergebnisse (nicht waehrend ein Korrektur-Formular offen ist)
  setInterval(() => { if (!firstLoad && !openRows.size && !document.activeElement.closest('#races')) load().catch(() => {}); }, 10000);
})();
