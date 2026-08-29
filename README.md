# IRL Stream HUD

Ein WoW-inspiriertes, transparentes OBS-HUD für IRL-Streams. Twitch-Moderator:innen und der Broadcaster bearbeiten einen lokalen Entwurf in einer Web-Konsole; erst **Änderungen speichern** veröffentlicht einen vollständigen, atomaren Stand. Das Overlay erhält neue Revisionen über eine hibernierende Durable-Object-WebSocket-Verbindung und zählt absolute Effektzeiten im Browser herunter.

Enthalten sind:

- frei konfigurierbares Spieler-Unitframe mit HP, Ressource, Name, Titel, Level und Portrait;
- Classic Remix (Standard), Modern Compact und Modern Minimal;
- 20 Buffs und 20 Debuffs, zeitlos oder mit absolutem Ablauf, davon höchstens eine sichtbare Beschreibung;
- optionales Pet und bis zu fünf kompakte Gäste, einschließlich Twitch-Portraits;
- sofortiger globaler Overlay-Schalter, auch in der mobilen Notfallansicht;
- Audit-Log, Undo, konfliktgeschütztes Speichern und widerrufbare OBS-Tokens.

## Lokal starten

Voraussetzungen sind Node.js 24+, npm 11+ und der von Playwright installierte Chromium.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Für lokale Entwicklung steht `/auth/dev` als absichtlich nur unter `APP_ENV=local` verfügbarer Login bereit. Danach öffnet `/admin` die Konsole. Das lokale Cloudflare-SQLite-Durable-Object liegt in Wranglers Projektzustand und berührt weder Staging noch Production.

Die vier Beispiel-Secrets müssen vor dem Start ersetzt werden. Einen passenden 32-Byte-Base64url-Wert erzeugt beispielsweise:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

`SESSION_COOKIE_KEYS` und `SESSION_ENCRYPTION_KEYS` sind JSON-Keyrings. Für eine Rotation wird der bisher aktive Eintrag als `previous` behalten:

```json
{
  "active": { "id": "2026-09", "key": "NEUER_43_ZEICHEN_KEY" },
  "previous": { "id": "2026-08", "key": "ALTER_43_ZEICHEN_KEY" }
}
```

## Twitch und Cloudflare einrichten

1. In der Twitch Developer Console eine Anwendung anlegen. OAuth-Callback ist je Umgebung exakt `https://DEINE-DOMAIN/auth/twitch/callback`.
2. In `wrangler.jsonc` unter `env.staging.vars` beziehungsweise `env.production.vars` `TWITCH_CLIENT_ID`, `BROADCASTER_ID`, `PUBLIC_ORIGIN`, `CAPSULE_ID`, `CAPSULE_NAME` und `TIMEZONE` je Deployment setzen. `CAPSULE_ID` bleibt nach dem ersten Einsatz stabil; `BROADCASTER_ID` bleibt eine Dezimalzeichenkette, nie eine JavaScript-Zahl.
3. Für jede Umgebung vier separate Secrets setzen:

   ```bash
   npx wrangler secret put TWITCH_CLIENT_SECRET --env staging
   npx wrangler secret put SESSION_COOKIE_KEYS --env staging
   npx wrangler secret put SESSION_ENCRYPTION_KEYS --env staging
   npx wrangler secret put OVERLAY_TOKEN_PEPPER --env staging
   ```

   Dasselbe mit `--env production` und unabhängigen Werten wiederholen.

4. Staging nach dem vollständigen Gate deployen: `npm run deploy:staging`.
5. `/healthz` prüfen, über Twitch anmelden und den Ablauf in [docs/OPERATIONS.md](docs/OPERATIONS.md) durchführen.
6. Production wird erst nach Freigabe mit `npm run deploy:production` aktualisiert.

Broadcaster und aktuell eingetragene Twitch-Moderator:innen erhalten dieselbe Editor-Rolle. Die App fordert keine Chat-, E-Mail- oder OBS-Berechtigungen an. Staging und Production müssen eigene Twitch-Anwendungen, Origins, Secrets, Overlay-Tokens und Durable-Object-Namensräume verwenden.

Der erste Login erzeugt einen neutralen Zustand mit Initialen. Name, Titel, Level, Ressource und Portrait werden anschließend in der Admin-Konsole für den jeweiligen Stream konfiguriert.

## OBS verbinden

1. In der Desktop-Konsole **OBS-Link → OBS-Link erzeugen** wählen.
2. Den nur in dieser Browsersitzung angezeigten Link kopieren.
3. In OBS eine Browserquelle mit `1920 × 1080`, Zoom `100 %` und transparentem Hintergrund anlegen.
4. Den Link einsetzen. Das HUD ist oben links verankert; freie Fläche bleibt transparent.

Bei einem Leak erzeugt **Neuen Token erzeugen** sofort eine neue URL und sperrt die alte. Die OBS-Quelle muss anschließend einmalig auf den neuen Link umgestellt werden. Ein widerrufenes verbundenes Overlay leert Zustand und lokalen tokengebundenen Snapshot sofort.

## Qualitätsgates

```bash
npm run check
```

Das Gate prüft Assets, Wrangler-Typen, TypeScript, ESLint, Coverage, Worker-Integration, Playwright, Bundle-/Transferbudgets und den lokalen Wrangler-Startup-Profiler. Die getestete Browserbasis ist der im Lockfile gepinnte Playwright-Chromium; OBS/CEF kann davon abweichen und wird deshalb zusätzlich im Stream-Rehearsal geprüft.

## Cloudflare Free Tier

Die Architektur benötigt nur Workers Static Assets und ein SQLite Durable Object; R2, D1, KV und kostenpflichtige Cloudflare-Dienste sind nicht erforderlich. Die vorgesehene Nutzung ist auf konservative Grenzen ausgelegt (ein Kanal, zwei Overlay- und zehn Editor-Verbindungen, fünf Gäste, acht Effekte, begrenzte Historie). Das ist bewusst **keine** Zusage unbegrenzter dynamischer Nutzung: Cloudflare kann Quoten ändern, und ungewöhnlich hoher oder missbräuchlicher Traffic kann Limits erreichen. Statische, fingerprinted App-Bundles werden am CDN langfristig gecacht; HUD-Grafiken revalidieren über ETags.

## Weitere Dokumentation

- [Designsystem](DESIGN.md)
- [Architektur](docs/ARCHITECTURE.md)
- [Betrieb, Rehearsal und Rollback](docs/OPERATIONS.md)
- [Release-Report-Vorlage](docs/RELEASE_REPORT.md)
- [Visual-Asset-Provenienz](src/assets/provenance/README.md)
- [Vollständige Produktspezifikation](docs/superpowers/specs/2026-08-28-irl-stream-hud-design.md)

## Lizenz

Code und eigens erzeugte HUD-Grafiken stehen unter der [MIT-Lizenz](LICENSE). Atkinson Hyperlegible Next steht unter der mitgelieferten [SIL Open Font License](public/fonts/OFL.txt). Hochgeladene oder Twitch-gelieferte Portraits bleiben Inhalte ihrer jeweiligen Rechteinhaber und sind nicht Teil der Repository-Lizenz.
