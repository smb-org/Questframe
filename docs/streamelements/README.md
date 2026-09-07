# Win-Challenge in StreamElements

Wenn OBS erreichbar ist, ist eine eigene **Browserquelle** auf
`https://hud.example.invalid/overlay/challenges#token=…` der einfachere Weg.
Diese Dateien sind für den Fall, dass nur StreamElements zur Verfügung steht.

1. In StreamElements: Overlay öffnen → *Add Widget* → *Static/Custom* → *Custom Widget*.
2. Die Tabs füllen: `widget.html` → HTML, `widget.js` → JS, `fields.json` → Fields.
   Der CSS-Tab bleibt leer, die Styles stehen im HTML.
3. Im Feld *Overlay-URL* die echte URL samt Overlay-Token eintragen — den vollen
   Pfad `/overlay/challenges#token=…&placement=origin`, **nicht** nur die Domain.
   Der Token steht im Hash, nicht in der Query (`tokenFromLocation` in
   `src/challenges/wire.ts` liest ausschließlich `location.hash`). Die Wurzel `/`
   rendert die Admin-App und ist bewusst nicht einbettbar.
4. Widget-Box auf die Größe des Elements ziehen und im SE-Editor positionieren.

`placement=origin` setzt die Quelle in die linke obere Ecke, statt sie an die im
Admin gesetzte Kompositionsposition zu rücken. Ohne das Flag lägen zwei
Positionierungssysteme übereinander: das Element säße irgendwo in einer
1920×1080-Fläche, die man in SE dann als Ganzes verschieben müsste. Die
konfigurierte Skalierung bleibt erhalten, die Größe steuert weiterhin das
Admin-Interface.

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
- **`GET /api/media/*` beantwortet einen OPTIONS-Preflight und sendet ACAO `*`**,
  damit auch die HUD-Fläche `/overlay` ihre Medien aus dem opaken Origin laden
  kann. Die Route ist token-, nicht cookie-authentifiziert; ACAO `*` schließt
  Credentials per Spec aus, es fließt also nie eine Session mit, und ohne
  gültigen Overlay-Token bleibt es bei 403. Die schreibenden Medien-Routen
  bleiben Same-Origin-pflichtig.

`tests/unit/deployment/headers.test.ts` hält diese Zusagen fest.

## Socket-Plätze

Die Challenge-Quelle hat zehn Socket-Plätze (`MAX_CHALLENGE_SOCKETS`).
Hibernierende WebSockets verschwinden nur bei sauberem Schließen, eine
abgestürzte Quelle oder ein neu eingehängtes Widget-iframe hinterlässt also
einen belegten Platz. Deshalb sortiert das Durable Object beim Verbinden alle
nicht mehr offenen Sockets aus (Close-Code 4004).

Eine ältere, lebende Verbindung wird dabei bewusst **nicht** verdrängt. Das war
kurzzeitig anders und erzeugte ein Karussell: sobald mehr Quellen verbinden
wollten als Plätze da waren, warf jede neue die älteste hinaus, die sofort neu
verband und die nächste hinauswarf — die Anzeige verschwand im Sekundentakt.
Über dem Limit wird deshalb abgewiesen; wer mehr Quellen braucht, bekommt mehr
Plätze.
