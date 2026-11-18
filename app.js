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
  'Brevetkarte & Papiere': ['Brevetkarte', 'Stift', 'Ausweis, Bargeld, EC-Karte', 'Handy + Powerbank + Kabel', 'GPS-Track geladen'],
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

// ---------- Sonnenauf-/-untergang (Sunrise equation, Genauigkeit ~1–2 min) ----------
// -> { rise, set } in ms für den lokalen Kalendertag von ms; null bei Polartag/-nacht
function sunTimes(lat, lon, ms) {
  const d = new Date(ms), r = Math.PI / 180;
  const jd0 = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 2440587.5;
  const n = Math.ceil(jd0 - 2451545.0 + 0.0008);
  const Js = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * r) + 0.02 * Math.sin(2 * M * r) + 0.0003 * Math.sin(3 * M * r);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * r) - 0.0069 * Math.sin(2 * L * r);
  const sd = Math.sin(L * r) * Math.sin(23.4397 * r), cd = Math.cos(Math.asin(sd));
  const cw = (Math.sin(-0.833 * r) - Math.sin(lat * r) * sd) / (Math.cos(lat * r) * cd);
  if (cw < -1 || cw > 1) return null;
  const w = Math.acos(cw) / r / 360, toMs = j => Math.round((j - 2440587.5) * 86400000);
  return { rise: toMs(Jt - w), set: toMs(Jt + w) };
}

if (typeof module !== 'undefined') module.exports = { sunTimes, parseOH, isOpenAt, checkOH, openHours, closeHours, controlTimes, plan, FINAL_LIMIT, hav, buildRoute, nearest, greedyStops };

// ---------- UI ----------
if (typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const KEY = 'brevet-app-v1', RKEY = 'brevet-route';
  const pad = n => String(n).padStart(2, '0');
  const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const fmt = ms => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtT = ms => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDur = ms => { const neg = ms < 0, m = Math.round(Math.abs(ms) / 60000); return (neg ? '−' : '') + Math.floor(m / 60) + ':' + pad(m % 60) + ' h'; };
  const toLocalInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => parseFloat(String(v).replace(',', '.'));
  // Eingabefeld nur überschreiben, wenn der Nutzer nicht gerade darin tippt
  const setVal = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (_) { return def; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };
  const mapsUrl = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=bicycling`;
  const ICON = { water: '💧', food: '🍞', both: '💧🍞' };
  const ckey = r => r.km + '|' + r.name;

  const defaults = () => {
    const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); d.setHours(6, 0, 0, 0);
    return { dist: 200, start: toLocalInput(d.getTime()), speed: 22, pause: 15, controls: [], curKm: 0, odo: 0,
      bottle: 1.5, drink: 0.5, foodMax: 60, supplies: [], cand: [], fillKm: 0, foodFillKm: 0,
      done: {}, log: [], check: {}, custom: [], tab: 't-plan' };
  };
  let S = Object.assign(defaults(), load(KEY, {}));
  if (isNaN(new Date(S.start).getTime())) S.start = defaults().start;
  let ROUTE = load(RKEY, null);
  let saveWarned = false;
  const save = () => { if (!store(KEY, S) && !saveWarned) { saveWarned = true; alert('Speichern fehlgeschlagen – Speicher des Browsers voll?'); } };
  const startMs = () => new Date(S.start).getTime();

  let toastT;
  function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2500); }
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- Tabs ----------
  function showTab(t) {
    if (!$(t)) t = 't-plan';
    S.tab = t; save();
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x.dataset.t === t));
    document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== t; });
    render(); window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav button').forEach(b => { b.onclick = () => showTab(b.dataset.t); });

  // ---------- Zeitplan-Hilfen ----------
  // Geplante Ankunft an km X: Startzeit + Fahrzeit bei Ø + Pause an jeder vorher passierten Kontrolle
  function etaFn() {
    const ctl = plan(S).filter(r => r.km > 0 && r.km < S.dist).map(r => r.km), st = startMs();
    return km => st + km / S.speed * 3600000 + ctl.filter(k => k < km).length * S.pause * 60000;
  }
  function isDark(ms) {
    if (!ROUTE) return false;
    const s = sunTimes(ROUTE.lat[0], ROUTE.lon[0], ms);
    return !!s && (ms < s.rise || ms > s.set);
  }
  // Dunkel-Abschnitte entlang der Strecke (km-Intervalle) nach Planung
  function darkStretches() {
    if (!ROUTE) return [];
    const eta = etaFn(), out = [];
    let cur = null;
    for (let km = 0; km <= S.dist; km++) {
      const t = eta(km);
      if (isDark(t)) { if (!cur) cur = { from: km, t0: t }; cur.to = km; cur.t1 = t; }
      else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ---------- Planer ----------
  $('dist').onchange = e => { S.dist = +e.target.value; save(); render(); };
  $('start').onchange = e => { if (!isNaN(new Date(e.target.value).getTime())) { S.start = e.target.value; save(); } render(); };
  $('speed').oninput = e => { const v = num(e.target.value); if (v >= 5 && v <= 60) { S.speed = v; save(); renderPlan(); renderSup(); renderRide(); } };
  $('pause').oninput = e => { const v = num(e.target.value); if (v >= 0 && v <= 600) { S.pause = v; save(); renderPlan(); renderSup(); renderRide(); } };
  ['speed', 'pause'].forEach(id => { $(id).onchange = () => render(); });
  $('addc').onclick = () => {
    const km = num($('ckm').value);
    if (!(km > 0 && km < S.dist)) return alert(`km muss zwischen 0 und ${S.dist} liegen.`);
    S.controls.push({ name: $('cname').value.trim() || 'Kontrolle', km });
    $('cname').value = ''; $('ckm').value = ''; save(); render(); toast('Kontrolle hinzugefügt');
  };

  function renderPlan() {
    const rows = plan(S);
    $('plan').innerHTML = '<tr><th>Kontrolle</th><th>km</th><th>Öffnet</th><th>Schließt</th><th>Ankunft*</th><th>Puffer</th><th></th></tr>' +
      rows.map(r => {
        const st = r.km === 0, cls = r.buffer < 0 ? 'bad' : r.buffer < 3600000 ? 'warn' : 'ok';
        const ci = r.fixed ? -1 : S.controls.findIndex(c => c.km === r.km && (c.name || 'Kontrolle') === r.name);
        const del = ci < 0 ? '' : `<button class="x" data-del="${ci}" aria-label="Kontrolle löschen">✕</button>`;
        return `<tr><td>${esc(r.name)}</td><td>${r.km}</td><td>${fmtT(r.open)}</td><td>${fmtT(r.close)}</td>` +
          `<td>${st ? '–' : fmtT(r.eta) + (isDark(r.eta) ? ' 🌙' : '')}</td><td class="${st ? '' : cls}">${st ? '–' : fmtDur(r.buffer)}</td><td>${del}</td></tr>`;
      }).join('');
    $('plan').querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { S.controls.splice(+b.dataset.del, 1); save(); render(); }; });
    const last = rows[rows.length - 1], nCtl = rows.length - 2;
    const tot = S.dist / S.speed * 3600000 + nCtl * S.pause * 60000;
    const out = S.controls.filter(c => !(c.km > 0 && c.km < S.dist));
    let h = `<div>Zeitlimit: <b>${fmtDur(FINAL_LIMIT[S.dist] * 3600000)}</b> · Geplant: <b>${fmtDur(tot)}</b> · Puffer Ziel: <b class="${last.buffer < 0 ? 'bad' : last.buffer < 3600000 ? 'warn' : 'ok'}">${fmtDur(last.buffer)}</b></div>`;
    const worst = rows.slice(1).reduce((a, r) => (!a || r.buffer < a.buffer ? r : a), null);
    if (worst && worst.buffer < 3600000) h += `<div class="${worst.buffer < 0 ? 'bad' : 'warn'}">⚠ Engste Stelle: ${esc(worst.name)} (km ${worst.km}) mit ${fmtDur(worst.buffer)} Puffer – Ø erhöhen oder Pausen kürzen.</div>`;
    if (out.length) h += `<div class="warn">${out.length} Kontrolle(n) liegen außerhalb 0–${S.dist} km und werden ignoriert. <button id="rmout">entfernen</button></div>`;
    const dk = darkStretches();
    if (dk.length) h += dk.map(d => `<div>🌙 Dunkel ca. km ${d.from}–${d.to} (${fmtT(d.t0)} – ${fmtT(d.t1)}): Licht, Reflexweste, warme Schicht.</div>`).join('');
    else if (!ROUTE) h += '<div class="mu">🌙 Nacht-Hinweis: GPX-Route laden (Tab Versorgung).</div>';
    $('sum').innerHTML = h;
    const rm = $('rmout'); if (rm) rm.onclick = () => { S.controls = S.controls.filter(c => c.km > 0 && c.km < S.dist); save(); render(); };
  }

  // ---------- Unterwegs ----------
  const nextControl = () => plan(S).slice(1).find(r => !S.done[ckey(r)]);
  let lastRide = '';
  function renderRide() {
    setVal('curkm', S.curKm || '');
    const next = nextControl(), now = Date.now(), st = startMs(), cur = S.curKm || 0;
    let h;
    if (!next) h = '<div class="card ok big">🏁 Alle Kontrollen abgestempelt – Brevet geschafft!</div>';
    else {
      const left = next.close - now, need = next.km - cur;
      h = `<div class="card"><div class="lbl">Nächste Kontrolle</div><div class="big">${esc(next.name)} · km ${next.km}</div>
        <div>Öffnet ${fmtT(next.open)} · Schließt <b>${fmtT(next.close)}</b></div>`;
      if (now < st) h += `<div class="warn">Start in ${fmtDur(st - now)}</div>`;
      h += `<div class="${left < 0 ? 'bad' : left < 3600000 ? 'warn' : 'ok'} big">${left < 0 ? 'GESCHLOSSEN seit ' + fmtDur(-left) : 'Noch ' + fmtDur(left) + ' bis Schluss'}</div>`;
      if (now < next.open) h += `<div class="warn">Zu früh: Kontrolle öffnet erst in ${fmtDur(next.open - now)}</div>`;
      if (now >= st && need > 0 && left > 0) {
        const v = need / (left / 3600000);
        h += `<div>Noch <b>${need.toFixed(1)} km</b> → nötiger Ø: <b class="${v > S.speed * 1.3 ? 'bad' : v > S.speed ? 'warn' : 'ok'}">${v.toFixed(1)} km/h</b> (geplant ${S.speed})</div>`;
      }
      if (now > st && cur > 0) {
        const diff = etaFn()(cur) - now;
        h += `<div>Zeitplan: <b class="${diff < 0 ? 'warn' : 'ok'}">${fmtDur(Math.abs(diff))} ${diff < 0 ? 'hinter' : 'vor'} Plan</b></div>`;
      }
      if (now >= st && isDark(now)) h += '<div class="warn">🌙 Dunkel – Licht an, Reflexweste!</div>';
      h += supplyHtml() + '</div>';
    }
    if (h !== lastRide) { $('ride').innerHTML = h; lastRide = h; }
    $('stampcard').hidden = !next;
    if (next) {
      $('stamp').textContent = `✔ ${next.name} (km ${next.km}) abgestempelt`;
      $('stamp').classList.toggle('pulse', Math.abs(cur - next.km) < 1);
    }
  }
  $('curkm').oninput = e => { const v = num(e.target.value); if (v >= 0) { S.curKm = v; save(); renderRide(); } };
  $('stamp').onclick = () => {
    const next = nextControl(); if (!next) return;
    let ts = Date.now();
    const t = $('stampt').value;
    if (t) {
      const [hh, mm] = t.split(':').map(Number), d = new Date();
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() > ts + 600000) d.setDate(d.getDate() - 1); // z. B. 23:50 nach Mitternacht eingetragen
      ts = d.getTime();
    }
    S.done[ckey(next)] = ts;
    S.log.push({ key: ckey(next), name: next.name, km: next.km, ts, open: next.open, close: next.close });
    S.curKm = Math.max(S.curKm || 0, next.km);
    S.fillKm = S.foodFillKm = next.km; // an Kontrollen wird praktisch immer aufgefüllt
    $('stampt').value = '';
    save(); render(); toast(`${next.name}: gestempelt ${fmtT(ts)} · Wasser/Essen als aufgefüllt gesetzt`);
  };
  $('fillw').onclick = () => { S.fillKm = S.curKm || 0; save(); renderRide(); toast('💧 Wasser voll'); };
  $('fillf').onclick = () => { S.foodFillKm = S.curKm || 0; save(); renderRide(); toast('🍞 Essen aufgefüllt'); };

  // ---------- Versorgung ----------
  // Alle Versorgungspunkte inkl. Kontrollen, mit Ankunftszeit und Öffnungsstatus.
  // eta: km -> ms (Standard: Planung); usable: bei Ankunft geschlossene Punkte weglassen
  function supplyPts(eta, usable) {
    eta = eta || etaFn();
    const ctl = plan(S).filter(r => r.km > 0).map(r => ({ name: r.name, km: r.km, type: 'both', ctl: true }));
    const pts = S.supplies.map((s, i) => Object.assign({ idx: i }, s)).concat(ctl).sort((a, b) => a.km - b.km);
    pts.forEach(p => { p.eta = eta(p.km); p.oh = p.ctl ? { state: 'open' } : checkOH(p.hours, p.eta); });
    return usable ? pts.filter(p => p.oh.state !== 'closed') : pts;
  }
  const waterPts = (e, u) => supplyPts(e, u).filter(p => p.type !== 'food');
  const foodPts = (e, u) => supplyPts(e, u).filter(p => p.type !== 'water');
  const waterRange = () => S.bottle / S.drink * S.speed; // km mit vollen Flaschen

  $('gpx').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = '';
    const x = new DOMParser().parseFromString(await f.text(), 'application/xml');
    if (x.getElementsByTagName('parsererror').length) return alert('Die Datei ist keine gültige GPX-Datei.');
    let n = [...x.getElementsByTagName('trkpt')]; if (!n.length) n = [...x.getElementsByTagName('rtept')];
    const pts = n.map(p => [num(p.getAttribute('lat')), num(p.getAttribute('lon'))]).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
    if (pts.length < 2) return alert('Keine Trackpunkte in der GPX-Datei gefunden.');
    ROUTE = buildRoute(pts);
    if (!store(RKEY, ROUTE)) alert('Route zu groß zum Speichern – sie bleibt nur bis zum Neuladen erhalten.');
    // Wegpunkte (oft Kontrollen/POIs) als Vorschläge
    const wp = [...x.getElementsByTagName('wpt')].map(w => {
      const lat = num(w.getAttribute('lat')), lon = num(w.getAttribute('lon'));
      const nm = w.getElementsByTagName('name')[0];
      const q = nearest(ROUTE, lat, lon, null);
      return { src: 'GPX', name: (nm && nm.textContent.trim()) || 'Wegpunkt', type: 'both', km: Math.round(q.km * 10) / 10, off: Math.round(q.d), lat, lon, hours: '' };
    }).filter(c => !isNaN(c.lat) && c.off <= 2000);
    S.cand = wp.sort((a, b) => a.km - b.km);
    const len = ROUTE.cum[ROUTE.cum.length - 1] / 1000;
    const std = Object.keys(FINAL_LIMIT).map(Number).reduce((a, b) => (Math.abs(b - len) < Math.abs(a - len) ? b : a));
    if (std !== S.dist && Math.abs(std - len) < std * 0.1 && confirm(`Die Route hat ${len.toFixed(0)} km. Brevet-Strecke auf ${std} km setzen?`)) S.dist = std;
    save(); render();
    toast(`Route geladen: ${len.toFixed(1)} km` + (wp.length ? `, ${wp.length} Wegpunkte als Vorschläge` : ''));
  };
  $('clrroute').onclick = () => { if (!confirm('Route entfernen?')) return; ROUTE = null; localStorage.removeItem(RKEY); S.cand = []; save(); render(); };
  ['bottle', 'drink', 'foodMax'].forEach(k => {
    $(k).oninput = e => { const v = num(e.target.value); if (v > 0) { S[k] = v; save(); renderSup(); renderRide(); } };
    $(k).onchange = () => renderSup();
  });
  $('adds').onclick = () => {
    const km = num($('skm').value);
    if (!(km >= 0 && km <= S.dist)) return alert(`km muss zwischen 0 und ${S.dist} liegen.`);
    S.supplies.push({ name: $('sname').value.trim() || 'Versorgung', km, type: $('stype').value, hours: $('shours').value.trim() });
    $('sname').value = ''; $('skm').value = ''; $('shours').value = ''; save(); render(); toast('Versorgungspunkt hinzugefügt');
  };

  // OSM/Overpass (nur online): Trinkwasser, Läden, Bäcker, Tankstellen, Cafés, Imbisse entlang der Route
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  async function overpass(q) {
    let last;
    for (let a = 0; a < 4; a++) {
      try {
        const res = await fetch(OVERPASS[a % OVERPASS.length], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (res.ok) return (await res.json()).elements || [];
        last = new Error('Server antwortet ' + res.status);
      } catch (e) { last = e; }
      await new Promise(r => setTimeout(r, 2000 * (a + 1)));
    }
    throw last;
  }
  const LABEL_A = { drinking_water: 'Trinkwasser', fuel: 'Tankstelle', cafe: 'Café', fast_food: 'Imbiss' };
  const LABEL_S = { supermarket: 'Supermarkt', convenience: 'Laden', bakery: 'Bäckerei', kiosk: 'Kiosk' };
  $('osm').onclick = async () => {
    if (!ROUTE) return alert('Erst eine GPX-Route laden.');
    if (!navigator.onLine) return alert('Keine Internetverbindung.');
    const btn = $('osm'); btn.disabled = true;
    try {
      const pts = []; let nextM = 0;
      ROUTE.cum.forEach((c, i) => { if (c >= nextM || i === ROUTE.cum.length - 1) { pts.push([ROUTE.lat[i], ROUTE.lon[i]]); nextM = c + 3000; } });
      const found = new Map();
      for (let i = 0; i < pts.length - 1; i += 24) {
        $('osmst').textContent = `Suche… ${Math.round(i / pts.length * 100)} %`;
        const a = `(around:500,${pts.slice(i, i + 25).map(p => p.join(',')).join(',')})`;
        const q = `[out:json][timeout:60];(nwr${a}[amenity~"^(drinking_water|fuel|cafe|fast_food)$"];nwr${a}[shop~"^(supermarket|convenience|bakery|kiosk)$"];);out center tags;`;
        (await overpass(q)).forEach(el => found.set(el.type + el.id, el));
      }
      const have = new Set(S.supplies.map(s => s.osm));
      const osm = [...found.entries()].filter(([id]) => !have.has(id)).map(([id, el]) => {
        const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat == null) return null;
        const q = nearest(ROUTE, lat, lon, null);
        // Läden/Tankstellen haben auch Wasser zu kaufen -> "both"
        return { src: 'OSM', osm: id, name: t.name || LABEL_A[t.amenity] || LABEL_S[t.shop] || 'Versorgung', kind: LABEL_A[t.amenity] || LABEL_S[t.shop] || '',
          type: t.amenity === 'drinking_water' ? 'water' : 'both', km: Math.round(q.km * 10) / 10, off: Math.round(q.d), lat, lon, hours: t.opening_hours || '' };
      }).filter(c => c && c.off <= 600);
      S.cand = S.cand.filter(c => c.src !== 'OSM').concat(osm).sort((a, b) => a.km - b.km);
      $('osmst').textContent = `${osm.length} Vorschläge gefunden.`;
      save(); renderSup();
    } catch (err) { $('osmst').textContent = 'Suche fehlgeschlagen: ' + err.message; }
    btn.disabled = false;
  };
  $('clrcand').onclick = () => { S.cand = []; save(); renderSup(); };

  function ohCell(s) {
    const t = fmtT(s.eta), o = s.oh;
    if (s.ctl) return t + (isDark(s.eta) ? ' 🌙' : '');
    if (o.state === 'open') return `${t}<br><span class="ok">✅ offen</span>`;
    if (o.state === 'closing') return `${t}<br><span class="warn">⚠ schließt in ${o.closesInMin} min</span>`;
    if (o.state === 'closed') return `${t}<br><span class="bad">🔴 zu${o.opensAt ? ', öffnet ' + fmtT(o.opensAt) : ''}</span>`;
    return `${t}<br><span class="mu">❓ ${s.hours ? 'Zeiten nicht lesbar' : 'keine Zeiten'}</span>`;
  }
  function renderSup() {
    $('routest').textContent = ROUTE ? `Route: ${(ROUTE.cum[ROUTE.cum.length - 1] / 1000).toFixed(1)} km, ${ROUTE.lat.length} Punkte` : 'Keine Route geladen – GPS zählt dann nur die gefahrenen km.';
    $('clrroute').hidden = !ROUTE;
    setVal('bottle', S.bottle); setVal('drink', S.drink); setVal('foodMax', S.foodMax);
    const all = supplyPts();
    const closed = all.filter(p => p.oh.state === 'closed' && !p.ctl);
    const rngW = waterRange() * 0.85, rngF = S.foodMax * 0.85;
    const gw = greedyStops(waterPts(null, true), 0, S.dist, rngW), gf = greedyStops(foodPts(null, true), 0, S.dist, rngF);
    const isStop = (list, s) => list.some(x => x.km === s.km && x.name === s.name);
    $('suptab').innerHTML = '<tr><th>km</th><th>Ort</th><th>Art</th><th>Ankunft</th><th>Stopp</th><th></th></tr>' + all.map(s => {
      const mark = (isStop(gw.stops, s) ? '💧' : '') + (isStop(gf.stops, s) ? '🍞' : '');
      const nav = s.lat ? ` <a href="${mapsUrl(s.lat, s.lon)}" target="_blank" rel="noopener" aria-label="Navigation">➤</a>` : '';
      return `<tr><td>${s.km}</td><td>${esc(s.name)}${nav}${s.hours ? '<br><small>' + esc(s.hours) + '</small>' : ''}</td><td>${s.ctl ? 'Kontr.' : ICON[s.type]}</td>` +
        `<td>${ohCell(s)}</td><td>${mark ? '⭐' + mark : ''}</td><td>${s.ctl ? '' : `<button class="x" data-ds="${s.idx}" aria-label="Löschen">✕</button>`}</td></tr>`;
    }).join('');
    $('suptab').querySelectorAll('[data-ds]').forEach(b => { b.onclick = () => { S.supplies.splice(+b.dataset.ds, 1); save(); render(); }; });
    const hole = (h, what) => `<div class="bad">⚠ ${what}-Lücke km ${h.from.toFixed(0)}–${h.to.toFixed(0)} (${(h.to - h.from).toFixed(0)} km) – Punkt ergänzen oder mehr Vorrat mitnehmen.</div>`;
    const list = st => st.filter(s => s.km < S.dist).map(s => `${s.km} ${esc(s.name)}`).join(' → ') || 'keine nötig';
    $('supsum').innerHTML =
      (closed.length ? `<div class="bad">🔴 Bei Ankunft geschlossen (nicht eingeplant): ${closed.map(p => `km ${p.km} ${esc(p.name)} (${fmtT(p.eta)})`).join(', ')}</div>` : '') +
      `<div>Reichweite volle Flaschen: <b>~${waterRange().toFixed(0)} km</b> (${S.bottle} L ÷ ${S.drink} L/h × ${S.speed} km/h), eingeplant mit 15 % Reserve: ${rngW.toFixed(0)} km.</div>` +
      `<div>💧 Wasser-Stopps: <b>${list(gw.stops)}</b></div>` + gw.holes.map(h => hole(h, 'Wasser')).join('') +
      `<div>🍞 Essens-Stopps (max. ${S.foodMax} km): <b>${list(gf.stops)}</b></div>` + gf.holes.map(h => hole(h, 'Essens')).join('');
    // Vorschläge
    const inHole = c => gw.holes.concat(gf.holes).some(h => c.km > h.from && c.km < h.to);
    $('candwrap').hidden = !S.cand.length;
    $('candlist').innerHTML = S.cand.map((c, i) =>
      `<div class="ck"><div style="flex:1">${ICON[c.type]} <b>km ${c.km}</b> · ${esc(c.name)}${inHole(c) ? ' <span class="tag">schließt Lücke</span>' : ''}<br>` +
      `<small>${c.src}${c.kind && c.kind !== c.name ? ' · ' + esc(c.kind) : ''} · ${c.off} m abseits${c.hours ? ' · ' + esc(c.hours) : ''}</small></div>` +
      `<button data-ac="${i}" aria-label="Als Versorgung übernehmen">＋ Vers.</button><button data-ak="${i}" aria-label="Als Kontrolle übernehmen">＋ Kontr.</button></div>`).join('');
    $('candlist').querySelectorAll('[data-ac]').forEach(b => { b.onclick = () => { const c = S.cand.splice(+b.dataset.ac, 1)[0]; S.supplies.push(c); save(); render(); toast(`${c.name} übernommen`); }; });
    $('candlist').querySelectorAll('[data-ak]').forEach(b => { b.onclick = () => {
      const c = S.cand[+b.dataset.ak];
      if (!(c.km > 0 && c.km < S.dist)) return alert(`Kontrollen müssen zwischen 0 und ${S.dist} km liegen.`);
      S.cand.splice(+b.dataset.ak, 1); S.controls.push({ name: c.name, km: c.km }); save(); render(); toast(`${c.name} als Kontrolle übernommen`);
    }; });
  }

  function supplyHtml() {
    const cur = S.curKm || 0, now = Date.now();
    const rideEta = km => now + Math.max(0, km - cur) / S.speed * 3600000;
    const remW = Math.max(0, S.bottle - Math.max(0, cur - S.fillKm) / S.speed * S.drink);
    const rangeW = remW / S.drink * S.speed, rangeF = Math.max(0, S.foodMax - Math.max(0, cur - S.foodFillKm));
    const line = (icon, pts, range, rem) => {
      if (S.dist - cur <= range * 0.85) return `<div class="ok">${icon} Reicht bis ins Ziel (Rest ${rem}).</div>`;
      const ahead = pts.filter(p => p.km > cur + 0.05);
      const g = greedyStops(ahead, cur, S.dist, range * 0.85);
      const nx = ahead[0], st = g.stops[0], noReach = g.holes.length && g.holes[0].from === cur;
      let h = `<div class="${noReach ? 'bad' : 'warn'}">${icon} `;
      if (noReach) h += `<b>Kein Punkt in Reichweite!</b> Nächster: ${nx ? `${esc(nx.name)} in ${(nx.km - cur).toFixed(1)} km` : 'keiner'} (Rest ${rem}).`;
      else h += `Spätestens auffüllen: <b>${esc(st.name)}</b> in ${(st.km - cur).toFixed(1)} km (km ${st.km}). Rest ${rem}.`;
      if (nx && st && nx !== st) h += `<br><small>Nächster Punkt überhaupt: ${esc(nx.name)} in ${(nx.km - cur).toFixed(1)} km</small>`;
      const t = noReach ? nx : st;
      if (t && t.oh && t.oh.state === 'closing') h += `<br><b class="warn">⚠ ${esc(t.name)} schließt ca. ${t.oh.closesInMin} min nach deiner Ankunft</b>`;
      if (t && t.lat) h += ` <a href="${mapsUrl(t.lat, t.lon)}" target="_blank" rel="noopener">➤ Navi</a>`;
      return h + '</div>';
    };
    return '<div class="sep"></div>' +
      line('💧', waterPts(rideEta, true), rangeW, `~${remW.toFixed(1)} L / ${rangeW.toFixed(0)} km`) +
      line('🍞', foodPts(rideEta, true), rangeF, `~${rangeF.toFixed(0)} km`);
  }

  // ---------- GPS ----------
  let watchId = null, wl = null, gps = {}, lastPos = null, lastDraw = 0;
  const GPS_ERR = { 1: 'Standort nicht erlaubt – in den Browser-Einstellungen freigeben.', 2: 'Kein GPS-Signal.', 3: 'GPS antwortet nicht – suche weiter…' };
  async function wake() { try { wl = await navigator.wakeLock.request('screen'); } catch (_) { /* nicht unterstützt */ } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (watchId != null) wake(); renderRide(); } });
  $('gpsbtn').onclick = () => {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId); watchId = null; if (wl) { wl.release(); wl = null; }
      gps = {}; lastPos = null; return renderGps();
    }
    if (!navigator.geolocation) return alert('Dieser Browser bietet kein GPS.');
    watchId = navigator.geolocation.watchPosition(onPos, e => { gps.err = GPS_ERR[e.code] || e.message; renderGps(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    wake(); renderGps();
  };
  function onPos(p) {
    const c = p.coords;
    gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, spd: c.speed, idx: gps.idx };
    if (ROUTE) {
      const n = nearest(ROUTE, gps.lat, gps.lon, gps.idx, 600);
      gps.idx = n.i; gps.off = n.d;
      if (n.d < 400 && c.accuracy < 100) S.curKm = Math.round(n.km * 10) / 10;
    } else if (c.accuracy < 40) {
      // GPS-Zähler: Sprünge > 500 m (Signalverlust) und Zittern < 10 m ignorieren
      if (lastPos) {
        const d = hav(lastPos[0], lastPos[1], gps.lat, gps.lon);
        if (d >= 10 && d < 500) { S.odo = (S.odo || 0) + d / 1000; S.curKm = Math.round(S.odo * 10) / 10; lastPos = [gps.lat, gps.lon]; }
        else if (d >= 500) lastPos = [gps.lat, gps.lon];
      } else lastPos = [gps.lat, gps.lon];
    }
    save(); renderGps();
    if (Date.now() - lastDraw > 5000) { lastDraw = Date.now(); renderRide(); }
  }
  function renderGps() {
    const on = watchId != null, b = $('gpsbtn');
    b.textContent = on ? '📡 GPS ausschalten' : '📡 GPS starten';
    b.classList.toggle('primary', !on);
    let h;
    if (!on) h = `<small>${ROUTE ? 'Route geladen: km-Stand kommt automatisch aus der Position.' : 'Ohne GPX-Route zählt GPS die gefahrenen km.'} Bildschirm bleibt an, solange GPS läuft.</small>`;
    else if (gps.err) h = `<div class="bad">${esc(gps.err)}</div>`;
    else if (gps.lat == null) h = '<div class="warn">Suche Position…</div>';
    else h = `<small>±${Math.round(gps.acc)} m` + (gps.spd != null ? ` · ${(gps.spd * 3.6).toFixed(1)} km/h` : '') +
      (ROUTE ? (gps.off < 400 ? ' · auf der Route' : ` · <b class="bad">${Math.round(gps.off)} m abseits der Route!</b>`) : ' · GPS-Zähler') + '</small>';
    $('gpsinfo').innerHTML = h;
  }

  // ---------- Packliste ----------
  function renderCheck() {
    const groups = Object.entries(DEFAULT_CHECK).map(([g, it]) => [g, it, false]);
    if (S.custom.length) groups.push(['Eigene', S.custom, true]);
    const all = groups.reduce((a, g) => a.concat(g[1]), []), done = all.filter(i => S.check[i]).length;
    $('checkprog').textContent = `${done} / ${all.length} erledigt`;
    $('check').innerHTML = groups.map(([g, items, own]) => `<h3>${g}</h3>` + items.map((i, k) =>
      `<label class="ck"><input type="checkbox" data-i="${esc(i)}" ${S.check[i] ? 'checked' : ''}> <span style="flex:1">${esc(i)}</span>${own ? `<button class="x" data-dc="${k}" aria-label="Punkt löschen">✕</button>` : ''}</label>`).join('')).join('');
    $('check').querySelectorAll('input').forEach(c => { c.onchange = () => { S.check[c.dataset.i] = c.checked; save(); renderCheck(); }; });
    $('check').querySelectorAll('[data-dc]').forEach(b => { b.onclick = e => { e.preventDefault(); const it = S.custom.splice(+b.dataset.dc, 1)[0]; delete S.check[it]; save(); renderCheck(); }; });
  }
  $('addi').onclick = () => { const v = $('newi').value.trim(); if (v && !S.custom.includes(v)) { S.custom.push(v); $('newi').value = ''; save(); renderCheck(); } };
  $('newi').onkeydown = e => { if (e.key === 'Enter') $('addi').click(); };
  $('resetc').onclick = () => { S.check = {}; save(); renderCheck(); };

  // ---------- Logbuch & Daten ----------
  function renderLog() {
    $('logt').innerHTML = S.log.length ? '<tr><th>Zeit</th><th>Kontrolle</th><th>km</th><th>Reserve</th></tr>' +
      S.log.map(l => `<tr><td>${fmt(l.ts)}</td><td>${esc(l.name)}</td><td>${l.km}</td><td class="${l.close - l.ts < 0 ? 'bad' : ''}">${fmtDur(l.close - l.ts)}</td></tr>`).join('')
      : '<tr><td class="mu">Noch keine Stempel. Im Tab „Unterwegs" abstempeln.</td></tr>';
    $('undo').disabled = !S.log.length; $('csv').disabled = !S.log.length;
  }
  $('undo').onclick = () => {
    const l = S.log[S.log.length - 1]; if (!l || !confirm(`Stempel „${l.name}" (${fmtT(l.ts)}) entfernen?`)) return;
    S.log.pop(); delete S.done[l.key || l.km + '|' + l.name]; save(); render(); toast('Stempel entfernt');
  };
  $('csv').onclick = () => {
    const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const d = ms => { const x = new Date(ms); return `${pad(x.getDate())}.${pad(x.getMonth() + 1)}.${x.getFullYear()}`; };
    const t = ms => { const x = new Date(ms); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
    const rows = [['Datum', 'Uhrzeit', 'Kontrolle', 'km', 'Öffnet', 'Schließt', 'Reserve (h:mm)']].concat(S.log.map(l =>
      [d(l.ts), t(l.ts), l.name, String(l.km).replace('.', ','), l.open ? t(l.open) : '', t(l.close), fmtDur(l.close - l.ts).replace(' h', '')]));
    download('brevet-logbuch.csv', '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
  };
  $('newride').onclick = () => {
    if (!confirm('Neue Fahrt beginnen?\n\nStempel, Logbuch, km-Stand und Füllstände werden zurückgesetzt. Planung, Kontrollen, Route und Versorgungspunkte bleiben.')) return;
    Object.assign(S, { done: {}, log: [], curKm: 0, odo: 0, fillKm: 0, foodFillKm: 0 }); save(); render(); toast('Bereit für die neue Fahrt');
  };
  $('export').onclick = () => download('brevet-daten.json', JSON.stringify({ app: 'brevet', v: 1, state: S, route: ROUTE }), 'application/json');
  $('import').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'brevet' || !d.state) throw new Error();
      if (!confirm('Alle aktuellen Daten durch die Sicherung ersetzen?')) return;
      S = Object.assign(defaults(), d.state); ROUTE = d.route || null;
      if (ROUTE) store(RKEY, ROUTE); else localStorage.removeItem(RKEY);
      save(); showTab(S.tab); toast('Sicherung geladen');
    } catch (_) { alert('Die Datei ist keine Brevet-Sicherung.'); }
  };

  function render() {
    setVal('dist', S.dist); setVal('start', S.start); setVal('speed', S.speed); setVal('pause', S.pause);
    renderPlan(); renderRide(); renderGps(); renderSup(); renderCheck(); renderLog();
  }
  showTab(S.tab);
  setInterval(() => { if (!document.hidden) renderRide(); }, 30000);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
