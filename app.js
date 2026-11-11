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
    const eta = startMs + (p.km / state.speed) * 3600000 + Math.max(0, i - 1) * state.pause * 60000;
    return Object.assign({}, p, t, { eta, buffer: t.close - eta, idx: i });
  });
}
const DEFAULT_CHECK = {
  'Rad': ['Licht vorn/hinten + Ersatzlicht', 'Reflexweste / Reflexband', 'Ersatzschlauch ×2', 'Reifenheber, Flickzeug', 'Minipumpe / CO₂', 'Multitool, Kettenschloss', 'Reifen- und Bremscheck'],
  'Brevetkarte & Papiere': ['Brevetkarte (Brevet-Karte)', 'Stift', 'Ausweis, Bargeld, EC-Karte', 'Handy + Powerbank + Kabel', 'GPS-Track geladen'],
  'Kleidung': ['Regenjacke', 'Armlinge / Beinlinge', 'Ersatzhandschuhe', 'Mütze / Buff', 'Sonnenbrille'],
  'Verpflegung': ['2 Flaschen gefüllt', 'Riegel / Gels', 'Elektrolyte', 'Sitzcreme'],
};

// ---------- GPS / Route / Versorgung (testbar) ----------
const rad = d => d * Math.PI / 180;
function hav(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}
// Punkte [[lat,lon],...] -> Route mit Kilometrierung (m), mind. 100 m Punktabstand
function buildRoute(pts) {
  const r = { lat: [], lon: [], cum: [] };
  let d = 0;
  pts.forEach((p, i) => {
    if (i === 0) { r.lat.push(p[0]); r.lon.push(p[1]); r.cum.push(0); return; }
    const L = r.lat.length - 1, seg = hav(r.lat[L], r.lon[L], p[0], p[1]);
    if (seg >= 100 || i === pts.length - 1) {
      d += seg; r.lat.push(+p[0].toFixed(5)); r.lon.push(+p[1].toFixed(5)); r.cum.push(Math.round(d));
    }
  });
  return r;
}
// nächster Routenpunkt; mit 'from' wird zuerst nur im Fenster gesucht (Schleifen/Rückwege)
function nearest(r, lat, lon, from, win) {
  let lo = 0, hi = r.lat.length - 1;
  if (from != null) { lo = Math.max(0, from - 100); hi = Math.min(hi, from + (win || 600)); }
  const cl = Math.cos(rad(lat));
  let best = lo, bd = Infinity;
  for (let i = lo; i <= hi; i++) {
    const dx = (r.lon[i] - lon) * cl, dy = r.lat[i] - lat, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = i; }
  }
  const dm = Math.sqrt(bd) * 111195;
  if (from != null && dm > 1000) return nearest(r, lat, lon, null);
  return { i: best, d: dm, km: r.cum[best] / 1000 };
}
// Greedy: von 'from' aus immer den am weitesten erreichbaren Punkt innerhalb 'range' km wählen.
// holes = Abschnitte ohne erreichbaren Punkt.
function greedyStops(pts, from, dist, range) {
  range = Math.max(range, 0.1);
  const stops = [], holes = [];
  let pos = from, guard = 0;
  while (dist - pos > range && guard++ < 200) {
    let cand = null;
    for (const p of pts) if (p.km > pos + 0.01 && p.km <= pos + range) cand = p;
    if (!cand) {
      const nx = pts.find(p => p.km > pos + range);
      holes.push({ from: pos, to: nx ? nx.km : dist });
      if (!nx) break;
      cand = nx;
    }
    stops.push(cand); pos = cand.km;
  }
  return { stops, holes };
}

// ---------- Öffnungszeiten (OSM opening_hours, Teilmenge) ----------
const OH_DAYS = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 };
function parseDays(s) {
  s = s.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set();
  for (const part of s.split(',')) {
    if (part === 'ph') continue; // Feiertage nicht auswertbar
    const m = part.match(/^([a-z]{2})(?:-([a-z]{2}))?$/);
    if (!m || !(m[1] in OH_DAYS) || (m[2] && !(m[2] in OH_DAYS))) return null;
    let d = OH_DAYS[m[1]]; const e = m[2] ? OH_DAYS[m[2]] : d;
    for (let i = 0; i < 8; i++) { out.add(d); if (d === e) break; d = (d + 1) % 7; }
  }
  return [...out];
}
// -> Regeln oder null (leer/nicht auswertbar)
function parseOH(str) {
  if (!str || !str.trim()) return null;
  str = str.trim();
  if (/^24\s*\/\s*7$/.test(str)) return [{ days: [0, 1, 2, 3, 4, 5, 6], spans: [[0, 1440]] }];
  const rules = [];
  for (const raw of str.split(';')) {
    const r = raw.trim(); if (!r) continue;
    const m = r.match(/^([A-Za-z,\- ]*?)\s*((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*,?\s*)+|off|closed)$/i);
    if (!m) return null;
    const days = parseDays(m[1]); if (!days) return null;
    if (!days.length) continue;
    if (/^(off|closed)$/i.test(m[2])) { rules.push({ days, spans: [] }); continue; }
    const spans = m[2].split(',').map(x => x.trim()).filter(Boolean).map(x => {
      const t = x.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      return [+t[1] * 60 + +t[2], +t[3] * 60 + +t[4]];
    });
    rules.push({ days, spans });
  }
  return rules.some(r => r.spans.length) ? rules : null; // nur "off"-Regeln = unklar
}
function spansFor(rules, day) { // spätere Regeln überschreiben frühere
  let sp = [];
  for (const r of rules) if (r.days.includes(day)) sp = r.spans;
  return sp;
}
// -> { open: bool, closesInMin: Minuten bis Schluss (wenn offen) }
function isOpenAt(rules, ms) {
  const d = new Date(ms), day = d.getDay(), min = d.getHours() * 60 + d.getMinutes();
  for (const [s, e] of spansFor(rules, day)) {
    if (e > s && min >= s && min < e) return { open: true, closesInMin: e - min };
    if (e <= s && min >= s) return { open: true, closesInMin: e + 1440 - min }; // über Mitternacht
  }
  for (const [s, e] of spansFor(rules, (day + 6) % 7)) if (e <= s && min < e) return { open: true, closesInMin: e - min };
  return { open: false };
}
// state: open | closing (schließt ≤30 min nach Ankunft) | closed | unknown
function checkOH(hours, ms) {
  const rules = parseOH(hours);
  if (!rules) return { state: 'unknown' };
  const o = isOpenAt(rules, ms);
  if (o.open) return o.closesInMin <= 30 ? { state: 'closing', closesInMin: o.closesInMin } : { state: 'open' };
  for (let t = ms + 600000; t < ms + 48 * 3600000; t += 600000) if (isOpenAt(rules, t).open) return { state: 'closed', opensAt: t };
  return { state: 'closed' };
}

if (typeof module !== 'undefined') module.exports = { parseOH, isOpenAt, checkOH, openHours, closeHours, controlTimes, plan, FINAL_LIMIT, hav, buildRoute, nearest, greedyStops };

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
    return { dist: 200, start: toLocalInput(d.getTime()), speed: 22, pause: 15, controls: [], curKm: 0, odo: 0, bottle: 1.5, drink: 0.5, foodMax: 60, supplies: [], cand: [], fillKm: 0, foodFillKm: 0, done: {}, log: [], check: {}, custom: [] };
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
    if (!next) { $('ride').innerHTML = gpsHtml() + '<div class="card ok big">🏁 Alle Kontrollen abgestempelt – Brevet geschafft!</div>'; wireRide(); return; }
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
    h += supplyHtml();
    h += `<button id="stamp" class="primary">✔ Kontrolle jetzt abgestempelt</button></div>`;
    $('ride').innerHTML = gpsHtml() + h;
    wireRide();
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

  // ---------- Versorgung & GPS ----------
  let ROUTE = JSON.parse(localStorage.getItem('brevet-route') || 'null');
  const TYPE = { water: '💧 Wasser', food: '🍞 Essen', both: '💧🍞 Beides' };
  const ICON = { water: '💧', food: '🍞', both: '💧🍞' };

  // Geplante Ankunft an km X (Startzeit, Ø-Tempo, Pausen an vorherigen Kontrollen)
  function etaPlan(km) {
    const prior = plan(S).filter(r => r.km > 0 && r.km < S.dist && r.km < km).length;
    return new Date(S.start).getTime() + km / S.speed * 3600000 + prior * S.pause * 60000;
  }
  // Alle Versorgungspunkte inkl. Kontrollen, mit Ankunftszeit und Öffnungsstatus.
  // etaFn: km -> ms (Standard: Planung); usable: geschlossene Punkte weglassen
  function supplyPts(etaFn, usable) {
    etaFn = etaFn || etaPlan;
    const ctl = plan(S).filter(r => r.km > 0).map(r => ({ name: r.name, km: r.km, type: 'both', ctl: true }));
    let pts = S.supplies.map((s, i) => Object.assign({ idx: i }, s)).concat(ctl).sort((a, b) => a.km - b.km);
    pts.forEach(p => { p.eta = etaFn(p.km); p.oh = p.ctl ? { state: 'open' } : checkOH(p.hours, p.eta); });
    return usable ? pts.filter(p => p.oh.state !== 'closed') : pts;
  }
  const waterPts = (f, u) => supplyPts(f, u).filter(p => p.type !== 'food');
  const foodPts = (f, u) => supplyPts(f, u).filter(p => p.type !== 'water');
  const waterRange = () => S.bottle / S.drink * S.speed; // km mit vollen Flaschen

  $('gpx').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const x = new DOMParser().parseFromString(await f.text(), 'application/xml');
    let n = [...x.getElementsByTagName('trkpt')]; if (!n.length) n = [...x.getElementsByTagName('rtept')];
    const pts = n.map(p => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))]).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
    if (pts.length < 2) return alert('Keine Trackpunkte in der GPX-Datei gefunden.');
    ROUTE = buildRoute(pts);
    try { localStorage.setItem('brevet-route', JSON.stringify(ROUTE)); } catch (_) { alert('Route zu groß zum Speichern – bleibt nur bis zum Neuladen.'); }
    S.cand = []; save(); render();
  };
  $('clrroute').onclick = () => { ROUTE = null; localStorage.removeItem('brevet-route'); S.cand = []; save(); render(); };
  ['bottle', 'drink', 'foodMax'].forEach(k => $(k).oninput = e => { S[k] = Math.max(0.1, +e.target.value || 0.1); save(); renderSup(); });

  $('adds').onclick = () => {
    const km = +$('skm').value; if (!(km >= 0 && km <= S.dist)) return alert('km zwischen 0 und ' + S.dist);
    S.supplies.push({ name: $('sname').value.trim() || 'Versorgung', km, type: $('stype').value, hours: $('shours').value.trim() });
    $('sname').value = ''; $('skm').value = ''; $('shours').value = ''; save(); render();
  };

  // OSM/Overpass (nur online): Trinkwasser, Supermärkte, Bäcker, Tankstellen, Cafés entlang der Route
  $('osm').onclick = async () => {
    if (!ROUTE) return alert('Erst eine GPX-Route laden.');
    const btn = $('osm'); btn.disabled = true;
    try {
      const pts = []; let nextM = 0;
      ROUTE.cum.forEach((c, i) => { if (c >= nextM || i === ROUTE.cum.length - 1) { pts.push([ROUTE.lat[i], ROUTE.lon[i]]); nextM = c + 3000; } });
      const found = new Map();
      for (let i = 0; i < pts.length - 1; i += 24) {
        $('osmst').textContent = `Suche… ${Math.min(100, Math.round(i / pts.length * 100))} %`;
        const co = pts.slice(i, i + 25).map(p => p.join(',')).join(',');
        const a = `(around:500,${co})`;
        const q = `[out:json][timeout:40];(node${a}[amenity=drinking_water];node${a}[shop~"^(supermarket|convenience|bakery|kiosk)$"];node${a}[amenity=fuel];node${a}[amenity=cafe];);out body;`;
        const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error('Overpass ' + res.status);
        (await res.json()).elements.forEach(el => found.set(el.id, el));
      }
      const have = new Set(S.supplies.map(s => s.osm));
      S.cand = [...found.values()].filter(el => !have.has(el.id)).map(el => {
        const t = el.tags || {}, n = nearest(ROUTE, el.lat, el.lon, null);
        const kind = t.amenity === 'drinking_water' ? 'water' : 'food';
        const label = t.name || ({ drinking_water: 'Trinkwasser', fuel: 'Tankstelle', cafe: 'Café' }[t.amenity] || { supermarket: 'Supermarkt', convenience: 'Laden', bakery: 'Bäckerei', kiosk: 'Kiosk' }[t.shop] || 'Versorgung');
        return { osm: el.id, name: label, type: kind, km: Math.round(n.km * 10) / 10, off: Math.round(n.d), lat: el.lat, lon: el.lon, hours: t.opening_hours || '' };
      }).filter(c => c.off <= 600).sort((a, b) => a.km - b.km);
      $('osmst').textContent = `${S.cand.length} Vorschläge gefunden.`;
      save(); renderSup();
    } catch (err) { $('osmst').textContent = 'Fehler (offline?): ' + err.message; }
    btn.disabled = false;
  };

  function ohCell(s) {
    const t = fmt(s.eta).slice(3), o = s.oh;
    if (s.ctl) return t;
    if (o.state === 'open') return `${t}<br><span class="ok">✅ offen</span>`;
    if (o.state === 'closing') return `${t}<br><span class="warn">⚠ schließt in ${o.closesInMin} min</span>`;
    if (o.state === 'closed') return `${t}<br><span class="bad">🔴 zu${o.opensAt ? ', öffnet ' + fmt(o.opensAt) : ''}</span>`;
    return `${t}<br><span class="mu">❓ ${s.hours ? 'Zeiten nicht lesbar' : 'keine Zeiten'}</span>`;
  }
  function renderSup() {
    $('routest').textContent = ROUTE ? `Route geladen: ${(ROUTE.cum[ROUTE.cum.length - 1] / 1000).toFixed(1)} km, ${ROUTE.lat.length} Punkte` : 'Keine Route geladen (GPS-km läuft dann als Zähler).';
    $('bottle').value = S.bottle; $('drink').value = S.drink; $('foodMax').value = S.foodMax;
    const closedPts = supplyPts().filter(p => p.oh.state === 'closed' && !p.ctl);
    const rngW = waterRange() * 0.85, rngF = S.foodMax * 0.85;
    const wp = waterPts(null, true), fp = foodPts(null, true);
    const gw = greedyStops(wp, 0, S.dist, rngW), gf = greedyStops(fp, 0, S.dist, rngF);
    const rec = new Set(gw.stops.concat(gf.stops).map(s => s.km + '|' + s.name));
    const sup = supplyPts();
    $('suptab').innerHTML = '<tr><th>km</th><th>Ort</th><th>Art</th><th>Ankunft / Öffnung</th><th>Stopp</th><th></th></tr>' + sup.map(s => {
      const w = gw.stops.some(x => x.km === s.km && x.name === s.name), f = gf.stops.some(x => x.km === s.km && x.name === s.name);
      const mark = (w ? '💧' : '') + (f ? '🍞' : '');
      const nav = s.lat ? ` <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=bicycling">➤</a>` : '';
      return `<tr><td>${s.km}</td><td>${esc(s.name)}${nav}${s.hours ? '<br><small>' + esc(s.hours) + '</small>' : ''}</td><td>${s.ctl ? 'Kontrolle' : ICON[s.type]}</td><td>${ohCell(s)}</td><td>${mark ? '⭐ ' + mark : ''}</td><td>${s.ctl ? '' : `<button class="x" data-ds="${s.idx}">✕</button>`}</td></tr>`;
    }).join('');
    $('suptab').querySelectorAll('[data-ds]').forEach(b => b.onclick = () => { S.supplies.splice(+b.dataset.ds, 1); save(); render(); });
    const hole = (h, what) => `<div class="bad">⚠ ${what}-Lücke km ${h.from.toFixed(0)}–${h.to.toFixed(0)} (${(h.to - h.from).toFixed(0)} km) – Versorgungspunkt ergänzen oder vorher Vorrat mitnehmen!</div>`;
    $('supsum').innerHTML =
      (closedPts.length ? `<div class="bad">🔴 Bei Ankunft geschlossen (nicht eingeplant): ${closedPts.map(p => 'km ' + p.km + ' ' + esc(p.name) + ' (' + fmt(p.eta).slice(3) + ')').join(', ')}</div>` : '') +
      `<div>Reichweite volle Flaschen: <b>~${waterRange().toFixed(0)} km</b> (${S.bottle} L ÷ ${S.drink} L/h × ${S.speed} km/h), mit 15 % Reserve ${rngW.toFixed(0)} km.</div>` +
      `<div>💧 Empfohlene Wasser-Stopps: <b>${gw.stops.map(s => s.km + ' ' + esc(s.name)).join(' → ') || 'keine nötig'}</b></div>` +
      gw.holes.map(h => hole(h, 'Wasser')).join('') +
      `<div>🍞 Empfohlene Essens-Stopps (max. ${S.foodMax} km Abstand): <b>${gf.stops.map(s => s.km + ' ' + esc(s.name)).join(' → ') || 'keine nötig'}</b></div>` +
      gf.holes.map(h => hole(h, 'Essens')).join('');
    $('cand').innerHTML = S.cand.length ? '<h3>Vorschläge (OSM) – ＋ übernimmt</h3>' + S.cand.map((c, i) =>
      `<div class="ck">${ICON[c.type]} km ${c.km} · ${esc(c.name)} <small>(${c.off} m abseits${c.hours ? ', ' + esc(c.hours) : ''})</small><button style="margin-left:auto" data-ac="${i}">＋</button></div>`).join('') : '';
    $('cand').querySelectorAll('[data-ac]').forEach(b => b.onclick = () => {
      const c = S.cand.splice(+b.dataset.ac, 1)[0]; S.supplies.push(c); save(); renderSup(); renderRide();
    });
  }

  function wireRide() {
    const g = $('gpsbtn'); if (g) g.onclick = toggleGps;
    const w = $('fillw'); if (w) w.onclick = () => { S.fillKm = S.curKm || 0; save(); renderRide(); };
    const f = $('fillf'); if (f) f.onclick = () => { S.foodFillKm = S.curKm || 0; save(); renderRide(); };
  }
  function supplyHtml() {
    const cur = S.curKm || 0;
    const rideEta = km => Date.now() + Math.max(0, km - cur) / S.speed * 3600000;
    const usedW = Math.max(0, cur - S.fillKm) / S.speed * S.drink, remW = Math.max(0, S.bottle - usedW);
    const rangeW = remW / S.drink * S.speed, rangeF = Math.max(0, S.foodMax - Math.max(0, cur - S.foodFillKm));
    const line = (icon, pts, range, rem) => {
      const ahead = pts.filter(p => p.km > cur + 0.05);
      const g = greedyStops(ahead, cur, S.dist, range * 0.85);
      if (S.dist - cur <= range * 0.85) return `<div class="ok">${icon} Reicht bis ins Ziel (Rest ${rem}).</div>`;
      const nx = ahead[0], st = g.stops[0];
      let h = `<div class="${g.holes.length && g.holes[0].from === cur ? 'bad' : 'warn'}">${icon} `;
      if (g.holes.length && g.holes[0].from === cur) h += `<b>Kein Punkt in Reichweite!</b> Nächster: ${nx ? esc(nx.name) + ' in ' + (nx.km - cur).toFixed(1) + ' km' : 'keiner'} (Rest ${rem}).`;
      else h += `Spätestens auffüllen: <b>${esc(st.name)}</b> in ${(st.km - cur).toFixed(1)} km (km ${st.km}). Rest ${rem}.`;
      if (nx && st && nx !== st) h += `<br><small>Nächster Punkt überhaupt: ${esc(nx.name)} in ${(nx.km - cur).toFixed(1)} km</small>`;
      const tt = st || nx; if (tt && tt.oh && tt.oh.state === 'closing') h += `<br><b class="warn">⚠ ${esc(tt.name)} schließt kurz nach deiner Ankunft (${tt.oh.closesInMin} min)</b>`;
      const t = st || nx; if (t && t.lat) h += ` <a href="https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lon}&travelmode=bicycling">➤ Navi</a>`;
      return h + '</div>';
    };
    return `<div class="sep"></div>` +
      line('💧', waterPts(rideEta, true), rangeW, `~${remW.toFixed(1)} L / ${rangeW.toFixed(0)} km`) +
      line('🍞', foodPts(rideEta, true), rangeF, `~${rangeF.toFixed(0)} km Vorrat`) +
      `<div class="row" style="margin-top:8px"><button id="fillw">💧 Wasser aufgefüllt</button><button id="fillf">🍞 Essen aufgefüllt</button></div>`;
  }

  // ---------- GPS ----------
  let watchId = null, wl = null, gps = {}, lastPos = null, lastDraw = 0;
  async function wake() { try { wl = await navigator.wakeLock.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (watchId != null && document.visibilityState === 'visible') wake(); });
  function toggleGps() {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; if (wl) wl.release(); gps = {}; lastPos = null; return renderRide(); }
    if (!navigator.geolocation) return alert('Kein GPS im Browser verfügbar.');
    watchId = navigator.geolocation.watchPosition(onPos, e => { gps.err = e.message; renderRide(); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    wake(); renderRide();
  }
  function onPos(p) {
    const c = p.coords;
    gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, spd: c.speed, idx: gps.idx };
    if (ROUTE) {
      const n = nearest(ROUTE, gps.lat, gps.lon, gps.idx, 600);
      gps.idx = n.i; gps.off = n.d; gps.km = n.km;
      if (n.d < 400 && c.accuracy < 100) S.curKm = Math.round(n.km * 10) / 10;
    } else if (c.accuracy < 40) {
      if (lastPos) { const d = hav(lastPos[0], lastPos[1], gps.lat, gps.lon); if (d > 10 && d < 500) { S.odo = (S.odo || 0) + d / 1000; S.curKm = Math.round(S.odo * 10) / 10; } else if (d >= 500) lastPos = null; }
      if (!lastPos || hav(lastPos[0], lastPos[1], gps.lat, gps.lon) > 10) lastPos = [gps.lat, gps.lon];
    }
    save();
    if (Date.now() - lastDraw > 5000) { lastDraw = Date.now(); renderRide(); }
  }
  function gpsHtml() {
    const on = watchId != null;
    let h = `<button id="gpsbtn" class="${on ? '' : 'primary'}" style="${on ? '' : 'margin-top:0'}">${on ? '📡 GPS aus' : '📡 GPS starten'}</button>`;
    if (on) {
      if (gps.err) h += `<div class="bad">${esc(gps.err)}</div>`;
      else if (gps.lat == null) h += '<div class="warn">Suche Position…</div>';
      else h += `<div><small>Genauigkeit ±${Math.round(gps.acc)} m` + (gps.spd != null ? ` · ${(gps.spd * 3.6).toFixed(1)} km/h` : '') +
        (ROUTE ? ` · ${gps.off < 400 ? 'auf der Route' : '<b class="bad">' + Math.round(gps.off) + ' m abseits der Route</b>'}` : ' · GPS-Zähler (keine Route geladen)') + '</small></div>';
    }
    return h;
  }

  function render() {
    $('dist').value = S.dist; $('start').value = S.start; $('speed').value = S.speed; $('pause').value = S.pause;
    renderPlan(); renderRide(); renderSup(); renderCheck(); renderLog();
  }
  render();
  setInterval(renderRide, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
