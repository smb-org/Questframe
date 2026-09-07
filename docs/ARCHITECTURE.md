# Architektur

## Laufzeit

Eine Cloudflare-Worker-Deployment-Einheit liefert sowohl die statische React-Anwendung als auch API, OAuth und WebSocket-Upgrades aus. Ein benanntes SQLite Durable Object ist die einzige autoritative Zustandsinstanz eines Kanals.

```text
Twitch OAuth ──> Worker Gateway ──> Channel Durable Object (SQLite)
                       │                    │
                       │                    ├─ Zustand + Revision
                       │                    ├─ Sessions + CSRF
                       │                    ├─ Audit + Undo
                       │                    ├─ Token-Hashes
                       │                    └─ hibernierende WebSockets
                       │
Static Assets ─────────┴──> Admin-Konsole / transparentes OBS-Overlay
```

Der Worker prüft Origin, Bodygrößen, Routen und öffentliche Overlay-Limits. Das Durable Object serialisiert Mutationen, validiert den finalen Zustand und veröffentlicht nach dem SQLite-Commit immer vollständige Snapshots. Es gibt keine Feld-für-Feld-Liveupdates.

## Win-Challenges-Modul

Das Modul ist als Feature-Slice unter `src/modules/win-challenges/` geschnitten: Contracts,
Domain, Kommando-Service, Repository-Interface, SQLite-Adapter, UI und drei Style-Chunks.
Der Host behält Routentabelle, Socket-Authentifizierung und -Broadcasts sowie die
Style-Zeremonien und Audio-Policy. Es gibt bewusst keinen Sammel-Index. Ein Fabrik-Einstieg
würde Kommandoschicht, Repository und Zod über einen gemeinsamen Import bis in das
Overlay-Bundle ziehen. Der Host erstellt Service und Adapter; die Overlay-Quelle importiert
nur die dafür freigegebenen UI-, Domain- und Predicate-Teile.

Die vier Tabellen `wc_meta`, `wc_challenges`, `wc_commands` und `wc_dock_tokens` werden als
`MIGRATION_3` in derselben linearen Migrationskette wie der übrige Kanal angelegt. Der
`wc_`-Präfix ist eine interne Adapterkonvention und ausschließlich dort festgelegt; Domain,
Service und Repository-Interface kennen keine SQL-Tabellennamen und bieten keine
Präfix-Konfiguration nach außen an.
Die Challenge-Settings enthalten neben Style, Fläche und Kopfzeile `max_visible`, Überlaufmodus,
Tempo, Nummerierung, erledigte Reihenfolge sowie `global_timer_mode` und
`global_timer_total_ms`; Migration 7 ergänzt die Überlauffelder, überführt `plain-numbered` zu
`plain-list` mit Nummerierung und lässt `max_visible` als Anzeige-Kapazität bestehen, Migration 8
ergänzt den globalen Timer-Modus mit dem Default `down`.

## Zwei Nebenläufigkeitsmodelle

Hier bestehen absichtlich zwei Modelle nebeneinander, die nicht vereinheitlicht werden
dürfen:

- Live-Kommandos sind in `transactionSync` atomar und über `wc_commands` mit
  `commandId` plus Request-Hash idempotent. Sie verwenden keine Revision und können wegen
  paralleler Änderungen nicht mit `revision_conflict` scheitern. Ein identischer Retry wird
  als Replay beantwortet; ein anderer Inhalt mit derselben ID ist ein Idempotenzfehler.
- Board- und Settings-Saves sind optimistisch. Board und Settings führen getrennte
  Revisionen; Lesen, Prüfen und Schreiben liegen jeweils in derselben Transaktion. Eine
  veraltete Revision antwortet mit `revision_conflict` und dem aktuellen vollständigen
  Snapshot im Body.

Das erste Modell schützt den laufenden Stream vor Konfliktdialogen, das zweite verhindert
stilles Überschreiben in der Konfiguration.

## Socket-Tags und Broadcasts

Es gibt fünf Tags: `editor`, `overlay`, `composite`, `challenge` und `dock`. Die
Broadcast-Regeln sind fest verdrahtet:

| Broadcast | erreicht | erreicht nicht |
| --- | --- | --- |
| `state_committed` und `snapshot` | `editor`, `overlay`, `composite` | `challenge`, `dock` |
| `challenge_update` | `editor`, `challenge`, `dock`, `composite` | `overlay` |
| `overlay_presence`, `history_changed`, `audit_appended` | `editor` | `overlay`, `composite`, `challenge`, `dock` |

Der Dock-Token ist schreibberechtigt, aber seine Sicherheitsgrenze ist hart: Er gilt nur für
`/api/challenges/commands` und `/ws/dock`. Board, Settings, HUD-State, Token-Rotation und
alle anderen Routen bleiben Session-only. Auch `resetGlobalTimer` ist Session-only; der Dock
darf den globalen Timer nur starten und pausieren.

Der Widerruf wird vor jedem Senden geprüft, nicht nur beim Schließen einer Verbindung. Ein
Socket mit veralteter Token-Generation wird übersprungen und geschlossen. Eine Rotation
sendet `token_revoked` und schließt die betroffenen Sockets aktiv. `overlay`, `composite` und
`challenge` authentifizieren sich mit demselben Overlay-Token; ein Widerruf oder eine Rotation
dieses Tokens schließt darum alle drei Tag-Gruppen gemeinsam, während der Dock-Token
ausschließlich `dock`-Sockets betrifft.

Jede Client-Fläche sendet auf einem offenen Socket alle 20 Sekunden den Text `ping`; das
Durable Object beantwortet ihn per Auto-Pong, ohne dafür aufzuwachen. Beim nächsten Upgrade
werden offene Sockets mit einem Heartbeat-Zeitstempel älter als 70 Sekunden mit 4006
(`stale_heartbeat`) geschlossen und geben ihren Platz frei. Sockets ohne Zeitstempel werden
bewusst nie aussortiert: Ein altes Bundle nach einem Deploy kann noch ohne Heartbeat laufen,
und sein Schließen würde eine sofortige Reconnect-Schleife erzeugen.

## Flächen und Routenauflösung

Die Routentabelle in `src/routing.ts` löst fünf Flächen auf: `admin`, `overlay`,
`composite`, `challenges` und `live`.

| Fläche | Route | App bzw. Workspace |
| --- | --- | --- |
| `admin` | `/admin`, `/admin/composition`, `/admin/challenges` | `AdminApp`, HUD- bzw. Challenges-Tab |
| `overlay` | `/overlay` | `OverlayApp` |
| `composite` | `/overlay/all` | `CompositeApp` |
| `challenges` | `/overlay/challenges` | `ChallengeSourceApp` |
| `live` | `/live/challenges` | `LiveApp` |

`/admin` ist die zusammengelegte Kompositions-Ansicht mit Tabs für HUD und Challenges.
`/admin/composition` und `/admin/challenges` bleiben gültige Einstiegs-URLs, wählen beim
Laden nur den jeweiligen Tab vor und normalisieren die Adresse per `history.replaceState`
auf `/admin`.

`/overlay/all` liefert HUD und Challenge-Log zusammen in einem vollflächigen
1920 × 1080-Dokument. Es ist über den Overlay-Token authentifiziert (`x-overlay-token`
bzw. dasselbe Token im Socket-Protokoll) und verbindet sich über `/ws/composite`.

Der Kopier-Link im OBS-Chip der Admin-Topbar zeigt auf diese Sammelquelle, nicht auf
`/overlay`. Die einzelnen HUD- und Challenge-Log-Quellen bleiben trotzdem gültig und
sind über die OBS-Einrichtung weiterhin einzeln erreichbar.

Die spezifischeren Pfade stehen vor den Präfixpfaden. `/login` und unbekannte Pfade fallen
auf die Admin-Auflösung zurück; der Pfad entscheidet damit vor dem Lazy-Import, welches
Bundle überhaupt geladen wird.

## Veröffentlichungsgrenze

Die Admin-Konsole hält `draft` und `committed` getrennt. Texteingaben, Slider, Pet, Gruppe, Themes und Effekte verändern ausschließlich `draft`. Save sendet `baseRevision` plus vollständigen Draft. Bei einer parallelen Änderung antwortet der Server mit Konflikt; die UI bietet dann Serverstand laden oder einen explizit gegen die inzwischen beobachtete Revision geschützten Replace an.

Nur der globale Sichtbarkeitsschalter ist eine unmittelbare Mutation. Er bewahrt einen vorhandenen lokalen Draft und veröffentlicht eine neue Revision mit unverändertem HUD-Inhalt.

`compositeHudVisible` und `compositeChallengesVisible` sind zwei weitere State-Felder (Default `true`) und laufen über denselben HUD-Speicherweg wie Pet, Gruppe, Themes und Effekte, inklusive Undo und Audit. Sie steuern nicht die Sichtbarkeit im HUD- bzw. Challenges-Overlay selbst, sondern die Mitgliedschaft von HUD und Challenge-Log in der Sammelquelle `/overlay/all`.

HUD-State, Challenge-Settings und Challenge-Board bleiben drei unabhängige Revisionen
(siehe „Zwei Nebenläufigkeitsmodelle“), aber die Oberfläche hat dafür nur noch eine
Speicher-Stelle: `GlobalSaveBar` in `src/admin/AdminWorkspace.tsx`. Die Leiste erscheint,
sobald mindestens ein Modul ungespeicherte Änderungen hat, benennt die betroffenen Module
und speichert sie der Reihe nach. Die Module melden dafür Dirty-Zustand und ihr `save()`
nach oben; das HUD über `useHudEditorState`, die beiden Challenge-Module über
`onHandleChange`.

Ein atomares Speichern über alle drei gibt es nicht — es sind drei Endpunkte mit drei
Revisionen. Die Leiste hält das aus, statt es zu verstecken: Sie speichert sequenziell,
hält beim ersten Fehler an, wechselt in den Tab des betroffenen Moduls und lässt es
dirty; bereits gespeicherte Module bleiben gespeichert. Die Konfliktauflösung liegt
weiterhin im jeweiligen Modul, weil nur dort der Serverstand gegen den eigenen Entwurf
gestellt werden kann.

Positionen haben keinen Sonderweg: Die HUD-Position liegt im HUD-Draft, die Position des
Challenge-Logs im Settings-Draft, beide werden vom jeweiligen Modul mitgespeichert.

Die OBS-Einrichtung öffnet als natives `<dialog>` statt inline in der Vorschau; dessen
`showModal()` übernimmt Fokusfalle und Top-Layer-Darstellung, sodass die Bühne dahinter
unverändert stehen bleibt.

## Authentifizierung

Twitch Authorization Code + PKCE authentifiziert den Benutzer. Der Broadcaster wird über die exakte konfigurierte String-ID erkannt; andere Benutzer sind nur dann Editor, wenn Twitch den konfigurierten Kanal in ihren aktuell moderierten Kanälen liefert. Tokens liegen AES-GCM-verschlüsselt und kontextgebunden im Durable Object. Undurchsichtige Session-Cookies sind HMAC-signiert, `HttpOnly`, `SameSite=Lax` und in HTTPS-Umgebungen `Secure`. Mutationen verlangen zusätzlich Same-Origin und ein an Session plus Browser-Tab gebundenes CSRF-Token.

Die stündliche Revalidierung entzieht bei Rollenverlust die Session. Geheimnisse und rohe Twitch-Fehler werden weder an Clients noch in Health-Antworten ausgegeben.

## Overlay und Ausfallsicherheit

Der OBS-Link enthält einen zufälligen 256-Bit-Token. Server-seitig existieren für ihn der gepfefferte HMAC-Hash zur heißen Verifikation und eine AES-GCM-verschlüsselte Kopie zur Wiederherstellung durch berechtigte Editor:innen. Der AES-Schlüssel wird aus dem `OVERLAY_TOKEN_PEPPER` per SHA-256 abgeleitet und die Capsule-ID als zusätzlicher Verschlüsselungskontext gebunden. Nach erfolgreicher WebSocket-Authentifizierung speichert das Overlay den letzten vollständigen Snapshot unter einem Schlüssel aus Schema, Capsule und gekürztem Token-Fingerprint. Ohne je erfolgreiche Authentifizierung bleibt es leer. Ein aktiver Widerruf leert Anzeige und Cache. Tokens aus der Zeit vor der Envelope-Migration bleiben für die Verifikation gültig, sind aber nicht wiederherstellbar und müssen einmalig rotiert werden.

Effektzeiten sind ISO-Instant-Zeitpunkte. Der Overlay-Browser berechnet die Restzeit lokal und erzeugt dadurch keinen Sekundentakt im Backend. Uploads werden als kleine, geprüfte WebP-Dateien separat gespeichert; im Zustand stehen nur Hash, Maße und Länge.

## Zustands- und Release-Kompatibilität

`schemaVersion: 1` enthält bereits alle V1b-Felder. Staging und Production bleiben zunächst serverseitig auf V1a, während lokal V1b aktiv ist. Der servereigene Capability-Manifest verhindert, dass ein V1a-Client Pet, Gruppe, Undo oder fremde Themes einschleust. Die spätere V1b-Aktivierung ändert keine gespeicherte Schemaform.

## Kapazitätsgrenzen

- vollständiger Zustand: 64 KiB;
- WebSocket-Nachricht: 96 KiB;
- gewöhnlicher JSON-Body: 128 KiB;
- Bootstrap: 256 KiB;
- Portrait: 256 KiB kodiert, quadratisch und höchstens 512 × 512;
- zehn Overlay-, zehn Editor-Sockets, acht Effekte und fünf Gäste pro Capsule;
- Audit und Revisionshistorie werden begrenzt aufbewahrt.

Bundle-, Transfer- und Startupbudgets sind ausführbare CI-Gates in `scripts/` und keine bloße Dokumentation.
