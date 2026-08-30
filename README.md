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

Voraussetzungen sind Node.js 24+, pnpm 11+ und der von Playwright installierte Chromium.

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm run dev
```

Für lokale Entwicklung steht `/auth/dev` als absichtlich nur unter `APP_ENV=local` verfügbarer Login bereit. Danach öffnet `/admin` die Konsole. Das lokale Cloudflare-SQLite-Durable-Object liegt in Wranglers Projektzustand und berührt weder Staging noch Production.

Die zehn Beispiel-Bindings müssen vor dem Start geprüft beziehungsweise ersetzt werden; insbesondere alle `replace-with-…`-Werte. Einen passenden 32-Byte-Base64url-Wert erzeugt beispielsweise:

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
2. Die ignorierten Deploymentdateien aus den sicheren Vorlagen erzeugen:

   ```bash
   cp .env.staging.example .env.staging
   cp .env.production.example .env.production
   ```

3. In jeder Datei alle zehn Werte ersetzen. Dazu gehören auch `TWITCH_CLIENT_ID`, `BROADCASTER_ID`, `PUBLIC_ORIGIN`, `CAPSULE_ID`, `CAPSULE_NAME` und `TIMEZONE`. Sie sind nicht alle vertraulich, werden aber als externe Cloudflare-Secret-Bindings behandelt, damit keine installationsspezifischen Werte im Repository landen. Staging und Production verwenden unabhängige Twitch-Apps, Schlüssel und Capsule-Werte.

   Um die eigene `BROADCASTER_ID` zu finden, hilft das optionale lokale Skript `pnpm run twitch:id -- <login> [env-datei]`, z.B. `pnpm run twitch:id -- meinlogin .env.staging`. Es liest `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` aus der angegebenen Datei (Standard `.dev.vars`), löst den Login über die Twitch-API auf und gibt die fertige `BROADCASTER_ID=…`-Zeile aus. Das Skript läuft rein lokal und ist optional; es ist nicht Teil von `pnpm run check` oder der Deploy-Skripte und wird weder beim Deployment noch zur Laufzeit ausgeführt.
4. `CAPSULE_ID` nach dem ersten Einsatz stabil halten und sicher außerhalb des Repositories dokumentieren. `BROADCASTER_ID` bleibt eine positive Dezimalzeichenkette, nie eine JavaScript-Zahl; eine Änderung adressiert absichtlich ein anderes Durable Object.
5. Das erste Staging-Deployment lokal ausführen:

   ```bash
   pnpm run deploy:staging
   ```

   Der Preflight prüft Vollständigkeit, Platzhalter, HTTPS-Origin, Twitch-ID, IANA-Zeitzone sowie unabhängige gültige Keyrings. Wrangler lädt die Datei mit `--secrets-file` verschlüsselt zu Cloudflare; Werte erscheinen weder in `wrangler.jsonc` noch in der Kommandozeile. Spätere Code-Deployments erben die Cloudflare-Secrets. Änderungen werden durch einen erneuten Lauf mit der privaten Datei veröffentlicht.

6. `/healthz` prüfen, über Twitch anmelden und den Ablauf in [docs/OPERATIONS.md](docs/OPERATIONS.md) durchführen.
7. Production wird erst nach Freigabe mit `pnpm run deploy:production` initialisiert beziehungsweise aktualisiert.

`.env.staging`, `.env.production`, `.env*` und `.dev.vars*` sind durch `.gitignore` geschützt; ausschließlich die wertfreien `*.example`-Vorlagen werden versioniert. `wrangler.jsonc` deklariert alle zehn Namen über `secrets.required`, sodass ein Erst-Deployment ohne vollständig hinterlegte Bindings hart fehlschlägt.

Die Deploy-Skripte wählen die Cloudflare-Umgebung bereits beim Vite-Build über `CLOUDFLARE_ENV`, prüfen die daraus erzeugte Wrangler-Konfiguration und deployen anschließend genau diesen Build. Eigene Vite-Modusnamen verhindern dabei, dass Vite die privaten `.env.<umgebung>`-Dateien automatisch in den Build-Prozess lädt; nur Wrangler liest sie anschließend über `--secrets-file`. `wrangler deploy --env …` darf hier nicht nachträglich verwendet werden: Die Vite-Integration erzeugt beim Build eine bereits auf eine Umgebung reduzierte Konfiguration.

Broadcaster und aktuell eingetragene Twitch-Moderator:innen erhalten dieselbe Editor-Rolle. Die App fordert keine Chat-, E-Mail- oder OBS-Berechtigungen an. Staging und Production müssen eigene Twitch-Anwendungen, Origins, Secrets, Overlay-Tokens und Durable-Object-Namensräume verwenden.

Der erste Login erzeugt einen neutralen Zustand mit Initialen. Name, Titel, Level, Ressource und Portrait werden anschließend in der Admin-Konsole für den jeweiligen Stream konfiguriert.

## OBS verbinden

1. In der Desktop-Konsole im OBS-Chip **OBS-Link erzeugen** wählen. Existiert bereits ein wiederherstellbarer Token, kann jede:r Editor:in den Link dort jederzeit kopieren.
2. Den angezeigten Link kopieren.
3. In OBS eine Browserquelle mit `1920 × 1080`, Zoom `100 %` und transparentem Hintergrund anlegen.
4. Den Link einsetzen. Das HUD ist oben links verankert; freie Fläche bleibt transparent.

Bei einem Leak erzeugt **Neuen Token erzeugen** sofort eine neue URL und sperrt die alte. Die OBS-Quelle muss anschließend einmalig auf den neuen Link umgestellt werden. Ein Token aus der Zeit vor dieser Änderung muss einmalig rotiert werden, bevor sein Link wieder kopierbar ist. Ein widerrufenes verbundenes Overlay leert Zustand und lokalen tokengebundenen Snapshot sofort.

## Qualitätsgates

```bash
pnpm run check
```

Das Gate prüft die externe Deployment-Konfiguration, Assets, Wrangler-Typen, TypeScript, ESLint, Coverage, Worker-Integration, Playwright, Bundle-/Transferbudgets und den lokalen Wrangler-Startup-Profiler. Die getestete Browserbasis ist der im Lockfile gepinnte Playwright-Chromium; OBS/CEF kann davon abweichen und wird deshalb zusätzlich im Stream-Rehearsal geprüft.

## Cloudflare Free Tier

Die Architektur benötigt nur Workers Static Assets und ein SQLite Durable Object; R2, D1, KV und kostenpflichtige Cloudflare-Dienste sind nicht erforderlich. Die vorgesehene Nutzung ist auf konservative Grenzen ausgelegt (ein Kanal, zehn Overlay- und zehn Editor-Verbindungen, fünf Gäste, acht Effekte, begrenzte Historie). Das ist bewusst **keine** Zusage unbegrenzter dynamischer Nutzung: Cloudflare kann Quoten ändern, und ungewöhnlich hoher oder missbräuchlicher Traffic kann Limits erreichen. Statische, fingerprinted App-Bundles werden am CDN langfristig gecacht; HUD-Grafiken revalidieren über ETags.

## Weitere Dokumentation

- [Designsystem](DESIGN.md)
- [Architektur](docs/ARCHITECTURE.md)
- [Betrieb, Rehearsal und Rollback](docs/OPERATIONS.md)
- [Release-Report-Vorlage](docs/RELEASE_REPORT.md)
- [Visual-Asset-Provenienz](src/assets/provenance/README.md)
- [Vollständige Produktspezifikation](docs/superpowers/specs/2026-08-28-irl-stream-hud-design.md)

## Lizenz

Code und eigens erzeugte HUD-Grafiken stehen unter der [MIT-Lizenz](LICENSE). Atkinson Hyperlegible Next steht unter der mitgelieferten [SIL Open Font License](public/fonts/OFL.txt). Hochgeladene oder Twitch-gelieferte Portraits bleiben Inhalte ihrer jeweiligen Rechteinhaber und sind nicht Teil der Repository-Lizenz.
