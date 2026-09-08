# Betriebshandbuch

## Vor jedem Release

1. Nicht während eines aktiven Streams deployen; ein Worker-Update trennt WebSockets kurzzeitig.
2. `pnpm install --frozen-lockfile` und `pnpm run check` auf dem exakten Commit ausführen.
3. Bei einem lokalen Deploy die ignorierte `.env.staging` beziehungsweise `.env.production` aus dem sicheren Betreiber-Backup bereitstellen. Niemals ihren Inhalt in Terminalausgaben, Tickets oder Git kopieren. Der Deploy-Preflight zeigt ausschließlich betroffene Binding-Namen.
4. Staging mit `pnpm run deploy:staging` aktualisieren und `/healthz` prüfen. Ein `503` nennt ausschließlich fehlende Binding-Namen; diese zuerst beheben.
5. Twitch-Login als Broadcaster und als echter aktueller Moderator testen.
6. Release-Report aus [RELEASE_REPORT.md](RELEASE_REPORT.md) kopieren und Commit, Wrangler-Ausgabe, Chromium-Version und visuelle Artefakte eintragen.

Nach einem Deploy kann eine bereits geöffnete OBS-Browserquelle vorübergehend
unparsbare Nachrichten empfangen, solange OBS noch das alte Bundle hält. Die drei
Quellen heilen sich dabei bewusst unterschiedlich; `src/shared/reconnect.ts` trägt
nur die gemeinsamen Marker- und Backoff-Bausteine, die eigentliche
Watchdog-Ablaufsteuerung bleibt in jeder App:

- `/overlay` (`src/overlay/OverlayApp.tsx`): Ein Parse-Fehler bei einer
  zustandstragenden Nachricht löst nach 1 Sekunde Verzögerung höchstens einen
  Reload-Versuch pro Störung aus; ein Parse-Fehler bei `challenge_update`
  reloadet das HUD nicht. Der Marker wird erst gelöscht, sobald danach wieder
  ein sauberer `snapshot`/`state_committed` ankommt. Bleibt die Quelle dauerhaft
  unparsbar, reloadet sie sich kein zweites Mal von selbst.
- `/overlay/challenges` (`src/challenges/ChallengeSourceApp.tsx`): Reloadet bei
  jedem Parse-Fehler sofort, aber über eine zeitstempelbasierte Sperre höchstens
  einmal alle 5 Minuten.
- `/overlay/all` (`src/composite/CompositeApp.tsx`): Reloadet nur, wenn HUD- und
  Challenge-Modul gleichzeitig unparsbar sind, ebenfalls mit 1 Sekunde
  Verzögerung und einer 5-Minuten-Sperre. Der Marker wird erst gelöscht, wenn
  beide Module wieder sauber sind; ein neu geöffneter Socket setzt beide
  Fehler-Flags aber sofort zurück, ohne dass zuvor ein sauberer Zustand angekommen
  sein muss.

Falls eine Quelle danach weiter eingefroren wirkt, die OBS-Browserquelle einmal
manuell aktualisieren.

Den Button **Verbindungen trennen** im OBS-Einrichtungsfenster nutzt du, wenn die
Plätze voll sind oder eine Anzeigequelle nicht mehr verbindet. Alle Anzeigequellen
verbinden sich danach selbst neu; anders als bei der Token-Rotation bleibt der
Token gültig und keine URL muss geändert werden.

## Deployment-Bindings

`wrangler.jsonc` enthält für Staging und Production nur die bewusst versionierten Schalter `APP_ENV` und `RELEASE_STAGE`; öffentliche Domains werden nicht dort als Route hinterlegt. Alle installationsspezifischen Werte sind verpflichtende Cloudflare-Secrets. `PUBLIC_ORIGIN` steht in der ignorierten `.env.<umgebung>`. Das erste Deployment einer Umgebung muss lokal mit der passenden Datei erfolgen; dabei lädt `--secrets-file` alle zehn Werte gemeinsam hoch und `--domains` wird aus dem Host von `PUBLIC_ORIGIN` abgeleitet. Danach bleiben die Cloudflare-Secrets bei gewöhnlichen Wrangler-Deployments erhalten. Ein Deploy über GitHub Actions ist nicht eingerichtet: die Vorlage liegt als `.github/workflows/deploy.yml.disabled` und ist für GitHub kein Workflow.

Für eine Rotation oder Konfigurationsänderung die private Datei aktualisieren und das jeweilige `pnpm run deploy:*` erneut ausführen. Weil Cloudflare Secret-Werte nach dem Setzen nicht wieder anzeigt, müssen `CAPSULE_ID`, `BROADCASTER_ID`, Origins und Schlüssel in einem sicheren Betreiber-Passwortmanager gesichert bleiben. `CAPSULE_ID` oder `BROADCASTER_ID` nicht als gewöhnliche Rotation behandeln.

Die Vite-Cloudflare-Integration wählt Staging oder Production beim Build, nicht bei einem nachträglichen Wrangler-Aufruf. Deshalb immer die projektspezifischen `deploy:*`- beziehungsweise `build:*`-Skripte benutzen. Deren getrennte Vite-Modusnamen sorgen dafür, dass die passende `.env.staging` oder `.env.production` über Node geladen wird. Der Build-Preflight vergleicht Worker-Name, `APP_ENV`, `RELEASE_STAGE`, `PUBLIC_ORIGIN` und alle erforderlichen Secret-Bindings mit der gewählten Umgebung; erst danach läuft `wrangler deploy` ohne `--env` und mit dem aus `PUBLIC_ORIGIN` abgeleiteten `--domains` gegen die generierte, abgeflachte Konfiguration.

## 30-Minuten-Rehearsal

Der Broadcaster und ein aktueller Moderator bedienen gemeinsam den Staging-Kandidaten. Die OBS-Browserquelle läuft mit `1920 × 1080`, Zoom `100 %` und transparentem Hintergrund.

- Overlay aus- und wieder einschalten, auch einmal mobil.
- Zehn atomare Saves durchführen; mindestens einer ändert HP und die konfigurierte Ressource gleichzeitig.
- Eine Eingabe bewusst langsam tippen und bestätigen, dass Zwischenstände nie in OBS erscheinen.
- Einen zeitlosen und einen absolut terminierten Effekt setzen; Browser neu laden und Ablaufzeit vergleichen.
- Einmal die Netzwerkverbindung trennen, lokalen Snapshot und Countdown beobachten, dann Reconnect und vollständigen Snapshot prüfen.
- Zwei Admin-Tabs öffnen, einen Konflikt erzeugen und beide Konfliktaktionen nachvollziehen.
- OBS-Token rotieren: alte verbundene Anzeige muss leer werden; neue URL muss funktionieren.
- Challenge-Settings für Style, Kopfzeile, Fläche, `max_visible`, Timerdauer, Nummerierung, Überlauf und erledigte Reihenfolge prüfen; Migration 7 ergänzt die Überlauffelder, überführt `plain-numbered` und erhält `max_visible` als Kapazität.
- Pet, fünf Gäste, acht Effekte und jede der sechs Themes auf Überlauf prüfen, sobald V1b aktiviert wird.
- Auf `<50 %` gelb sowie `<20 %` rot und dezent pulsierend prüfen; exakt 50 bleibt grün, exakt 20 gelb.

Jede Unsicherheit wird mit Uhrzeit, Browser, Revision und beobachtetem Verhalten notiert. Ein ungelöster Severity-1-Fehler — falscher veröffentlichter Zustand, unberechtigter Zugriff, nicht widerrufbares Overlay oder sichtbarer Zwischenstand — stoppt die Promotion.

## Production-Promotion

Production nutzt bis zum bestandenen V1a-Rehearsal `RELEASE_STAGE=v1a`. Erst danach darf der Wert in `wrangler.jsonc` bewusst auf `v1b` wechseln und der vollständige V1b-Rehearsal-Teil durchlaufen werden.

1. Production bei der ersten Einrichtung lokal mit `pnpm run deploy:production` initialisieren. Weitere Aktualisierungen laufen ebenfalls lokal.
2. `/healthz`, Twitch-Login, Bootstrap und eine unkritische Sichtbarkeitsmutation prüfen.
3. OBS-Quelle verbinden und vollständigen Snapshot abwarten.
4. Release-Report abschließen. Eine tatsächliche Cloudflare-Deployment-ID und der menschliche Rehearsal-Ausgang dürfen niemals vorab erfunden werden.

## Dock-Token-Leak

Wenn ein Dock-Token geleakt ist, im Challenges-Workspace sofort **Neuen Token erzeugen**
ausführen und bestätigen. Die Rotation widerruft die alte Generation, sendet den betroffenen
Sockets `token_revoked` und schließt sie sofort. Die Prüfung vor jedem Broadcast verhindert
zusätzlich, dass ein alter Dock-Socket zwischen Leak und aktivem Schließen noch ein Update
erhält. Die neue Token-URL beziehungsweise den neuen QR-Code anschließend nur im Dock
einsetzen. URL und QR-Code nicht in Chat, Logs, Screenshots oder Tickets kopieren.

Für einen Token aus der Zeit vor der serverseitigen Wiederherstellung ist der Klartext nicht
verfügbar; diesen Alt-Token einmalig über **Neuen Token erzeugen** rotieren. Ein vollständig
offline befindlicher Browser kann seinen bereits gespeicherten Snapshot nicht remote löschen,
kann mit dem alten Token aber keine neue autorisierte Verbindung aufbauen.

## Rollenverlust oder verdächtige Session

- Moderatorrolle in Twitch entfernen; die nächste Revalidierung entzieht die Session spätestens innerhalb einer Stunde.
- Für sofortigen Entzug Cookie- und Encryption-Keyrings rotieren und den bisherigen Schlüssel nicht als `previous` behalten. Das meldet alle Sitzungen ab, ist daher eine bewusste Incident-Maßnahme.
- Twitch-Client-Secret bei Twitch rotieren und anschließend in Cloudflare aktualisieren.

## Rollback

Nur auf den unmittelbar vorherigen, als Schema-v1-kompatibel geprüften Worker-Build zurückrollen. Kein SQLite-State-Rollback und keine manuelle Tabellenänderung durchführen. Wenn eine Migration oder Staging-Prüfung fehlschlägt, Promotion stoppen; nicht automatisch Production-State zurückschreiben.

Nach dem Rollback `/healthz`, Login, vollständigen Snapshot, Save, Sichtbarkeit und Token-Authentifizierung erneut prüfen. Geladene Dokumente revalidieren; fingerprinted App-Bundles beider kompatibler Builds müssen während des Rollback-Fensters verfügbar bleiben.

## Free-Tier-Beobachtung

Die Betriebsgrundlage sind die gemessenen Free-Tier-Grenzen: 5 Mio. gelesene und 100.000
geschriebene Zeilen pro Tag für SQLite-Durable-Objects, zusätzlich 100.000 DO-Requests pro
Tag sowie ein separates Duration-Budget. Deletes zählen als Writes, Indexänderungen als
zusätzliche Row-Writes. Cloudflare-Quoten vor jeder öffentlichen Veröffentlichung erneut
gegen die aktuelle offizielle Dokumentation prüfen.

Die folgende Baseline stammt aus dem DO-SQLite-Adapter mit drei Challenges. Session-Writes
sind nicht enthalten; insbesondere `editor_sessions.idle_expires_at` kommt bei
authentisierten Aktionen hinzu. Cursor-Werte und Indexkosten sind tatsächlich gemessen:

| Aktion | `rowsWritten` | `rowsRead` |
| --- | ---: | ---: |
| Mutation mit Event, bestehende Challenge, `increment` inklusive Auto-Complete | 4 | 5 |
| `startGlobalTimer` | 3 | 17 |
| `pauseGlobalTimer` | 3 | 18 |
| `resetGlobalTimer` | 3 | 19 |
| Board-Save mit drei neuen Challenges | 7 | 15 |
| Settings-Save | 1 | 15 |
| Snapshot-Read | 0 | 7 |

Einige hundert Live-Kommandos pro Stream liegen damit deutlich unter dem Tageslimit; der
Request-Zähler ist die engere Grenze als der Write-Zähler. Bei ungewöhnlichem Traffic zuerst
verbundene Socket-Zahlen, Rate-Limit-Antworten und Audit-Aktivität prüfen, keinen höheren
Grenzwert blind konfigurieren.

Für die drei funktionsbezogenen Rate-Limiter gelten diese Schlüssel:

| Limiter | Schlüssel | Einsatz |
| --- | --- | --- |
| `OVERLAY_CAPSULE_LIMITER` | `CAPSULE_ID` | alle Overlay- und Challenge-Socket-Upgrades |
| `OVERLAY_TOKEN_LIMITER` | erste 32 Zeichen des SHA-256-Hashes des Overlay-Tokens | `/ws/overlay` und `/ws/challenge` |
| `DOCK_TOKEN_LIMITER` | erste 32 Zeichen des SHA-256-Hashes des Dock-Tokens | Dock-Kommando-Route und `/ws/dock` |

Zusätzlich schützt `DOCK_IP_LIMITER` die Dock-Einstiege pro `cf-connecting-ip` (unbekannte
Quellen teilen sich den Fallback-Schlüssel). Die getrennten Socket-Caps im Durable Object
trennen die Edge-Limiter nicht: Ein Reconnect-Sturm der Challenge-Quelle teilt sich den
Overlay-Token und kann deshalb über `OVERLAY_TOKEN_LIMITER` auch HUD-Verbindungen drosseln.
Bei der Diagnose neben den Socket-Caps die Overlay-Rate-Limit-Antworten prüfen.

Die Anwendung pollt weder Zustand noch Timer.
