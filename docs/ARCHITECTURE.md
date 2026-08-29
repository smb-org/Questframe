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

## Veröffentlichungsgrenze

Die Admin-Konsole hält `draft` und `committed` getrennt. Texteingaben, Slider, Pet, Gruppe, Themes und Effekte verändern ausschließlich `draft`. Save sendet `baseRevision` plus vollständigen Draft. Bei einer parallelen Änderung antwortet der Server mit Konflikt; die UI bietet dann Serverstand laden oder einen explizit gegen die inzwischen beobachtete Revision geschützten Replace an.

Nur der globale Sichtbarkeitsschalter ist eine unmittelbare Mutation. Er bewahrt einen vorhandenen lokalen Draft und veröffentlicht eine neue Revision mit unverändertem HUD-Inhalt.

## Authentifizierung

Twitch Authorization Code + PKCE authentifiziert den Benutzer. Der Broadcaster wird über die exakte konfigurierte String-ID erkannt; andere Benutzer sind nur dann Editor, wenn Twitch den konfigurierten Kanal in ihren aktuell moderierten Kanälen liefert. Tokens liegen AES-GCM-verschlüsselt und kontextgebunden im Durable Object. Undurchsichtige Session-Cookies sind HMAC-signiert, `HttpOnly`, `SameSite=Lax` und in HTTPS-Umgebungen `Secure`. Mutationen verlangen zusätzlich Same-Origin und ein an Session plus Browser-Tab gebundenes CSRF-Token.

Die stündliche Revalidierung entzieht bei Rollenverlust die Session. Geheimnisse und rohe Twitch-Fehler werden weder an Clients noch in Health-Antworten ausgegeben.

## Overlay und Ausfallsicherheit

Der OBS-Link enthält einen zufälligen 256-Bit-Token. Server-seitig existiert nur sein gepfefferter HMAC-Hash. Nach erfolgreicher WebSocket-Authentifizierung speichert das Overlay den letzten vollständigen Snapshot unter einem Schlüssel aus Schema, Capsule und gekürztem Token-Fingerprint. Ohne je erfolgreiche Authentifizierung bleibt es leer. Ein aktiver Widerruf leert Anzeige und Cache.

Effektzeiten sind ISO-Instant-Zeitpunkte. Der Overlay-Browser berechnet die Restzeit lokal und erzeugt dadurch keinen Sekundentakt im Backend. Uploads werden als kleine, geprüfte WebP-Dateien separat gespeichert; im Zustand stehen nur Hash, Maße und Länge.

## Zustands- und Release-Kompatibilität

`schemaVersion: 1` enthält bereits alle V1b-Felder. Staging und Production bleiben zunächst serverseitig auf V1a, während lokal V1b aktiv ist. Der servereigene Capability-Manifest verhindert, dass ein V1a-Client Pet, Gruppe, Undo oder fremde Themes einschleust. Die spätere V1b-Aktivierung ändert keine gespeicherte Schemaform.

## Kapazitätsgrenzen

- vollständiger Zustand: 64 KiB;
- WebSocket-Nachricht: 96 KiB;
- gewöhnlicher JSON-Body: 128 KiB;
- Bootstrap: 256 KiB;
- Portrait: 256 KiB kodiert, quadratisch und höchstens 512 × 512;
- zwei Overlay-, zehn Editor-Sockets, acht Effekte und fünf Gäste pro Capsule;
- Audit und Revisionshistorie werden begrenzt aufbewahrt.

Bundle-, Transfer- und Startupbudgets sind ausführbare CI-Gates in `scripts/` und keine bloße Dokumentation.
