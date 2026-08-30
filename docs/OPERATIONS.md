# Betriebshandbuch

## Vor jedem Release

1. Nicht während eines aktiven Streams deployen; ein Worker-Update trennt WebSockets kurzzeitig.
2. `pnpm install --frozen-lockfile` und `pnpm run check` auf dem exakten Commit ausführen.
3. Bei einem lokalen Deploy die ignorierte `.env.staging` beziehungsweise `.env.production` aus dem sicheren Betreiber-Backup bereitstellen. Niemals ihren Inhalt in Terminalausgaben, Tickets oder Git kopieren. Der Deploy-Preflight zeigt ausschließlich betroffene Binding-Namen.
4. Staging mit `pnpm run deploy:staging` aktualisieren und `/healthz` prüfen. Ein `503` nennt ausschließlich fehlende Binding-Namen; diese zuerst beheben.
5. Twitch-Login als Broadcaster und als echter aktueller Moderator testen.
6. Release-Report aus [RELEASE_REPORT.md](RELEASE_REPORT.md) kopieren und Commit, Wrangler-Ausgabe, Chromium-Version und visuelle Artefakte eintragen.

Nach einem Deploy heilt sich eine bereits geöffnete OBS-Browserquelle bei einem
verworfenen Zustands-Snapshot einmalig selbst durch einen Reload. Erst ein danach
wieder akzeptierter Snapshot entsperrt einen weiteren automatischen Heilversuch;
bleibt die Quelle dauerhaft unparsbar, reloadet sie sich nicht erneut von selbst.
Falls die Quelle danach weiter eingefroren wirkt, die OBS-Browserquelle einmal
manuell aktualisieren.

## Deployment-Bindings

`wrangler.jsonc` enthält für Staging und Production nur die bewusst versionierten Schalter `APP_ENV` und `RELEASE_STAGE`. Alle installationsspezifischen Werte sind verpflichtende Cloudflare-Secrets. Das erste Deployment einer Umgebung muss lokal mit der passenden ignorierten `.env.<umgebung>` erfolgen; dabei lädt `--secrets-file` alle zehn Werte gemeinsam hoch. Danach bleiben sie bei gewöhnlichen Wrangler-Deployments erhalten, sodass der GitHub-Workflow keine Klartext-Konfiguration erzeugen muss.

Für eine Rotation oder Konfigurationsänderung die private Datei aktualisieren und das jeweilige `pnpm run deploy:*` erneut ausführen. Weil Cloudflare Secret-Werte nach dem Setzen nicht wieder anzeigt, müssen `CAPSULE_ID`, `BROADCASTER_ID`, Origins und Schlüssel in einem sicheren Betreiber-Passwortmanager gesichert bleiben. `CAPSULE_ID` oder `BROADCASTER_ID` nicht als gewöhnliche Rotation behandeln.

Die Vite-Cloudflare-Integration wählt Staging oder Production beim Build, nicht bei einem nachträglichen Wrangler-Aufruf. Deshalb immer die projektspezifischen `deploy:*`- beziehungsweise `build:*`-Skripte benutzen. Deren getrennte Vite-Modusnamen sorgen dafür, dass `.env.staging` und `.env.production` ausschließlich vom nachfolgenden Wrangler-Secret-Upload gelesen werden. Der Build-Preflight vergleicht Worker-Name, `APP_ENV`, `RELEASE_STAGE` und alle erforderlichen Secret-Bindings mit der gewählten Umgebung; erst danach läuft `wrangler deploy` ohne `--env` gegen die generierte, abgeflachte Konfiguration.

## 30-Minuten-Rehearsal

Der Broadcaster und ein aktueller Moderator bedienen gemeinsam den Staging-Kandidaten. Die OBS-Browserquelle läuft mit `1920 × 1080`, Zoom `100 %` und transparentem Hintergrund.

- Overlay aus- und wieder einschalten, auch einmal mobil.
- Zehn atomare Saves durchführen; mindestens einer ändert HP und die konfigurierte Ressource gleichzeitig.
- Eine Eingabe bewusst langsam tippen und bestätigen, dass Zwischenstände nie in OBS erscheinen.
- Einen zeitlosen und einen absolut terminierten Effekt setzen; Browser neu laden und Ablaufzeit vergleichen.
- Einmal die Netzwerkverbindung trennen, lokalen Snapshot und Countdown beobachten, dann Reconnect und vollständigen Snapshot prüfen.
- Zwei Admin-Tabs öffnen, einen Konflikt erzeugen und beide Konfliktaktionen nachvollziehen.
- OBS-Token rotieren: alte verbundene Anzeige muss leer werden; neue URL muss funktionieren.
- Pet, fünf Gäste, acht Effekte und jede der sechs Themes auf Überlauf prüfen, sobald V1b aktiviert wird.
- Auf `<50 %` gelb sowie `<20 %` rot und dezent pulsierend prüfen; exakt 50 bleibt grün, exakt 20 gelb.

Jede Unsicherheit wird mit Uhrzeit, Browser, Revision und beobachtetem Verhalten notiert. Ein ungelöster Severity-1-Fehler — falscher veröffentlichter Zustand, unberechtigter Zugriff, nicht widerrufbares Overlay oder sichtbarer Zwischenstand — stoppt die Promotion.

## Production-Promotion

Production nutzt bis zum bestandenen V1a-Rehearsal `RELEASE_STAGE=v1a`. Erst danach darf der Wert in `wrangler.jsonc` bewusst auf `v1b` wechseln und der vollständige V1b-Rehearsal-Teil durchlaufen werden.

1. Production bei der ersten Einrichtung lokal mit `pnpm run deploy:production` initialisieren. Danach die geschützte GitHub-Umgebung `production` freigeben oder erneut lokal deployen.
2. `/healthz`, Twitch-Login, Bootstrap und eine unkritische Sichtbarkeitsmutation prüfen.
3. OBS-Quelle verbinden und vollständigen Snapshot abwarten.
4. Release-Report abschließen. Eine tatsächliche Cloudflare-Deployment-ID und der menschliche Rehearsal-Ausgang dürfen niemals vorab erfunden werden.

## Token-Leak

Jede:r berechtigte Editor:in kann den aktuellen Link jederzeit im OBS-Chip des Headers kopieren. Bei einem Token aus der Zeit vor der serverseitigen Wiederherstellung ist der Klartext nicht verfügbar; diesen Alt-Token einmalig über **Neuen Token erzeugen** rotieren. Bei einem Leak weiterhin **Neuen Token erzeugen** klicken und bestätigen. Der alte Token wird sofort widerrufen; verbundene Clients erhalten `token_revoked`, leeren ihre Anzeige und schließen die Verbindung. Den neuen Link anschließend in OBS einsetzen. Den Link nicht in Chat, Logs, Screenshots oder Tickets kopieren.

Ein vollständig offline befindlicher Browser kann seinen bereits gespeicherten Snapshot naturgemäß nicht remote löschen. Er kann mit dem alten Token aber keine neue autorisierte Verbindung aufbauen.

## Rollenverlust oder verdächtige Session

- Moderatorrolle in Twitch entfernen; die nächste Revalidierung entzieht die Session spätestens innerhalb einer Stunde.
- Für sofortigen Entzug Cookie- und Encryption-Keyrings rotieren und den bisherigen Schlüssel nicht als `previous` behalten. Das meldet alle Sitzungen ab, ist daher eine bewusste Incident-Maßnahme.
- Twitch-Client-Secret bei Twitch rotieren und anschließend in Cloudflare aktualisieren.

## Rollback

Nur auf den unmittelbar vorherigen, als Schema-v1-kompatibel geprüften Worker-Build zurückrollen. Kein SQLite-State-Rollback und keine manuelle Tabellenänderung durchführen. Wenn eine Migration oder Staging-Prüfung fehlschlägt, Promotion stoppen; nicht automatisch Production-State zurückschreiben.

Nach dem Rollback `/healthz`, Login, vollständigen Snapshot, Save, Sichtbarkeit und Token-Authentifizierung erneut prüfen. Geladene Dokumente revalidieren; fingerprinted App-Bundles beider kompatibler Builds müssen während des Rollback-Fensters verfügbar bleiben.

## Free-Tier-Beobachtung

Die Anwendung pollt weder Zustand noch Timer. Bei ungewöhnlichem Traffic zuerst verbundene Socket-Zahlen, Rate-Limit-Antworten und Audit-Aktivität prüfen; keinen höheren Grenzwert blind konfigurieren. Cloudflare-Quoten vor jeder öffentlichen Veröffentlichung erneut gegen die aktuelle offizielle Dokumentation prüfen.
