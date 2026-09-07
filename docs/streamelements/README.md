# Win-Challenge in StreamElements

Der direkte Weg ist eine **OBS-Browserquelle** auf
`https://hud.example.invalid/overlay/challenges#token=…` — dafür braucht es
StreamElements nicht. Diese Dateien sind für den Fall, dass die Challenge im
StreamElements-Overlay liegen soll (eine Browserquelle für alles, Positionierung
im SE-Editor).

1. In StreamElements: Overlay öffnen → *Add Widget* → *Static/Custom* → *Custom Widget*.
2. Die Tabs füllen: `widget.html` → HTML, `widget.js` → JS, `fields.json` → Fields.
   Der CSS-Tab bleibt leer, die Styles stehen im HTML.
3. Im Feld *Overlay-URL* die echte URL samt Overlay-Token eintragen — den vollen
   Pfad `/overlay/challenges#token=…`, **nicht** nur die Domain. Die Wurzel `/`
   rendert die Admin-App und ist bewusst nicht einbettbar.
4. Widget-Box auf die gewünschte Größe ziehen; das Overlay skaliert mit dem Rahmen.

Nach `/admin` → Token rotieren muss die URL im Widget neu eingetragen werden.
**Achtung, das Custom Widget funktioniert derzeit nicht.** StreamElements rendert
jedes Widget in einem `<iframe sandbox="allow-scripts">` ohne `allow-same-origin`.
Das Dokument hat damit einen opaken Origin (`null`), und daran scheitert dreierlei:
`frame-ancestors *` schließt opake Origins per CSP-Spec aus, alle Subresourcen
(`/_app/*`, `/fonts/*`) werden zu Cross-Origin-Requests ohne `Access-Control-Allow-Origin`,
und `'self'` in der eigenen CSP passt auf keinen Origin mehr. Der unterstützte Weg
ist deshalb die eigene OBS-Browserquelle. Der Overlay-Pfad erlaubt Framing weiterhin
(`frame-ancestors * https: http:`); `/admin` und `/login` tun das nicht.
