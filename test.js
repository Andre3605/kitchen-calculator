// Tests der Rechenlogik: node test.js
const B = require('./app.js');
let fails = 0;
const eq = (name, got, exp) => { if (got !== exp) { fails++; console.log(`✗ ${name}: ${got} (erwartet ${exp})`); } };
const hm = h => { const m = Math.round(h * 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };

// ACP-Öffnungszeiten (offizielle Tabelle)
[[200, '5:53'], [300, '9:00'], [400, '12:08'], [600, '18:48'], [1000, '33:05']].forEach(([k, e]) => eq(`Öffnung ${k} km`, hm(B.openHours(k)), e));
// Schlusszeiten Zwischenkontrollen + Ziel
eq('Schluss 0 km', hm(B.closeHours(0, 200)), '1:00');
eq('Schluss 40 km (≤60-Regel)', hm(B.closeHours(40, 200)), '3:00');
eq('Schluss 120 km', hm(B.closeHours(120, 200)), '8:00');
eq('Schluss 890 km (1000er)', hm(B.closeHours(890, 1000)), '65:23');
[[200, 13.5], [300, 20], [400, 27], [600, 40], [1000, 75]].forEach(([k, e]) => eq(`Ziel-Limit ${k}`, B.closeHours(k, k), e));
eq('Kontrolle hinter Nennstrecke', B.controlTimes(205, 200, 0).close, 13.5 * 3600000);

// Planung: Pause erst nach der ersten Kontrolle
const st = new Date(2026, 10, 14, 6, 0).getTime();
const p = B.plan({ dist: 200, start: '2026-11-14T06:00', speed: 20, pause: 15, controls: [{ name: 'A', km: 100 }] });
eq('ETA Kontrolle A', p[1].eta - st, 5 * 3600000);
eq('ETA Ziel mit 1 Pause', p[2].eta - st, 10.25 * 3600000);

// Öffnungszeiten (14.11.2026 = Samstag)
const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime();
[
  ['Mo-Sa 07:00-20:00; Su off', at(14, 6, 0), 'closed'],
  ['Mo-Sa 07:00-20:00; Su off', at(14, 12, 0), 'open'],
  ['Mo-Sa 07:00-20:00; Su off', at(14, 19, 45), 'closing'],
  ['Mo-Sa 07:00-20:00; Su off', at(15, 12, 0), 'closed'],
  ['24/7', at(15, 3, 0), 'open'],
  ['Mo-Fr 07:00-12:00,14:00-18:00', at(13, 13, 0), 'closed'],
  ['Mo-Fr 07:00-12:00,14:00-18:00', at(13, 15, 0), 'open'],
  ['Fr-Mo 06:00-22:00', at(16, 7, 0), 'open'],
  ['22:00-02:00', at(14, 1, 0), 'open'],
  ['Su off', at(14, 12, 0), 'unknown'],
  ['sunrise-sunset', at(14, 12, 0), 'unknown'],
  ['', at(14, 12, 0), 'unknown'],
].forEach(([h, t, e]) => eq(`Öffnungszeit "${h}"`, B.checkOH(h, t).state, e));
eq('öffnet wieder Mo 07:00', B.checkOH('Mo-Sa 07:00-20:00; Su off', at(14, 21, 0)).opensAt, at(16, 7, 0));

// Greedy-Stopps: Reichweite 50 km, Punkte bei 30/45/80/120, Ziel 200
const g = B.greedyStops([30, 45, 80, 120, 200].map(km => ({ km })), 0, 200, 50);
eq('Stopps', g.stops.map(s => s.km).join(','), '45,80,120,200');
eq('Lücke 120→200', g.holes.map(h => h.from + '-' + h.to).join(','), '120-200');

// Route & GPS-Projektion (gerade Linie nach Norden, ~0,5 km Punktabstand)
const r = B.buildRoute(Array.from({ length: 401 }, (_, i) => [48 + i * 0.0045, 9]));
eq('Routenlänge ~200 km', Math.round(r.cum[r.cum.length - 1] / 1000), 200);
eq('Position bei km 50', Math.round(B.nearest(r, 48 + 0.45, 9.001, null).km), 50);

// Sonne Stuttgart 14.11.2026: Aufgang ~07:29, Untergang ~16:45 (MEZ)
const s = B.sunTimes(48.78, 9.18, at(14, 12, 0));
const loc = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
eq('Sonnenaufgang ±5 min', Math.abs(loc(s.rise) - (7 * 60 + 29)) <= 5, true);
eq('Sonnenuntergang ±5 min', Math.abs(loc(s.set) - (16 * 60 + 45)) <= 5, true);

console.log(fails ? `${fails} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(fails ? 1 : 0);
