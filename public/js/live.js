(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (s) => {
    if (s == null) return '–';
    const t = Math.round(Math.abs(s));
    const h = Math.floor(t / 3600);
    return `${h}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const fmtGap = (s) => {
    if (s == null) return '–';
    if (s < 1) return 'f&uuml;hrt';
    const t = Math.round(s);
    return `+${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  let races = [];
  let currentId = null;
  let ranking = null;

  async function getJson(url) {
    const res = await fetch(url);
    if (res.status === 401) { location.replace('/login.html?next=/live.html'); throw new Error('Anmeldung erforderlich'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function pickDefault() {
    const wanted = new URLSearchParams(location.search).get('race');
    if (wanted && races.some((r) => r.id === wanted)) return wanted;
    const now = Date.now();
    const running = races.filter((r) => !r.official && now < r.startTs + r.cutoffMinutes * 60000);
    const list = running.length ? running : races;
    return list.sort((a, b) => b.startTs - a.startTs)[0]?.id || null;
  }

  function render() {
    const r = ranking;
    if (!r) return;
    $('notice').innerHTML = '';
    if (r.needsCourse) {
      $('notice').innerHTML = '<b>F&uuml;r diese Wettfahrt ist kein Kurs (Bojen) gespeichert</b> - die Live-Rangliste braucht den Kurs. Die Wettfahrtleitung kann ihn unter &laquo;Wettfahrtleitung &rarr; Kurs&raquo; zeichnen.';
    } else if (r.marks.length) {
      const exact = r.marks.every((m) => m.exact);
      const found = r.marks.filter((m) => !m.approx).length;
      const lenTxt = ` - Rundenlänge ca. ${Math.round(r.lapLenM)} m, ${r.race.laps} Runden`;
      $('notice').textContent = exact
        ? `Bojen: exakte Positionen der Wettfahrtleitung (${r.marks.length})${lenTxt}`
        : `Bojen: ${found} von ${r.marks.length} aus den Aufzeichnungen erkannt${found < r.marks.length ? ' (sonst gezeichnete Position)' : ''}${lenTxt}`;
    }
    const rows = r.entries.map((e) => {
      const lap = e.status === 'FIN' ? 'Ziel' : `Runde ${e.lapNow || Math.min(e.lapsDone + 1, r.race.laps)}/${r.race.laps}${e.lapUncertain ? ' ⚠' : ''}`;
      const time = e.status === 'FIN' ? `<b>${fmtDur(e.correctedSec)}</b>` : (e.projectedCorrectedSec != null ? `&asymp; ${fmtDur(e.projectedCorrectedSec)}` : '–');
      const status = e.status === 'PRESTART' ? 'Vorstart' : e.status === 'NODATA' ? 'keine Daten' : '';
      const old = e.lastFixAgeSec != null && e.lastFixAgeSec > 30 && e.status !== 'FIN' ? `<div class="warn-text">Daten ${Math.round(e.lastFixAgeSec)} s alt</div>` : '';
      return `<tr>
        <td class="num"><b>${e.rank ?? '–'}</b></td>
        <td><span class="boat-dot" style="display:inline-block;width:10px;height:10px;background:${esc(e.color || '#888')};margin-right:6px"></span>${esc(e.sailNo)} ${esc(e.name)}
          <div class="hint">${esc(e.helm)} ${status ? `· ${status}` : ''}</div>${old}</td>
        <td>${esc(e.className)} (${e.yardstick})</td>
        <td style="min-width:140px"><div class="bar"><div style="width:${Math.round(e.progressPct)}%"></div></div>
          <div class="hint">${lap} · ${Math.round(e.progressPct)} %</div></td>
        <td class="num">${time}</td>
        <td class="num">${e.gapCorrectedSec == null ? '–' : fmtGap(e.gapCorrectedSec)}</td>
        <td class="num">${e.gapM == null ? '–' : (e.gapM < 1 ? 'vorne' : `${Math.round(e.gapM)} m`)}</td>
        <td class="num">${e.speedKn == null ? '–' : `${e.speedKn.toFixed(1)} kn`}</td></tr>`;
    });
    $('rows').innerHTML = rows.join('') || '<tr><td colspan="8" class="hint">Keine registrierten Boote.</td></tr>';
    tick();
  }

  function tick() {
    const r = ranking && ranking.race;
    if (!r) return;
    const d = (Date.now() - r.startTs) / 1000;
    $('clock').textContent = d < 0 ? `Start in ${fmtDur(-d)}` : fmtDur(d);
    $('state').textContent = r.official ? 'offiziell abgeschlossen' : (r.running ? 'läuft' : 'beendet (Zielschluss)');
  }

  async function loadRanking() {
    if (!currentId) return;
    try { ranking = await getJson(`/api/races/${currentId}/live`); render(); } catch (e) { $('notice').textContent = e.message; }
  }

  function connectWs() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ranking' && msg.raceId === currentId) { ranking = msg.ranking; render(); }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
    ws.onerror = () => ws.close();
  }

  async function init() {
    const reg = await getJson('/api/regatta');
    races = reg.races.filter((r) => r.startTs != null);
    $('race-select').innerHTML = races.slice().sort((a, b) => b.startTs - a.startTs)
      .map((r) => `<option value="${r.id}">${esc(r.name)} (${new Date(r.startTs).toLocaleString('de-CH', { hour12: false })})</option>`).join('');
    currentId = pickDefault();
    if (!currentId) { $('rows').innerHTML = '<tr><td colspan="8" class="hint">Noch keine gestartete Wettfahrt.</td></tr>'; return; }
    $('race-select').value = currentId;
    await loadRanking();
    connectWs();
  }

  $('race-select').addEventListener('change', (e) => { currentId = e.target.value; ranking = null; loadRanking(); });
  setInterval(tick, 1000);
  setInterval(loadRanking, 10000); // Reserve, falls die Live-Verbindung ausfaellt
  init().catch((e) => { $('rows').innerHTML = `<tr><td colspan="8" class="hint">${esc(e.message)}</td></tr>`; });
})();
