# Brevet-Begleiter

Offline-fähige Web-App (PWA) für Brevetfahrten (200–1000 km). Kein Build, keine Abhängigkeiten.

## Öffnen
- **Am PC testen:** `index.html` öffnen (GPS und Offline-Betrieb gehen so nicht).
- **Fürs Handy:** Ordner per https bereitstellen (GitHub Pages: Settings → Pages → Branch wählen, oder Netlify Drop), Adresse am Handy öffnen → „Zum Startbildschirm". Einmal mit Netz öffnen, danach läuft sie offline.

## Funktionen
| Tab | Inhalt |
|---|---|
| **Planer** | Öffnungs-/Schlusszeiten nach ACP/Audax, geplante Ankunft (Ø + Pausen), Puffer je Kontrolle, engste Stelle, 🌙 Dunkel-Abschnitte (mit GPX) |
| **Unterwegs** | GPS → km-Stand auf der Route (ohne GPX: GPS-Zähler), Restzeit bis Kontrollschluss, nötiger Ø, vor/hinter Plan, „spätestens auffüllen bei …", Stempeln (auch mit nachgetragener Uhrzeit) |
| **Versorgung** | GPX-Import (Wegpunkte werden als Vorschläge übernommen), OSM-Suche entlang der Route, Öffnungszeiten gegen Ankunftszeit, minimale Wasser-/Essens-Stopps (⭐) mit 15 % Reserve, Lücken-Warnung |
| **Packliste** | Abhakbar, eigene Punkte |
| **Logbuch** | Stempelzeiten mit Reserve, Rückgängig, CSV für Excel, Neue Fahrt, Sicherung speichern/laden (Gerätewechsel) |

Daten bleiben lokal im Browser.

## Öffnungszeiten-Format
OSM-Syntax, z. B. `Mo-Sa 07:00-20:00; Su off`, `Mo-Fr 07:00-12:00,14:00-18:00`, `24/7`, `22:00-02:00`.
Nicht ausgewertet (Status ❓): Feiertage `PH`, Monats-/Wochenregeln, `sunrise-sunset`.

## Tests
`node test.js` – prüft ACP-Zeiten, Pausenrechnung, Öffnungszeiten, Stopp-Planung, GPS-Projektion und Sonnenzeiten.
