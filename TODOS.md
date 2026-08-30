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
Im Design-Doc steht der Befund unter "Reviewer Concerns".

**Wo anfangen:** `time_sync` in den Exact-Key-Parser in `wire.ts` aufnehmen, beim
Verbinden ein `time_sync_request` senden (das Schema existiert bereits in
`src/shared/contracts/api.ts` als `clientMessageSchema`), den Offset im Overlay halten und
statt `Date.now()` eine korrigierte Zeitquelle verwenden. Danach das Bundle-Gate messen.

**Hängt ab von:** Nichts. Kann unabhängig gebaut werden, auch vor dem Challenge-Modul.

---

## Visuelle Ausarbeitung des `quest-log`-Styles

**Was:** Die gestalterische Richtung für den `quest-log`-Style des Win-Challenges-Moduls:
Rahmenform, Materialbehandlung, Zustandsübergänge des Objective-Texts, das Aufblitzen beim
Hochzählen, der Abschluss-Sound.

**Warum:** `docs/designs/win-challenges-module.md` legt Aufbau, Token-Vertrag, Zustände und
Barrierefreiheit vollständig fest. Wie der `quest-log`-Style konkret aussieht, ist als
einziges offen. Schritt 13 der Umsetzung sagt nur "mit eigenen Assets und eigenem Sound".
Der `quest-log` ist zugleich der Style, wegen dem das Feature überhaupt existiert: Er lebt
davon, dass ein Zuschauer die visuelle Sprache sofort wiedererkennt.

**Pros:** Die drei `plain-*`-Styles sind durch Tokens und Struktur vollständig beschrieben
und sofort baubar. Nur dieser eine Style hängt, und er kommt ohnehin zuletzt.

**Cons:** Der gstack-Designer war beim Review nicht nutzbar (kein OpenAI-Key hinterlegt).
Ohne ihn entsteht die Gestaltung von Hand und dauert deutlich länger.

**Kontext:** Aufgefallen im `/plan-design-review` am 2026-08-30. Das vorhandene Wireframe
unter `~/.gstack/projects/twitchBrudi/designs/challenge-log-20260830/placement-wireframe.html`
ist eine **Platzierungsstudie**, keine Gestaltung: Es beantwortet, wo das Log auf der
OBS-Fläche lebt, nicht wie es aussieht.

Die Urheberrechtsgrenze steht bereits fest und ist nicht verhandelbar: die visuelle Sprache
treffen, niemals Assets, Namen, Schriften oder Audio aus einem bestehenden Spiel kopieren.
Gold auf dunklem Pergament, eckige Rahmen, serifenbetonte Versalien, ein aufsteigender
Zweiklang beim Abschluss. Der Sound kann per muapi generiert werden.

**Wo anfangen:** `$D setup` mit einem OpenAI-Key, danach `/design-shotgun` für den einen
Style. Alternativ eine Handrunde gegen die `--wc-*`-Tokens aus dem Design-Doc.

**Hängt ab von:** OpenAI-Key für den gstack-Designer. Blockiert Schritt 13 der Umsetzung,
sonst nichts.
