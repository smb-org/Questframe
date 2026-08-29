# IRL Stream HUD Release Report

- Commit/Tag:
- Datum:
- Verantwortlich:
- Ziel: Staging / Production
- Worker-Build-/Deployment-ID:
- Release Stage: V1a / V1b

## Automatische Gates

- `npm ci`:
- `npm run check`:
- Coverage (Statements / Branches / Functions / Lines):
- Worker Bundle gzip:
- Worker Startup Profilfenster / Active:
- Overlay JS / Transfer:
- Admin JS / Transfer:
- Playwright-Version:
- Chromium-Version:
- Screenshot-Artefakte geprüft von:

## Staging Smoke

- `/healthz`:
- Broadcaster OAuth:
- echter Moderator OAuth:
- Bootstrap + atomarer Save:
- Sichtbarkeit off/on:
- Token create/rotate/revoke:
- Reconnect + vollständiger Snapshot:
- Migration idempotent:

## Menschliches Rehearsal

- Broadcaster + Moderator:
- Dauer (mindestens 30 Minuten):
- zehn erfolgreiche Saves:
- Timer über Reload/Reconnect stabil:
- Konflikt behandelt:
- mobile Notfallsteuerung:
- offene Beobachtungen:
- Severity-1-Fehler: keine / Details

## Freigabe

- V1a-Pilot bestanden:
- V1b-Aktivierung freigegeben:
- Production-Approval:
- Rollback-Build:

## Restrisiko

Playwright-Chromium ist das automatisierte Browser-Gate. Die tatsächlich von OBS eingebettete CEF-/Chromium-Version kann bei CSS, Fonts, Codecs, Storage oder WebSockets abweichen und wurde nur dann geprüft, wenn oben ein reales OBS-Rehearsal dokumentiert ist.
