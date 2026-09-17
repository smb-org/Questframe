# Track P — Plattform: die Modul-Registry

Fortsetzung von `roadmap-modul-registry-und-challenge-typen.md`. Track N ist
geliefert (T1 bis T18, 24 Commits auf `feat/challenge-typen-und-registry`),
P1 ebenfalls (T9: Registry-Vertrag ohne `handle()`). Dieses Dokument plant
P2 bis P7 und ist noch nicht reviewt.

## Was sich seit dem Roadmap-Doc geändert hat

Am 2026-09-17 sind die vier Plattformfragen entschieden (Open Questions 5
bis 8 im Roadmap-Doc). Drei davon verschieben den Plan:

**Ein drittes Modul ist konkret geplant.** Damit ist Track P keine
Aufräumarbeit. P2, P5 und P6 müssen HTTP-Fassade, Socket-Maschinerie und
HUD-Slice modulneutral machen, *bevor* Modul 3 kommt — sonst zahlt Modul 3
den Preis, und zwar unter Zeitdruck.

**Undo und Audit-Log gehören der Plattform.** Der alte Plan ließ das offen
und schlug im Zweifel vor, beide beim HUD zu lassen. Diese Entscheidung ist
gefallen und kostet einen eigenen Schritt, der im alten Plan nicht als
eigener Punkt stand: **P6a**, unten.

**Der Deploy bleibt ein Worker.** P7 ist damit Buchhaltung innerhalb eines
gemeinsamen Budgets, keine Trennlinie. Das globale Overlay-Gate bleibt die
harte Grenze; `budgetKeys` schreibt nur fest, wer welchen Anteil verantwortet.

Die vierte Entscheidung (`themeMode: "inherit"` entfällt) läuft außerhalb von
Track P und entkoppelt das Challenge-Modul bereits vom HUD-Theme.

## Reihenfolge und Begründung

```
P2 ──► P3 ──► P4 ──► P5 ──► P6a ──► P6 ──► P7
Fassade Runner Namesp. Sockets Undo   HUD   Budgets
```

Nicht verhandelbar ist nur `P3 ──► P4`: Namespaces in einen imperativen
Runner einzuziehen bedeutet, jeden handgeschriebenen Wächter einzeln
anzufassen. Deklarativ ist es eine Spalte im Eintrag.

`P6a ──► P6` ist ebenfalls fest: das HUD kann erst wandern, wenn Undo und
Audit nicht mehr an ihm hängen. Sonst wandern sie mit und müssen später
zurückgeholt werden.

P2 steht vorn, weil es der kleinste Schritt mit dem größten Signal ist: wenn
die Challenge-Fassade nicht sauber durch den Vertrag passt, stimmt der
Vertrag nicht, und das will man vor P5 wissen, nicht danach.

## P6a — Undo und Audit in den Host heben

Der neue Schritt. Er ist nicht groß im Diff, aber er hat eine Modellfrage,
die der alte Plan nicht gestellt hat.

**Der Befund.** `state_history` speichert `snapshot_json` — einen
vollständigen Snapshot des HUD-`ChannelState`. Der Schlüssel ist `revision`,
also die HUD-Revision (`channel-object.ts:926`, `:1214`). Das Undo ist
snapshot-basiert, nicht kommando-basiert. Die Challenges haben aber keine
`revision`; sie haben `boardRevision`, `settingsRevision` und `event_seq`,
drei Zähler auf `wc_meta`.

Ein kanalweiter Undo-Stack braucht deshalb eine eigene Achse. Ein
Modul-Snapshot allein reicht nicht, weil „das Letzte rückgängig machen" über
Modulgrenzen hinweg eine Ordnung voraussetzt, die heute nirgends existiert.

**Vorschlag.** Eine Host-Sequenz `channel_seq`, die bei jeder undo-fähigen
Mutation jedes Moduls um eins steigt. `state_history` bekommt
`module_id` und `channel_seq`; `snapshot_json` bleibt, wird aber vom Modul
erzeugt und vom Modul wieder eingespielt. Der Vertrag aus P1 wächst um zwei
Funktionen:

```ts
snapshot(ctx): string;                 // Modulzustand serialisieren
restore(ctx, snapshot: string): void;  // und zurückschreiben
```

Der Host besitzt Tabelle, Sequenz, Pruning und die Undo-Route. Das Modul
besitzt den Inhalt des Snapshots und weiß als einziges, was er bedeutet.

**Der Hebel, der das billig macht:** Undo ist noch gar nicht freigeschaltet.
`channel-object.ts:911` lehnt jede Undo-Anfrage mit 403 ab, solange
`getReleaseCapabilities(env.RELEASE_STAGE).undo` falsch ist. Der Umbau trifft
also keinen Nutzer. Das ist das Zeitfenster, in dem diese Entscheidung ohne
Migrationsschmerz umsetzbar ist — nach der Freischaltung wäre sie teuer.

**Check:** ein Test, der eine HUD-Mutation und eine Challenge-Mutation
verschränkt, zweimal undo fährt und prüft, dass beide Module in der richtigen
Reihenfolge zurückgehen — und dass `channel_seq` nach einem Undo weiterzählt
statt zurückzuspringen.

**Offen, für das Review:** ob ein Undo über eine Modulgrenze hinweg
überhaupt erwünscht ist, oder ob der Stack zwar zentral geführt, aber pro
Modul gefiltert bedient wird. Die zentrale Führung ist in beiden Fällen
richtig; nur die Bedienoberfläche unterscheidet sich.

## P2 bis P7

Unverändert gegenüber `roadmap-modul-registry-und-challenge-typen.md`,
Abschnitt „Track P", mit diesen Ergänzungen:

- **P2** — der Vertrag bekommt `handle()`, das P1 bewusst ausgelassen hat.
  Die Repository-Factory muss von
  `Omit<SqlStorageChallengeRepositoryOptions, "tablePrefix">` geöffnet werden.
- **P4** — bleibt der riskanteste Schritt. Vorher einen Snapshot der
  Produktions-DO-Storage ziehen. Läuft gegen laufende Streams.
- **P6** — `undo`, `insertHistory`, `getUndoTargets`, `pruneHistoryAndAudit`
  wandern **nicht** mit ins HUD-Modul; sie bleiben nach P6a beim Host. Es
  wandern nur `ChannelState`, `readState`/`writeState` und die
  HUD-Snapshot-Erzeugung.
- **P7** — Buchhaltung, keine Trennlinie. Der Selbsttest aus P1 prüft, dass
  kein Budget herrenlos ist; das Overlay-Gate bleibt als Summenprüfung.

## Risiken

**P4 gegen laufende Streams.** Der Backfill schreibt den globalen
Migrationszähler in drei Namespaces um und berührt jede Migration, die es je
gab. Ein Fehler hier ist nicht rückrollbar, weil die DO-Storage dem Kanal
gehört und kein Backup-Knopf existiert. Snapshot vorher ist Pflicht, kein
Vorschlag.

**P5 ist unterschätzt worden, schon einmal.** 31 tag-spezifische Stellen in
`channel-object.ts` (2252 Zeilen). Der Plan nennt sie, aber die Zahl ist aus
einer Zählung, nicht aus einem Durchstich. Vor der Umsetzung einen
Fantasie-Modul-Test schreiben und *daran* messen, was fehlt.

**P6a hat eine Modellfrage, keine Implementierungsfrage.** Wenn das Review
die Achse anders schneidet, ändert sich P6 mit. Deshalb steht P6a vor P6 und
nicht daneben.

## Nicht in Scope

- Ein drittes Modul selbst. Track P macht nur Platz dafür.
- Getrennte Deploys. Entschieden: ein Worker.
- Chat-Ingress, EventSub, Predictions, Auto-Clip.
