(() => {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => {
    if (s == null) return '–';
    const t = Math.round(s);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  async function load() {
    const regRes = await fetch('/api/regatta');
    if (regRes.status === 401) { location.replace('/login.html?next=/results.html'); return; }
    const reg = await regRes.json();
    const races = reg.races.filter((r) => r.startTs != null).reverse();
    const out = [];
    for (const r of races) {
      const res = await (await fetch(`/api/races/${r.id}/results`)).json();
      out.push(`<div class="card"><div class="row">
          <h2 style="margin:0">${esc(r.name)}</h2>
          ${r.official ? '<span class="badge official">OFFIZIELL</span>' : '<span class="badge warn">vorlaeufig</span>'}
          <span class="hint">Start ${new Date(r.startTs).toLocaleTimeString('de-CH', { hour12: false })} · ${r.laps} Runden</span>
          <a href="/api/races/${r.id}/results.csv" style="color:var(--accent)">CSV</a></div>
        <table class="results"><thead><tr><th>Rang</th><th>Boot</th><th>Klasse</th><th>Gesegelt</th><th>Berechnet</th></tr></thead><tbody>
        ${res.entries.map((e) => `<tr><td class="num"><b>${e.rank ?? e.status}</b></td>
          <td>${esc(e.sailNo)} ${esc(e.name)}<div class="hint">${esc(e.helm)}</div></td>
          <td>${esc(e.className)} (${e.yardstick})</td>
          <td class="num">${fmt(e.elapsedSec)}</td><td class="num"><b>${fmt(e.correctedSec)}</b></td></tr>`).join('')}
        </tbody></table></div>`);
    }
    document.getElementById('races').innerHTML = out.join('') || '<p class="hint">Noch keine gestartete Wettfahrt.</p>';
  }
  load().catch(() => {});
  setInterval(() => load().catch(() => {}), 15000);
})();
