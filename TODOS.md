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
