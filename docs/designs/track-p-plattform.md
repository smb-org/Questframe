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

**Entschieden am 2026-09-18, P2 ist geliefert.** P2 hängt über die beiden
Dock-Token-Routen an P5 (Befund 3 unten). Gewählt wurde die erste Variante:
acht der zehn Routen sind gewandert, die Dock-Token-Routen bleiben bis P5
beim Host. Der Vertrag drückt das aus, weil `handle()` `null` zurückgeben
darf — „nicht zuständig, Host macht weiter".

Geliefert in `0fb2ae0`: `src/modules/win-challenges/adapters/http-facade.ts`,
`ModuleContext` mit sieben Host-Diensten, `channel-object.ts` 112 Zeilen
leichter. Zwei Befunde aus der Nachprüfung stecken mit drin: `ModuleId` war
auf eine handgepflegte Union gefallen (jetzt wieder aus der Registry
abgeleitet, weil `as const` optionale Member wegkürzt — deshalb trennen
Ableitungsquelle und Zugriffssicht), und der Set-Helfer hieß
`requireSetSession`, ohne eine Session zu prüfen (jetzt `rejectDockToken`).

**P3 ist geliefert** (`0baa3c9`). `runMigrations` läuft über eine Liste aus
29 Einträgen `{version, guard?, statements|run}`, 23 davon mit Wächter; die
Datei verliert 129 Zeilen netto. Abgesichert durch einen Schema-Wächter
(`0627929`), der vor dem Umbau 21 Schemaobjekte als Fixture eingefroren hat
und nachweislich anschlägt — der Umbau ließ das Schema byteidentisch.

Ein Riss wurde beim Nachprüfen geschlossen: die erste Fassung ließ den Runner
`version === 17` literal kennen und fünf Statements positionell
destrukturieren. Der Eintragstyp trägt jetzt entweder `statements` oder eine
eigene `run`-Funktion, damit ist der Sonderfall strukturell weg.

**Erster echter Deploy am 2026-09-18.** Bis dahin waren 33 Commits und fünf
Migrationen nie gegen eine Umgebung gelaufen. Auf Staging ist das jetzt
nachgeholt: Deploy durch, Durable Object geweckt, Migration 17 bis 20 und der
neue Runner sind fehlerfrei im DO-Konstruktor gelaufen (`channel-object.ts:217`).
Beweis: Anfragen an die DO-Routen antworten stabil mit `401` aus
`requireSession` statt mit `500` — ein Wurf im Konstruktor würde jeden Request
killen.

Nicht verifiziert ist damit die *Datenkorrektheit* des Backfills (vergebene
Steuer-Keys, umgestellte `theme_mode`-Werte). Dafür braucht es eine
angemeldete Sitzung auf Staging.

**Was das für P4 und P6a ändert:** beide brauchen laut Risikoabschnitt einen
Storage-Snapshot, bevor sie gegen Produktionsdaten laufen. Mit einer
bespielten Staging-Umgebung gibt es jetzt einen Ort, an dem der Backfill
vorher geübt werden kann. Das ersetzt den Snapshot nicht, senkt aber die
Wahrscheinlichkeit, ihn zu brauchen.

**Track P ist geliefert.** Stand 2026-09-19, 42 Commits auf dem Branch:

| Schritt | Ergebnis |
|---|---|
| P1 | Registry-Vertrag, `ModuleId` aus der Registry abgeleitet |
| P2 | zehn Challenge-Routen in `adapters/http-facade.ts`; `handle()` mit `null` als „Host macht weiter" |
| P3 | `runMigrations` deklarativ, 29 Einträge; Schema byteidentisch |
| P4 | Migrations-Namespaces `host`/`hud`/`challenges`, Backfill des Altbestands |
| P5 | kein Socket-Tag-Literal mehr in `channel-object.ts`; Tags, Limit-Schlüssel und Protokolle aus der Registry |
| P6a | `state_history` modulfähig, Undo pro Modul mit je 20 Einträgen, `snapshot`/`restore` am Vertrag |
| P6 | HUD als zweites Modul; `channel-object.ts` von 2163 auf 1809 Zeilen |
| P7 | jedes Budget-Label hat einen Besitzer, gegen die echte Deklarationsquelle geprüft |

**Was dabei anders kam als geplant.** P5 war kleiner: `activeSocketCount`,
`reclaimSocketSlots` und `revokeTokenSockets` nahmen `tag` längst als
Parameter, es fehlte nur der abgeleitete Typ. Die Socket-Limits konnten
*nicht* in die Registry wandern — sie stehen in `shared/contracts/api.ts`,
gehen über das `limits`-Objekt im Bootstrap raus und werden mit
Zod-Literal-Unions validiert; die Registry nennt seither den Schlüssel, nie
den Wert. P6a wurde dagegen teurer als gedacht, weil Undo in allen
Umgebungen aktiv ist und der Backfill echte Daten anfasst.

**Drei Wächter sichern das Ergebnis**, jeder mit Negativtest als scharf
nachgewiesen: das eingefrorene Migrationsschema, das Verbot von
Socket-Tag-Literalen in `channel-object.ts`, und die Pflicht zum
Namespace-Filter in jeder Ledger-Abfrage der Migrationstests. Der letzte
entstand aus einem Befund: 24 Abfragen waren namespace-blind und nur zufällig
grün.

**Zweiter Staging-Deploy am 2026-09-19.** Diesmal lief der riskante Teil: die
Staging-Datenbank stand auf dem alten globalen Ledger, also ist der
P4-Namespace-Backfill dort zum ersten Mal gegen echte Daten gelaufen,
zusammen mit dem `state_history`-Umbau. Beides fehlerfrei — die DO-Routen
antworten stabil mit `401` statt `500`, und die drei HUD-Routen
(`PUT /state`, `POST /overlay-visibility`, `POST /state/undo`) sind nach der
Modulextraktion erreichbar geblieben.

**Was bewusst offen bleibt:**
- `HUD_MODULE_ID` steht an zehn Stellen im Host, unter anderem im Bootstrap.
  „HUD als Modul" ist weiter als vorher, aber nicht modulneutral.
- Der Begrüßungs-Snapshot beim Token-Socket ist noch fest der
  Challenge-Snapshot. Ein drittes Modul mit eigenem Socket bräuchte ihn von
  der Socket-Definition, so wie `handle()` die Routen liefert.
- Die Datenkorrektheit der Backfills auf Staging ist nicht verifiziert; dafür
  braucht es eine angemeldete Sitzung.

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

**Korrektur vom 2026-09-17.** Eine frühere Fassung dieses Abschnitts nannte
als Hebel, Undo sei noch gar nicht freigeschaltet, der Umbau treffe also
keinen Nutzer. Das ist falsch. `channel-object.ts:911` sperrt Undo nur bei
`RELEASE_STAGE === "v1a"` (`state.ts:314–330`), und `wrangler.jsonc` setzt in
**allen drei** Umgebungen `"RELEASE_STAGE": "v1b"` (Zeilen 49, 114, 174).
Undo ist überall an.

**Was das für P6a bedeutet.** Es gibt produktive `state_history`-Zeilen, und
Nutzer können sie heute über die Undo-Route erreichen. Der Umbau ist damit
eine echte Datenmigration, kein freies Zeitfenster:

- Bestandszeilen brauchen `module_id = 'hud'` als Backfill.
- `channel_seq` muss für Bestandszeilen aus der vorhandenen `revision`-
  Ordnung abgeleitet werden, monoton und lückenlos genug, dass die
  Undo-Reihenfolge erhalten bleibt.
- Die Undo-Route darf während der Migration nicht in einen Zwischenzustand
  greifen. Da Migrationen im DO synchron laufen, ist das gegeben — aber nur,
  solange der Backfill ohne `await` auskommt und ohne CASE-Konstrukt, das
  mit der Zeilenzahl wächst (100-Parameter-Grenze).

Damit ist P6a teurer als beim Schreiben angenommen und rückt in der
Risikobewertung neben P4, statt darunter.

**Check:** ein Test, der eine HUD-Mutation und eine Challenge-Mutation
verschränkt, zweimal undo fährt und prüft, dass beide Module in der richtigen
Reihenfolge zurückgehen — und dass `channel_seq` nach einem Undo weiterzählt
statt zurückzuspringen.

### Befunde aus der Code-Prüfung (2026-09-17)

Drei Dinge, die der Entwurf oben nicht hatte. Alle am Code nachgeprüft.

**1. `deleteCollectibleMedia` blockiert eine modulneutrale `state_history`.**
`channel-object.ts:1797–1801` liest *jede* Zeile der Tabelle und parst sie mit
`channelStateSchema.parse(...)`, um referenzierte Portrait-Hashes vor dem
Löschen zu schützen. Sobald ein Challenge-Snapshot in derselben Tabelle liegt,
wirft dieser Parse. Der Fehler schlägt nicht beim Undo auf, sondern im
Medien-Aufräumpfad beim Portrait-Upload — also weit weg von der Ursache.

P6a muss diese Schleife also mitnehmen: entweder auf `module_id = 'hud'`
filtern, oder das Hash-Schützen über eine Modulfunktion abfragen statt über
ein hartes Schema. Der Filter ist die kleinere Änderung und reicht, solange
nur das HUD Medien referenziert.

**2. Die Undo-Tiefe ist 20 Zeilen, kanalweit.**
`pruneHistoryAndAudit` (`channel-object.ts:1755–1758`) hält
`ORDER BY revision DESC LIMIT 20`. Teilen sich zwei Module diese Tabelle,
teilen sie sich die zwanzig Plätze: eine Serie von Challenge-Klicks drückt die
HUD-Historie heraus. Das Limit muss damit pro Modul gelten, nicht pro Tabelle
— oder deutlich steigen. Entscheidung gehört ins Review, nicht in die
Umsetzung.

Nebenbefund: `uploadMedia` (`channel-object.ts:1205–1221`) löscht bei
Platzmangel gezielt die *älteste* History-Zeile. Auch dieser Pfad braucht
nach P6a einen Modulbezug, sonst opfert ein Portrait-Upload fremde Historie.

**3. P2 ist nicht rein delegierend — und hängt an P5.**
Der Entwurf oben sagt „Diff klein, der Code delegiert bereits". Das gilt für
acht der zehn Challenge-Routen. Nicht für `mutateDockToken`
(`channel-object.ts:1102–1168`, die Routen `/challenges/dock-token` und
`…/rotate`): die Methode gleicht Idempotenz über `requestId`/`generation` ab,
mutiert Token-Zustand direkt und ruft bei Rotation
`revokeTokenSockets("dock", …)`. `revokeTokenSockets` wiederum ist mit
`overlay` und `composite` geteilt und damit nicht isoliert verschiebbar.

**Folge für die Reihenfolge:** P2 kann nicht vollständig vor P5 fertig werden.
Entweder P2 liefert acht Routen und lässt die beiden Dock-Token-Routen bis
nach P5 beim Host, oder P5 rückt vor P2. Der Entwurf oben behauptet eine
Unabhängigkeit, die nicht besteht.

**Bestätigt, keine Änderung nötig:**
- `state_history.revision` ist `PRIMARY KEY` und identisch mit
  `channel_state.revision`; `snapshot_json` ist `JSON.stringify(ChannelState)`
  (`migrations.ts:18–23`, `channel-object.ts:1681–1689`).
- Die Zahl 31 für die tag-spezifischen Stellen stimmt. Präzisierung: 15 Zeilen
  mit `"challenge"`, 21 mit `"dock"`, 5 mit beiden. `webSocketMessage` und
  `webSocketClose` gehören *nicht* dazu — sie reichen `tag` und
  `attachment.kind` generisch durch. Der Entwurf oben zählt sie fälschlich mit.
- `channel_seq` wäre nicht doppelt. Es gibt heute keinen Zähler, der über
  Modulgrenzen monoton ist: `revision` gehört dem HUD, `board_revision`,
  `settings_revision` und `event_seq` liegen auf `wc_meta` und sind
  modullokal.
- `RELEASE_STAGE` wird nirgends zur Laufzeit überschrieben; der Wert kommt
  ausschließlich aus `wrangler.jsonc`. Die Korrektur oben steht.

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

**P6a hat eine Modellfrage und eine Datenfrage.** Die Modellfrage: wenn das
Review die Achse anders schneidet, ändert sich P6 mit — deshalb steht P6a vor
P6 und nicht daneben. Die Datenfrage kam durch die Korrektur oben dazu: Undo
ist in allen Umgebungen aktiv, der Backfill von `state_history` läuft gegen
Daten, die Nutzer erreichen können. P6a und P4 sind damit die beiden
Schritte, die einen Storage-Snapshot vorher brauchen.

## Nicht in Scope

- Ein drittes Modul selbst. Track P macht nur Platz dafür.
- Getrennte Deploys. Entschieden: ein Worker.
- Chat-Ingress, EventSub, Predictions, Auto-Clip.
