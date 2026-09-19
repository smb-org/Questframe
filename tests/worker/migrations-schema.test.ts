import { describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { readSchemaSnapshot, withHistoricalDatabase } from "./migrations-harness";

/**
 * Der Schema-Wächter für Track P.
 *
 * `runMigrations` wird mit P3 von einer imperativen Funktion in eine
 * deklarative Liste umgebaut. Dabei darf sich das erzeugte Schema um kein
 * Byte ändern. Dieser Test friert den Stand vor dem Umbau ein und vergleicht
 * jeden weiteren Lauf dagegen.
 *
 * Der Vergleich läuft über `readSchemaSnapshot`, das Whitespace und die von
 * SQLite gesetzten Identifier-Anführungszeichen normalisiert — verglichen
 * wird die semantische DDL-Form, nicht ihre zufällige Darstellung.
 *
 * Wenn dieser Test rot wird, ist das die richtige Reaktion: prüfen, ob die
 * Schemaänderung gewollt ist. Ist sie es (eine neue Migration), dann den
 * Snapshot bewusst mit `vitest -u` erneuern und den Diff im Commit zeigen.
 * Nie blind erneuern.
 */
describe("Migrations-Schema", () => {
  it("erzeugt aus einer leeren Datenbank das eingefrorene Schema", async () => {
    const snapshot = await withHistoricalDatabase(0, (sql) => {
      runMigrations(sql, "schema-guard");
      return readSchemaSnapshot(sql);
    });

    await expect(JSON.stringify(snapshot, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/migrations-schema.json",
    );
  });

  it("ist idempotent: ein zweiter Lauf ändert das Schema nicht", async () => {
    const { first, second } = await withHistoricalDatabase(0, (sql) => {
      runMigrations(sql, "schema-guard-1");
      const first = readSchemaSnapshot(sql);
      runMigrations(sql, "schema-guard-2");
      return { first, second: readSchemaSnapshot(sql) };
    });

    expect(second).toStrictEqual(first);
  });
});
