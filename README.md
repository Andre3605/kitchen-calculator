# Brevet-Begleiter

Offline-fähige Web-App (PWA) für Brevetfahrten. Keine Installation, kein Build: `index.html` öffnen oder auf einen Webserver legen und auf dem Handy „Zum Startbildschirm hinzufügen“.

- **Planer:** Öffnungs-/Schlusszeiten je Kontrolle (ACP/Audax), geplante Ankunft aus Ø-Tempo + Pausen, Puffer
- **Unterwegs:** nächste Kontrolle, Restzeit bis Schluss, nötiger Ø bis dahin, Stempel-Buchung
- **Packliste:** abhakbar, eigene Punkte
- **Logbuch:** Stempelzeiten mit Reserve, CSV-Export

Daten bleiben lokal im Browser (localStorage).

## GPS & Versorgung
- **GPX laden** (Tab Versorgung): GPS-Position wird auf die Route gerechnet → km-Stand automatisch, Hinweis bei Abweichung. Ohne GPX läuft ein GPS-Zähler.
- **Wasser/Essen:** Flaschengröße, Trinkmenge (L/h) und max. Essensabstand eingeben. Die App markiert die minimal nötigen Stopps (⭐), warnt vor Lücken und zeigt unterwegs „spätestens auffüllen bei …" inkl. Navi-Link.
- **Online-Suche:** Trinkwasser, Supermärkte, Bäcker, Tankstellen, Cafés entlang der Route (OpenStreetMap/Overpass) – Öffnungszeiten vor Ort prüfen.
- **Öffnungszeiten:** Pro Ort (aus OSM oder manuell, OSM-Format wie `Mo-Sa 07:00-20:00; Su off` oder `24/7`) wird gegen die geplante bzw. – unterwegs – die hochgerechnete Ankunftszeit geprüft. Geschlossene Orte werden nicht als Stopp eingeplant; „schließt in ≤ 30 min" wird gewarnt. Feiertage (PH), Sonnenstand und Monatsregeln werden nicht ausgewertet (Status „❓").
