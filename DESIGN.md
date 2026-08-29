# IRL Stream HUD — Designsystem

Dieses Dokument ist die verbindliche visuelle Referenz für Admin-Konsole und OBS-Overlay. Ausgangspunkt ist der freigegebene [Modern-Broadcast-Entwurf](docs/design/irl-stream-hud-wireframe-v4.html); das Produkt übersetzt die Lesbarkeit eines modernen Broadcast-Tools in ein eigenständiges, nur lose von klassischen Fantasy-Unitframes inspiriertes HUD.

## Gestaltungsprinzipien

1. **Stream zuerst.** Das HUD belegt oben links höchstens `630 × 259 px` bei einer OBS-Fläche von `1920 × 1080`. Außerhalb der Frames bleibt die Ausgabe vollständig transparent.
2. **Zustand vor Dekoration.** HP, Ressource, Effektzeit und Sichtbarkeit müssen auch in Bewegung und auf kleinen Displays sofort erkennbar sein. Ornament darf keine Information verdrängen.
3. **Editor bleibt Werkzeug.** Die Konsole ist dunkel, ruhig und dicht. Gold markiert Auswahl und Publikation; Grün bestätigt, Rot warnt. Entwürfe sehen wie Entwürfe aus und erreichen OBS erst nach Speichern.
4. **Eigenständige Bildsprache.** Geschmiedetes Metall, Messing, Wald- und Kartenmotive zitieren Outdoor-Abenteuer. Es werden keine extrahierten Spielelemente, Logos oder Franchise-Symbole verwendet.

## Typografie

- UI- und HUD-Leseschrift: **Atkinson Hyperlegible Next**, variable Gewichte `200–800`, selbst gehostet unter `public/fonts/`.
- Display-Schrift: `Georgia` als systemstabile Serifenschrift für Namen und Überschriften.
- Zahlen in Bars, Countdown und Revisionen nutzen tabellarische Ziffern, wo wechselnde Breiten Unruhe erzeugen würden.
- Kleinsttext im HUD bleibt bei mindestens `8 px`, Bedienoberflächen bei mindestens `10 px`; wesentliche Bedienelemente liegen bei `12–13 px`.
- Die Fontdatei steht separat unter der beiliegenden [SIL Open Font License](public/fonts/OFL.txt).

## Farb- und Oberflächentokens

| Token | Wert | Rolle |
| --- | --- | --- |
| Admin-Hintergrund | `#0d1013` | Arbeitsfläche |
| Fläche 1 / 2 / 3 | `#15191d` / `#1b2025` / `#232a30` | Hierarchie ohne Kartenstapel |
| Linie | `#2a3239` | ruhige Trennung |
| Primärtext | `#eef1ef` | hohe Lesbarkeit |
| Sekundärtext | `#929da3` | Metadaten |
| Messing | `#d5aa57` | Auswahl, Fokus, Save |
| Erfolg | `#5ed08a` | verbunden, publiziert |
| Fehler | `#f36d74` | kritisch, getrennt |
| Twitch | `#a970ff` | ausschließlich Twitch-Herkunft |

Classic Remix verwendet nahezu schwarzes Metall (`#0a0d10`), warmes Messing (`#d6a84d`) und cremefarbenen Text (`#f7f2e6`). Die HP-Bar ist bei `50–100 %` grün, bei `20–49 %` gelb und unter `20 %` rot mit dezenter Leuchtanimation. Ressourcentyp und -farbe sind konfigurierbar; der Name steht nicht in der Bar.

## Geometrie und Rhythmus

- Admin-Raster Desktop: `238 px` Audit, flexible Vorschau, `390 px` Editor; Topbar `64 px`.
- Basiseinheit: `4 px`; häufige Abstände `8`, `12`, `16`, `20`, `24 px`.
- Bedienelemente: mindestens `38 px` hoch, primäres Speichern `44 px`; Fokusrahmen `2 px` mit sichtbarem Offset.
- OBS: Spielerframe `408 × 92 px`; Supportreihe beginnt bei `y=99`; Buffs, Pet und kompakter Tooltip teilen sich bewusst den linken Block. Gruppe bleibt rechts kompakt und auf fünf Frames begrenzt.
- Portraits sind kreisförmig im Classic Remix und abgerundete Rechtecke in den modernen Varianten. Zuschnitt ist immer `object-fit: cover`.

## Themes

- **Classic Remix** ist Standard: dunkles Metall, Messingkontur, runde Hauptportraits, klare zweiteilige Bars.
- **Modern Compact** reduziert Ornament, nutzt kühles Cyan und kompakte Broadcast-Karten.
- **Modern Minimal** verwendet flache Flächen, ruhiges Mauve und die geringste visuelle Masse.

Alle drei Themes verändern nur Darstellung. Zustand, Schwellen, Informationsreihenfolge, Maße der OBS-Fläche und Fallbacks bleiben identisch.

## Interaktion und Bewegung

- Slider und Felder ändern ausschließlich den lokalen Entwurf. Nur **Änderungen speichern** publiziert atomar.
- Der Sichtbarkeitsschalter ist eine eigene sofortige Aktion und bleibt mobil erreichbar.
- Effekt hinzufügen/bearbeiten öffnet ein fokussiertes Flyover; es verschiebt das Arbeitsraster nicht. Escape, Backdrop und Schließen beenden es kontrolliert.
- Übergänge liegen üblicherweise bei `160–240 ms`. Kritische HP pulsiert langsam (`1.35 s`) und ohne Flackern.
- Bei `prefers-reduced-motion: reduce` entfallen nicht notwendige Animationen und Übergänge.

## Responsive Regeln

Unter `760 px` wird die Konsole zur Notfallansicht: Status, globaler Sichtbarkeitsschalter, HP, Ressource, Effekte und Speichern bleiben verfügbar. Setup, OBS-Link, Pet, Gruppe, Audit und große Vorschau werden ausgeblendet. Diese Reduktion ist beabsichtigt; die vollständige Konfiguration erfolgt am Desktop.

## Barrierefreiheit und Fallbacks

- Farbe ist nie das einzige Signal: Status besitzt Text/Icon, HP behält Prozentzahl und semantische Stufe, Twitch-Gäste erhalten ein dezentes Twitch-Icon.
- Tastaturfokus ist auf allen interaktiven Elementen sichtbar. Dialoge führen Fokus und benennen Fehler am jeweiligen Feld.
- Fehlende Portraits zeigen deterministische Initialen; fehlende Effektbilder zeigen ein neutrales Symbol. Ein ungültiges oder widerrufenes Overlay rendert keinerlei Fehlerfläche, sondern bleibt transparent.
- Nutzertexte werden gekürzt, nicht überlagert; vollständige Effektbeschreibung erscheint höchstens einmal im kompakten Beschreibungsframe.

## Assets und Änderungen

Produktionsassets und ihre MuAPI/Grok-Herkunft sind unter [src/assets/provenance/README.md](src/assets/provenance/README.md) dokumentiert. Der deterministische Build erzeugt die WebP-Derivate; direkte manuelle Änderungen an generierten Dateien sind nicht zulässig. Jede Änderung an Tokens, HUD-Geometrie oder Interaktionsmustern muss dieses Dokument und die betroffenen Komponenten-/Browserprüfungen gemeinsam aktualisieren.
