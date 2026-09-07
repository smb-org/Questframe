# Win-Challenge in StreamElements

Wenn OBS erreichbar ist, ist eine eigene **Browserquelle** auf
`https://hud.example.invalid/overlay/challenges#token=…` der einfachere Weg.
Diese Dateien sind für den Fall, dass nur StreamElements zur Verfügung steht.

1. In StreamElements: Overlay öffnen → *Add Widget* → *Static/Custom* → *Custom Widget*.
2. Die Tabs füllen: `widget.html` → HTML, `widget.js` → JS, `fields.json` → Fields.
   Der CSS-Tab bleibt leer, die Styles stehen im HTML.
3. Im Feld *Overlay-URL* die echte URL samt Overlay-Token eintragen — den vollen
   Pfad `/overlay/challenges#token=…`, **nicht** nur die Domain. Der Token steht im
   Hash, nicht in der Query (`tokenFromLocation` in `src/challenges/wire.ts` liest
   ausschließlich `location.hash`). Die Wurzel `/` rendert die Admin-App und ist
   bewusst nicht einbettbar.
4. Widget-Box auf die gewünschte Größe ziehen; das Overlay skaliert mit dem Rahmen.

Nach `/admin` → Token rotieren muss die URL im Widget neu eingetragen werden.

## Warum das eine Sonderbehandlung braucht

StreamElements rendert jedes Widget in einem `<iframe sandbox="allow-scripts">`
**ohne** `allow-same-origin`. Das Dokument darin hat einen opaken Origin (`null`).
Daraus folgen zwei Dinge, die die Overlay-Auslieferung berücksichtigen muss:

- **`frame-ancestors` fehlt bei `/overlay` und `/overlay/*` absichtlich.** Ein
  `frame-ancestors *` würde die Einbettung gerade verhindern: `*` deckt laut
  CSP-Spec nur Netzwerk-Schemata ab und schließt opake Origins aus. Nur das
  vollständige Weglassen der Direktive erlaubt jeden Einbetter.
- **Die CSP nennt den Origin ausgeschrieben statt `'self'`.** `'self'` matcht bei
  opakem Origin auf nichts, wodurch die Seite ihr eigenes JS, CSS und ihre Fonts
  nicht mehr laden dürfte. Bei normalem Aufruf ist der ausgeschriebene Origin
  exakt gleich streng. `scripts/render-headers.mjs` setzt ihn beim Build je
  Umgebung aus `wrangler.jsonc` ein.
- **`/_app/*` und `/fonts/*` senden `Access-Control-Allow-Origin: *`**, weil sie aus
  dem opaken Origin zu Cross-Origin-Requests werden. Das sind gebaute Artefakte
  ohne Geheimnisse; HTML, `/api/*` und `/admin` bleiben unangetastet.

`tests/unit/deployment/headers.test.ts` hält diese Zusagen fest.

**Nur `/overlay/challenges` trägt in StreamElements.** Die HUD-Oberfläche
`/overlay` lädt ihre Medien per `fetch` von `/api/media/*` mit einem
`Authorization`-Header; das bräuchte aus dem opaken Origin zusätzlich eine
OPTIONS-Preflight-Behandlung im Worker, die es bewusst noch nicht gibt.
