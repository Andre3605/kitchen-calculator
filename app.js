/* Brevet-Begleiter – Logik (ACP/Audax-Kontrollzeiten) + UI */

// ---------- Kernlogik (testbar) ----------
// Geschwindigkeitsabschnitte: [bis km, Vmin (Schluss), Vmax (Öffnung)]
const SEGMENTS = [
  [200, 15, 34],
  [400, 15, 32],
  [600, 15, 30],
  [1000, 11.428, 28],
  [1300, 13.333, 26],
];
// Offizielle Zeitlimits der Zielkontrolle (Stunden)
const FINAL_LIMIT = { 200: 13.5, 300: 20, 400: 27, 600: 40, 1000: 75 };

function openHours(km) {
  let h = 0, prev = 0;
  for (const [to, , vmax] of SEGMENTS) {
    if (km <= prev) break;
    h += (Math.min(km, to) - prev) / vmax;
    prev = to;
  }
  return h;
}
function closeHours(km, brevet) {
  if (km >= brevet && FINAL_LIMIT[brevet]) return FINAL_LIMIT[brevet];
  if (km <= 60) return km / 20 + 1;
  let h = 0, prev = 0;
  for (const [to, vmin] of SEGMENTS) {
    if (km <= prev) break;
    h += (Math.min(km, to) - prev) / vmin;
    prev = to;
  }
  return h;
}
// Kontrollen hinter der Nennstrecke zählen als Nennstrecke
function controlTimes(km, brevet, startMs) {
  const k = Math.min(km, brevet);
  return {
    open: startMs + Math.round(openHours(k) * 60) * 60000,
    close: startMs + Math.round(closeHours(k, brevet) * 60) * 60000,
  };
}
// Geplante Ankunft: Fahrzeit bei Ø v (ohne Pausen) + Pause je zuvor passierter Kontrolle
function plan(state) {
  const startMs = new Date(state.start).getTime();
  const pts = [{ name: 'Start', km: 0, fixed: true }]
    .concat(state.controls.filter(c => c.km > 0 && c.km < state.dist).map(c => ({ name: c.name || 'Kontrolle', km: c.km })))
    .concat([{ name: 'Ziel', km: state.dist, fixed: true }]);
  pts.sort((a, b) => a.km - b.km);
  return pts.map((p, i) => {
    const t = controlTimes(p.km, state.dist, startMs);
    const eta = startMs + (p.km / state.speed) * 3600000 + i * state.pause * 60000;
    return Object.assign({}, p, t, { eta, buffer: t.close - eta, idx: i });
  });
}
const DEFAULT_CHECK = {
  'Rad': ['Licht vorn/hinten + Ersatzlicht', 'Reflexweste / Reflexband', 'Ersatzschlauch ×2', 'Reifenheber, Flickzeug', 'Minipumpe / CO₂', 'Multitool, Kettenschloss', 'Reifen- und Bremscheck'],
  'Brevetkarte & Papiere': ['Brevetkarte (Brevet-Karte)', 'Stift', 'Ausweis, Bargeld, EC-Karte', 'Handy + Powerbank + Kabel', 'GPS-Track geladen'],
  'Kleidung': ['Regenjacke', 'Armlinge / Beinlinge', 'Ersatzhandschuhe', 'Mütze / Buff', 'Sonnenbrille'],
  'Verpflegung': ['2 Flaschen gefüllt', 'Riegel / Gels', 'Elektrolyte', 'Sitzcreme'],
};

if (typeof module !== 'undefined') module.exports = { openHours, closeHours, controlTimes, plan, FINAL_LIMIT };

// ---------- UI ----------
if (typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const KEY = 'brevet-app-v1';
  const pad = n => String(n).padStart(2, '0');
  const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const fmt = ms => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDur = ms => {
    const neg = ms < 0; let m = Math.round(Math.abs(ms) / 60000);
    return (neg ? '−' : '') + Math.floor(m / 60) + ':' + pad(m % 60) + ' h';
  };
  const toLocalInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const defaults = () => {
    const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); d.setHours(6, 0, 0, 0);
    return { dist: 200, start: toLocalInput(d.getTime()), speed: 22, pause: 15, controls: [], curKm: 0, done: {}, log: [], check: {}, custom: [] };
  };
  let S = Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY) || '{}'));
  const save = () => localStorage.setItem(KEY, JSON.stringify(S));

  // Tabs
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('section').forEach(s => s.hidden = s.id !== b.dataset.t);
    render();
  });

  // Planer-Eingaben
  $('dist').onchange = e => { S.dist = +e.target.value; S.done = {}; save(); render(); };
  $('start').onchange = e => { S.start = e.target.value; save(); render(); };
  $('speed').oninput = e => { S.speed = Math.max(5, +e.target.value || 22); save(); renderPlan(); };
  $('pause').oninput = e => { S.pause = Math.max(0, +e.target.value || 0); save(); renderPlan(); };
  $('addc').onclick = () => {
    const km = +$('ckm').value; if (!(km > 0 && km < S.dist)) return alert('km muss zwischen 0 und ' + S.dist + ' liegen.');
    S.controls.push({ name: $('cname').value.trim() || 'Kontrolle', km }); $('cname').value = ''; $('ckm').value = '';
    S.done = {}; save(); render();
  };
  $('curkm').oninput = e => { S.curKm = +e.target.value || 0; save(); renderRide(); };

  function renderPlan() {
    const rows = plan(S);
    $('plan').innerHTML = '<tr><th>Kontrolle</th><th>km</th><th>Öffnet</th><th>Schließt</th><th>Ankunft*</th><th>Puffer</th><th></th></tr>' +
      rows.map(r => {
        const cls = r.buffer < 0 ? 'bad' : r.buffer < 3600000 ? 'warn' : 'ok';
        const del = r.fixed ? '' : `<button class="x" data-del="${S.controls.findIndex(c => c.km === r.km && (c.name || 'Kontrolle') === r.name)}">✕</button>`;
        return `<tr><td>${esc(r.name)}</td><td>${r.km}</td><td>${fmt(r.open)}</td><td>${fmt(r.close)}</td><td>${r.km === 0 ? '–' : fmt(r.eta)}</td><td class="${r.km === 0 ? '' : cls}">${r.km === 0 ? '–' : fmtDur(r.buffer)}</td><td>${del}</td></tr>`;
      }).join('');
    $('plan').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.controls.splice(+b.dataset.del, 1); S.done = {}; save(); render(); });
    const last = rows[rows.length - 1];
    const tot = (S.dist / S.speed) * 3600000 + (rows.length - 2) * S.pause * 60000;
    $('sum').innerHTML = `Zeitlimit Ziel: <b>${FINAL_LIMIT[S.dist]} h</b> · Geplante Gesamtzeit: <b>${fmtDur(tot)}</b> · Puffer am Ziel: <b class="${last.buffer < 0 ? 'bad' : 'ok'}">${fmtDur(last.buffer)}</b>`;
  }

  function renderRide() {
    const rows = plan(S).slice(1);
    const doneAll = rows.every(r => S.done[r.km + '|' + r.name]);
    const next = rows.find(r => !S.done[r.km + '|' + r.name]);
    const now = Date.now(), start = new Date(S.start).getTime();
    $('curkm').value = S.curKm || '';
    if (!next) { $('ride').innerHTML = '<div class="card ok big">🏁 Alle Kontrollen abgestempelt – Brevet geschafft!</div>'; return; }
    const left = next.close - now, need = next.km - S.curKm;
    let h = `<div class="card"><div class="lbl">Nächste Kontrolle</div><div class="big">${esc(next.name)} · km ${next.km}</div>
      <div>Öffnet ${fmt(next.open)} · Schließt <b>${fmt(next.close)}</b></div>`;
    if (now < start) h += `<div class="warn">Start in ${fmtDur(start - now)}</div>`;
    h += `<div class="${left < 0 ? 'bad' : left < 3600000 ? 'warn' : 'ok'} big">${left < 0 ? 'GESCHLOSSEN seit ' + fmtDur(-left) : 'Noch ' + fmtDur(left) + ' bis Schluss'}</div>`;
    if (now < next.open) h += `<div class="warn">Zu früh: Kontrolle öffnet erst in ${fmtDur(next.open - now)}</div>`;
    if (need > 0 && left > 0) {
      const v = need / (left / 3600000);
      h += `<div>Noch <b>${need.toFixed(1)} km</b> → nötiger Ø: <b class="${v > S.speed * 1.3 ? 'bad' : v > S.speed ? 'warn' : 'ok'}">${v.toFixed(1)} km/h</b> (geplant ${S.speed})</div>`;
    }
    h += `<button id="stamp" class="primary">✔ Kontrolle jetzt abgestempelt</button></div>`;
    $('ride').innerHTML = h;
    $('stamp').onclick = () => {
      const t = prompt('Zeit der Stempelung (HH:MM) – leer = jetzt', '');
      let ts = now;
      if (t) { const m = t.match(/^(\d{1,2})[:.](\d{2})$/); if (!m) return alert('Format HH:MM'); const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); ts = d.getTime(); }
      S.done[next.km + '|' + next.name] = ts;
      S.log.push({ name: next.name, km: next.km, ts, close: next.close, dist: S.dist });
      S.curKm = Math.max(S.curKm, next.km); save(); render();
    };
  }

  function renderCheck() {
    const groups = Object.assign({}, DEFAULT_CHECK, S.custom.length ? { 'Eigene': S.custom } : {});
    $('check').innerHTML = Object.entries(groups).map(([g, items]) =>
      `<h3>${g}</h3>` + items.map(i => `<label class="ck"><input type="checkbox" data-i="${esc(i)}" ${S.check[i] ? 'checked' : ''}> ${esc(i)}</label>`).join('')).join('');
    $('check').querySelectorAll('input').forEach(c => c.onchange = () => { S.check[c.dataset.i] = c.checked; save(); });
  }
  $('addi').onclick = () => { const v = $('newi').value.trim(); if (v) { S.custom.push(v); $('newi').value = ''; save(); renderCheck(); } };
  $('resetc').onclick = () => { S.check = {}; save(); renderCheck(); };

  function renderLog() {
    $('logt').innerHTML = '<tr><th>Datum/Zeit</th><th>Kontrolle</th><th>km</th><th>Reserve zu Schluss</th></tr>' +
      S.log.map(l => `<tr><td>${fmt(l.ts)}</td><td>${esc(l.name)}</td><td>${l.km}</td><td class="${l.close - l.ts < 0 ? 'bad' : ''}">${fmtDur(l.close - l.ts)}</td></tr>`).join('');
  }
  $('csv').onclick = () => {
    const csv = 'Zeit;Kontrolle;km;Reserve\n' + S.log.map(l => `${fmt(l.ts)};${l.name};${l.km};${fmtDur(l.close - l.ts)}`).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'brevet-log.csv'; a.click();
  };
  $('clearl').onclick = () => { if (confirm('Logbuch und Stempel-Status löschen?')) { S.log = []; S.done = {}; save(); render(); } };

  function render() {
    $('dist').value = S.dist; $('start').value = S.start; $('speed').value = S.speed; $('pause').value = S.pause;
    renderPlan(); renderRide(); renderCheck(); renderLog();
  }
  render();
  setInterval(renderRide, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
