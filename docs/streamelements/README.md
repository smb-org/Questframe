# Win-Challenge in StreamElements

Der direkte Weg ist eine **OBS-Browserquelle** auf
`https://hud.example.invalid/overlay/challenges?token=…` — dafür braucht es
StreamElements nicht. Diese Dateien sind für den Fall, dass die Challenge im
StreamElements-Overlay liegen soll (eine Browserquelle für alles, Positionierung
im SE-Editor).

1. In StreamElements: Overlay öffnen → *Add Widget* → *Static/Custom* → *Custom Widget*.
2. Die Tabs füllen: `widget.html` → HTML, `widget.js` → JS, `fields.json` → Fields.
   Der CSS-Tab bleibt leer, die Styles stehen im HTML.
3. Im Feld *Overlay-URL* die echte URL samt Overlay-Token eintragen.
4. Widget-Box auf die gewünschte Größe ziehen; das Overlay skaliert mit dem Rahmen.

Nach `/admin` → Token rotieren muss die URL im Widget neu eingetragen werden.
Der Overlay-Pfad erlaubt Framing bewusst (`frame-ancestors * https: http:` in
`public/_headers`); `/admin` und `/login` tun das nicht.
