# TODOS

Zurückgestellte Arbeit mit genug Kontext, dass sie in drei Monaten noch verständlich ist.

---

## Offset-Handshake für die Overlay-Uhr

**Was:** Das Overlay soll die Zeitdifferenz zwischen dem OBS-Rechner und dem Server messen
und beim Rechnen mit absoluten Endzeitpunkten berücksichtigen.

**Warum:** Das Overlay rechnet heute mit `Date.now()` (`src/overlay/OverlayApp.tsx:86`),
fordert `time_sync` nie an, und sein handgeschriebener Parser akzeptiert die Nachricht gar
nicht (`src/overlay/wire.ts:194`). Serverseitig existiert die Antwort bereits
(`src/channel/channel-object.ts:1018`), es fehlt ausschließlich die Client-Seite.

Geht die Uhr des Streaming-Rechners falsch, zeigt das Overlay Effekt-Timer entsprechend
falsch an. Das ist kein hypothetischer Fall: absolute Endzeitpunkte (`expiresAt`) werden
lokal gegen eine möglicherweise falsche Uhr gerechnet. Zuschauer sehen dann einen
Countdown, der nicht zum tatsächlichen Ablauf passt.

**Pros:** Behebt einen bestehenden Fehler. Das geplante Win-Challenges-Modul benutzt
dasselbe Muster (`timer_ends_at` als absoluter Instant) und würde das Problem sonst erben,
also ist es ein Fix für zwei Features.

**Cons:** Berührt `wire.ts` und `OverlayApp.tsx` und damit das Overlay-Bundle, das unter
einem harten 120-KiB-Gate steht (`scripts/check-build-budgets.mjs:116`). Der Zuwachs muss
gemessen werden.

**Kontext:** Aufgefallen im `/plan-eng-review` am 2026-08-30 beim Entwurf der
Challenge-Timer (`docs/designs/win-challenges-module.md`). Bewusst aus dem Modul
herausgehalten, weil es beide Timer-Arten betrifft und mit Challenges nichts zu tun hat.
Im Design-Doc steht der Befund unter "Bekannte Grenze außerhalb dieses Moduls".

**Wo anfangen:** `time_sync` in den Exact-Key-Parser in `wire.ts` aufnehmen, beim
Verbinden ein `time_sync_request` senden (das Schema existiert bereits in
`src/shared/contracts/api.ts` als `clientMessageSchema`), den Offset im Overlay halten und
statt `Date.now()` eine korrigierte Zeitquelle verwenden. Danach das Bundle-Gate messen.

**Hängt ab von:** Nichts. Kann unabhängig gebaut werden, auch vor dem Challenge-Modul.

---

## Kapsel-Rate-Limiter greift vor der Token-Prüfung

**Was:** Der Rate-Limiter vor den Websocket-Routen soll sich nicht mehr von unauthentifizierten
Verbindungsversuchen leeren lassen.

**Warum:** `src/worker/index.ts:624` ruft `OVERLAY_CAPSULE_LIMITER.limit({ key: env.CAPSULE_ID })`
auf, bevor irgendjemand das Token geprüft hat — die Prüfung passiert erst im Durable Object
(`connectPresenceSocket`, `src/channel/channel-object.ts`). Der Kapsel-Eimer ist ausschließlich
nach `CAPSULE_ID` gekeyt und erlaubt 60 Versuche pro 10 Sekunden (`wrangler.jsonc:19-23`).
Wer die Kapsel-URL kennt, kann mit beliebigen zufälligen 43-Zeichen-Tokens dagegenhämmern:
Die Form-Prüfung (`/^[A-Za-z0-9_-]{43}$/`) lässt sie durch, der Eimer läuft leer, und
legitime Reconnects von `/overlay`, `/overlay/all` und `/overlay/challenges` bekommen 429 —
ohne dass der Angreifer je ein gültiges Token besitzt.

Der zweite Limiter (`OVERLAY_TOKEN_LIMITER`) ist nach Token-Hash gekeyt und trifft den
Angreifer nicht, weil jedes zufällige Token einen eigenen Eimer bekommt.

**Pros:** Betrifft alle drei OBS-Quellen gleichzeitig, also genau den Moment, in dem ein
Stream läuft und eine Quelle neu verbinden will. Der Fix ist lokal im Worker-Eingang.

**Cons:** Jede Lösung hat einen Haken. Den Limiter hinter die Token-Prüfung zu ziehen heißt,
dass ungültige Versuche das Durable Object erreichen (Kosten, DO-Last). Zusätzlich nach
Client-IP zu keyen hilft gegen Einzelquellen, nicht gegen verteilte Versuche, und CF-Connecting-IP
ist bei manchen OBS-Setups (VPN, Mobilfunk) instabil.

**Kontext:** Gefunden am 2026-08-31 im Codex-Gegenreview zur Sammelquelle `/overlay/all`.
Bestandsproblem, nicht durch die Sammelquelle entstanden — sie erbt den Pfad nur mit.
Bewusst nicht im selben Zug gefixt, weil das Keying eine eigene Entscheidung mit eigener
Testfläche ist.

**Wo anfangen:** `src/worker/index.ts:612-632` ist die ganze Stelle. Zu klären ist die
Reihenfolge (Limiter vor oder nach der Token-Verifikation) und ob ein dritter Eimer nach
`CF-Connecting-IP` dazukommt. Danach `tests/worker/gateway.test.ts` erweitern.

**Hängt ab von:** Nichts.

---
