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

Die HP-Bar ist bei `50–100 %` grün, bei `20–49 %` gelb und unter `20 %` rot mit dezenter Leuchtanimation. Jede Variante stimmt Sättigung, Materialgradient, Rundung und Glanz auf ihren Rahmen ab. Konfigurierbare Ressourcenfarben werden mit der Materialfarbe der Variante gemischt, damit sie nicht wie ein Fremdkörper wirken. Der Name steht nie in der Bar.

## Geometrie und Rhythmus

- Admin-Raster Desktop: `238 px` Audit, flexible Vorschau, `390 px` Editor; Topbar `64 px`.
- Basiseinheit: `4 px`; häufige Abstände `8`, `12`, `16`, `20`, `24 px`.
- Bedienelemente: mindestens `38 px` hoch, primäres Speichern `44 px`; Fokusrahmen `2 px` mit sichtbarem Offset.
- Portraits sind kreisförmig in den Bildvarianten und abgerundete Rechtecke in den modernen Varianten. Zuschnitt ist immer `object-fit: cover`.

### OBS-Geometrievertrag

Die Stage bleibt `630 × 259 px` bei einer OBS-Fläche von `1920 × 1080`. Alle Werte sind
Custom Properties in [src/overlay/hud.css](src/overlay/hud.css) und liegen im Koordinatensystem
der Stage beziehungsweise des Spielerframes.

| Bauteil | Position und Größe | Zweck |
| --- | --- | --- |
| Spielerframe | `x=0, y=0`, `430 × 175` | Bildvarianten strecken ihr Asset über ein horizontales 3-Slice auf diese Breite |
| Portrait, Name und Bars | variantenspezifische Aperturwerte | sitzen innerhalb der gezeichneten beziehungsweise CSS-basierten Aussparungen |
| Levelmedaillon | variantenspezifisch im Spielerframe | eigenes Frame-Bauteil, kein Portraitkind |
| Effektreihe | `x=0, y=179, 285 × 34` | acht Icons à `33 px` mit `3 px` Abstand |
| Pet | `x=0, y=215`, Höhe `44`; Breite `138–214` | Companion als kompaktes Unitframe |
| Featured Effect | `x=294, y=179, 136 × 80` | Beschreibungsframe |
| Gruppe | `x=440, y=0`, Höhe `259`; Breite `148–190` | fünf Frames à `47 px` mit `6 px` Abstand |

Die veröffentlichbare HUD-Skalierung reicht von `75 %` bis `200 %`. Die gesamte Stage wird um
ihren linken oberen Ursprung skaliert; Aperturpositionen, Portraitgrößen, Balkenabstände und
Medaillons bleiben dadurch proportional. Der Browservertrag prüft den vollständigen API-Pfad
für `75 / 100 / 125 / 150 / 175 / 200 %` und normalisiert die Trail-Aperturen auf ihre Basiswerte.

### Challenge-Board-Admin

Das Challenge-Board ist ein eigener Vollbreiten-Workspace unter `/admin/challenges`; es wird
nicht in die HUD-`editor-rail` eingehängt. Der Inhaltsbereich ist bis `1200 px` breit und
zentriert. Eine Challenge-Zeile besteht aus Sortiergriffen, Definitionsfeldern und einer
separaten Laufzeitstatusfläche. Sortiergriffe und Feldsteuerungen sind mindestens `38 px`
hoch, die Board-Aktion `Board speichern` mindestens `44 px`. Das Board nutzt ausschließlich
die bestehenden Admin-Tokens für Flächen, Linien, Text, Messing, Erfolg und Fehler; neue
Farben sind nicht vorgesehen. Status werden zusätzlich zur Farbe immer durch Text oder ein
Symbol codiert. Konflikte und Merge-Folgen stehen oberhalb der Save-Aktion und bleiben bei
`prefers-reduced-motion: reduce` ohne notwendige Bewegung oder Übergang.

Das Levelmedaillon ist ein Geschwisterelement von Portrait und Body. Es darf niemals Kind des
geclippten Portraits sein, sonst wird die Zahl beschnitten.

### Challenge-Browserquellen

Das Challenges-Log ist eine eigene Browserquelle unter `/overlay/challenges`. Es berührt den
`630 × 259 px`-Geometrievertrag des HUDs nicht und verwendet seinen eigenen `--wc-*`-Tokenvertrag.
Der Vertrag umfasst `--wc-surface`, `--wc-line`, `--wc-text`, `--wc-muted`, `--wc-accent`,
`--wc-ok`, `--wc-font-ui`, `--wc-font-display` und `--wc-row-height`; diese Werte gelten
auch ohne HUD und ohne geladene Theme-CSS. `themeMode: inherit` lädt die ausgewählte
HUD-Variante als dynamischen Chunk in dieses eigene Dokument, setzt die passende
`.hud-theme--…`-Klasse und mappt die Modul-Tokens dort auf die geladenen `--hud-*`-Werte.
Bereits geladene Chunks bleiben aktiv, deshalb steuert der Root mit `data-theme-mode` und
`data-style`, welche Brücken- und Stilregeln gelten. `surface` verwendet die eigene Fläche
mit 88 % und Haarlinie sowie Gewicht 500/600 ohne Schatten und garantiert Lesbarkeit; `bare`
entfernt die Fläche, erhöht die Mindestschrift um zwei Stufen und nutzt Gewicht 700 sowie
den Konturschatten für Text, Haarlinien, Fortschrittsbalken und den kritischen Timer-Puls.
`bare` maximiert die Lesbarkeit ohne Garantie.
Die Live-Bedienseite unter `/live/challenges` ist keine Ausgabequelle, sondern eine per
Dock-Token authentifizierte Bedienfläche. Beide Interaktionsflächen übernehmen dieselben
Touch-Ziele: `44 px` für `+` und `−`, `38 px` für alle übrigen Steuerelemente.

### Challenge-Stile

Die Challenge-Quelle hat drei Styles: `plain-list`, `plain-bullets` und `quest-log`.
`ChallengeStyleId` bestimmt ausschließlich die Struktur der Quelle, also etwa
Listenmarker, Zeilenaufbau und die eigene Rahmenbehandlung. Die Materialwelt kommt getrennt
aus Theme und Flächenmodus: `themeMode` wählt die Modulwelt oder die geerbte HUD-Variante,
`surfaceMode` wählt `surface` oder `bare`. Ein Style ist deshalb keine Materialvariante und
erzeugt keine eigene Kombination aus allen Themes und Flächen.

Die Nummerierung ist ein eigener Schalter und verwendet stabile Positionen der nicht
versteckten Challenges. Bei Überlauf kann die Quelle abschneiden, paginieren oder weich
scrollen; Tempo und erledigte Reihenfolge sind ebenfalls eigene Einstellungen.

CSS wird in der langlebigen Browserquelle nie entladen. Ein bereits geladener Style- oder
Theme-Chunk bleibt aktiv; Umschalten erfolgt über `data-style` und `data-theme-mode` am Root.
Alle Brücken-, Style- und Materialregeln sind über diese Attribute gescoped, damit ein
früher geladener Chunk keinen späteren Zustand überlagert.

## Varianten

Es gibt sechs Unitframe-Varianten. Drei tragen generierte Rahmengrafik, drei sind rein aus CSS gebaut.

| ID | Name | Material |
| --- | --- | --- |
| `trail-wood` | Trail Wood | geschnitztes Walnuss- und Eichenholz, Hanfseil, Moos |
| `field-journal` | Field Journal | gealtertes Leder, gewachstes Segeltuch, geprägte Höhenlinien |
| `forged-compass` | Forged Compass | geschwärztes Metall, matter Goldrand, Kompassrose |
| `classic-simple` | Classic Simple | transparente Zwischenräume; lokale Stahlplatten für Name und Bars, runde Portraits, klassische gewölbte Füllungen |
| `modern-compact` | Modern Compact | kühles Cyan, kompakte Broadcast-Karten, ohne Bildassets |
| `modern-minimal` | Modern Minimal | flache halbtransparente Flächen, ohne Bildassets |

`trail-wood` ist Standard. Die historische ID `classic-remix` wird beim Lesen automatisch auf
`trail-wood` abgebildet.

Alle sechs Varianten verändern nur Darstellung. Zustand, Schwellen, Informationsreihenfolge, Maße
der OBS-Fläche und Fallbacks bleiben identisch.

### Modulare Trennung

[src/overlay/hud.css](src/overlay/hud.css) trägt das gesamte Layout und kennt keine Variante.
Jede Variante liegt in einem eigenen Verzeichnis unter `src/overlay/themes/<variante>/theme.css`
und setzt ausschließlich Custom Properties:

- **Asset-Slots** — `--hud-player-chrome-image`, `--hud-level-chrome-image`, `--hud-pet-chrome-image`, `--hud-party-chrome-image`, `--hud-effect-bezel-image`.
- **Material-Slots für Varianten ohne Bildassets** — `--hud-body-*`, `--hud-compact-*`, `--hud-level-*`, `--hud-portrait-ring`, `--hud-portrait-radius`.
- **Geometrie** — dieselben Positionsvariablen wie der Geometrievertrag, falls eine Variante ihr Medaillon oder ihre Namensplatte auf ihr eigenes Asset ausrichten muss.
- **Farben, Bar-Material und Typografie** — `--hud-name-*`, `--hud-level-color`, `--hud-trough-*`, `--hud-health-*`, `--hud-fill-*`, `--hud-resource-*`.

Eine Variante fasst keine Selektoren aus `hud.css` an. Das Portrait sitzt über dem Chrome-Layer
in der Rahmenöffnung; das Asset braucht daher keinen Alphaausschnitt.

## Interaktion und Bewegung

- Slider und Felder ändern ausschließlich den lokalen Entwurf. Nur **Änderungen speichern** publiziert atomar.
- Der Sichtbarkeitsschalter ist eine eigene sofortige Aktion und bleibt mobil erreichbar.
- Effekt hinzufügen/bearbeiten öffnet ein fokussiertes Flyover; es verschiebt das Arbeitsraster nicht. Escape, Backdrop und Schließen beenden es kontrolliert.
- Übergänge liegen üblicherweise bei `160–240 ms`. Kritische HP pulsiert langsam (`1.35 s`) und ohne Flackern. Derselbe Puls gilt für einen globalen Challenge-Timer mit weniger als einer Minute Restzeit; dafür gibt es keine zweite Animationsdauer.
- Bei `prefers-reduced-motion: reduce` entfallen nicht notwendige Animationen und Übergänge.
  Bei Challenge-Zeremonien entfällt nur die Bewegung; die Zustandsänderung bleibt über den
  aktualisierten Zähler, Häkchen, Durchstreichung oder ein Symbol erkennbar. Ton bleibt
  aktiv, solange der globale `effects_enabled`-Schalter aktiv ist, weil reduzierte Bewegung
  nichts über Ton aussagt.
- Ton ist immer eine Zugabe zur sichtbaren Zustandsänderung und nie deren Informationsträger.
  Zähler, Text, Häkchen, Durchstreichung und Symbole bleiben ohne Ton vollständig
  verständlich; `effects_enabled` darf nur die Zeremonie stummschalten.

## Responsive Regeln

Unter `760 px` wird die Konsole zur Notfallansicht: Status, globaler Sichtbarkeitsschalter, HP, Ressource, Effekte und Speichern bleiben verfügbar. Setup, OBS-Link, Pet, Gruppe, Audit und große Vorschau werden ausgeblendet. Diese Reduktion ist beabsichtigt; die vollständige Konfiguration erfolgt am Desktop.

## Barrierefreiheit und Fallbacks

- Farbe ist nie das einzige Signal: Status besitzt Text/Icon, HP behält Prozentzahl und semantische Stufe, Twitch-Gäste erhalten ein dezentes Twitch-Icon.
- Tastaturfokus ist auf allen interaktiven Elementen sichtbar. Dialoge führen Fokus und benennen Fehler am jeweiligen Feld.
- Fehlende Portraits zeigen deterministische Initialen; fehlende Effektbilder zeigen ein neutrales Symbol. Ein ungültiges oder widerrufenes Overlay rendert keinerlei Fehlerfläche, sondern bleibt transparent.
- Nutzertexte werden gekürzt, nicht überlagert; vollständige Effektbeschreibung erscheint höchstens einmal im kompakten Beschreibungsframe.

## Assets und Änderungen

Produktionsassets und ihre Herkunft sind unter [src/assets/provenance/README.md](src/assets/provenance/README.md) dokumentiert. Die Bar-Tröge und Portraitöffnungen sind in jedem Master leer; Füllung, Name und Levelzahl kommen ausschließlich aus CSS. Der deterministische Build erzeugt die WebP-Derivate; direkte manuelle Änderungen an generierten Dateien sind nicht zulässig. Jede Änderung an Tokens, HUD-Geometrie oder Interaktionsmustern muss dieses Dokument und die betroffenen Komponenten-/Browserprüfungen gemeinsam aktualisieren.
