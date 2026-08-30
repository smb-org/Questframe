# Visual asset provenance

Die Produktions-Grafik ist original generiert, nicht aus einem Spiel extrahiert. Die
freigestellten Master liegen neben dieser Datei; `pnpm run assets:build` erzeugt daraus
deterministisch die WebP-Derivate unter `public/assets/`.

## Verzeichnisse

| Pfad | Inhalt | Im Repo |
| --- | --- | --- |
| `prompts/` | Die exakten Prompttexte je Variante und Bauteil | ja |
| `muapi/masters/<variante>/` | Freigestellte PNG-Master der ausgewählten Kandidaten | ja |
| `muapi/*.jpg` | Historische Atlas- und Flächenmaster | ja |
| `muapi/mockups/`, `muapi/parts/` | Rohausgaben aller Generierungsläufe | nein (`.gitignore`) |
| `variants.json` | Bauteilvertrag: Zielmaße und Budgets je Bauteil | ja |

## Erzeugung

Alle Bilder entstanden am 2026-08-29 über die konfigurierte MuAPI-Verbindung mit
`grok-imagine-text-to-image-quality` (CLI-Alias `grok-quality`). Jeder Prompt schloss Text,
Zahlen, Buchstaben, Logos, Runen, Wasserzeichen, Franchise-Symbole und kopierte Spiel-UI
explizit aus. Die Bar-Tröge und die Portraitöffnung sind in jedem Master leer, damit Füllung,
Name und Levelzahl ausschließlich aus CSS kommen und HP auch wirklich leer sein kann.

Die Freistellung erfolgte über MuAPI-Background-Removal. Ab dem freigestellten PNG ist der
Build vollständig offline und deterministisch: trimmen, verzerrungsfrei in die Zielbox
skalieren, als WebP mit Alphakanal schreiben.

### Ältere Master

| Master | MuAPI request | Selected output | Zweck |
| --- | --- | --- | --- |
| `muapi/buff-atlas-master.jpg` | `f78ad76b-15cd-4c97-8741-f44599eb1797` | `10c4b582720347d8a00e92a742d99cf4.jpg` | 5×4 Atlas für die 20 Standard-Buffs |
| `muapi/debuff-atlas-master.jpg` | `29f85977-299c-4886-8136-3d1206dd83a0` | `2c1977bee40045afb204028f92cc062e.jpg` | 5×4 Atlas für die 20 Standard-Debuffs |
| `muapi/classic-remix-master.jpg` | `b7fbd9ba-5554-49d9-9731-04a48e541b64` | `4757744c15a2423fba507587193e16b2.jpg` | Historische Flächengrafik, seit der Variantenumstellung nicht mehr gebaut |

## Neue Variante hinzufügen

Die folgenden Assetschritte gelten für Bildvarianten. Eine reine CSS-Variante wie
`classic-simple`, `modern-compact` oder `modern-minimal` beginnt bei Schritt 5 und lässt die
Asset-Slots bewusst auf `none`.

1. Prompttexte unter `prompts/<variante>-{player,level,pet,party,effect}.txt` ablegen.
2. Kandidaten generieren, einen je Bauteil auswählen und freistellen.
3. Freigestellte PNGs als `muapi/masters/<variante>/{player,level,pet,party,effect}.png` ablegen.
4. Variantennamen in `variants.json` unter `variants` ergänzen.
5. `src/overlay/themes/<variante>/theme.css` anlegen und in `src/overlay/HudRenderer.tsx` importieren.
6. Theme-ID in `src/shared/contracts/state.ts`, `src/overlay/wire.ts` und das Label in
   `src/admin/AdminWorkspace.tsx` ergänzen.

## Rebuild und Prüfung

```sh
pnpm run assets:build
pnpm run assets:verify
```

Geprüft werden der vollständige erwartete Dateisatz je Variante, Format, exakte Maße,
Alphakanal und die Einzelbudgets aus `variants.json`.
